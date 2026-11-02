// Runs worker.js on this computer for testing, without Cloudflare: a tiny HTTP + WebSocket server (no packages
// needed) with stand-ins for the Workers runtime pieces the server uses (WebSocketPair, Durable Object state and
// hibernation attachments). Usage: node local-server.mjs [port]   then point the game at ws://localhost:<port>
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const PORT = +(process.argv[2] || 8787);
const LOG = process.env.MPLOG === '1';

// ---- stand-ins for the Workers runtime
class FakeResponse {
  constructor(body, init = {}) { this.body = body; this.status = init.status ?? 200; this.headers = init.headers || {}; this.webSocket = init.webSocket || null; }
}
globalThis.Response = FakeResponse;
globalThis.WebSocketRequestResponsePair = class { constructor(a, b) { this.request = a; this.response = b; } };
let bindSocket = null; // the raw socket the next WebSocketPair's server end talks to
class ServerEnd {
  constructor(sock) { this.sock = sock; this.att = null; this.closed = false; this.room = null; }
  send(s) { if (!this.closed) writeFrame(this.sock, 1, Buffer.from(String(s))); }
  close(code = 1000, reason = '') {
    if (this.closed) return; this.closed = true;
    const b = Buffer.alloc(2 + Buffer.byteLength(reason)); b.writeUInt16BE(code, 0); b.write(reason, 2);
    try { writeFrame(this.sock, 8, b); this.sock.end(); } catch (e) { /* gone */ }
  }
  serializeAttachment(a) { this.att = JSON.parse(JSON.stringify(a)); }
  deserializeAttachment() { return this.att ? JSON.parse(JSON.stringify(this.att)) : null; }
}
globalThis.WebSocketPair = class { constructor() { this[0] = { client: true }; this[1] = new ServerEnd(bindSocket); } };

const { default: worker, Room } = await import(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'worker.js'));
const rooms = new Map();
function roomFor(name) {
  if (rooms.has(name)) return rooms.get(name);
  const sockets = [];
  const ctx = {
    getWebSockets: () => sockets.filter(s => !s.closed),
    acceptWebSocket: ws => { ws.room = r; sockets.push(ws); },
    setWebSocketAutoResponse: () => {},
  };
  const r = new Room(ctx, {}); r._sockets = sockets;
  rooms.set(name, r); return r;
}
const env = { ROOMS: { idFromName: n => n, get: id => ({ fetch: req => roomFor(id).fetch(req) }) } };

// ---- WebSocket framing (RFC 6455, server side)
function writeFrame(sock, op, payload) {
  const n = payload.length; let head;
  if (n < 126) { head = Buffer.alloc(2); head[1] = n; }
  else if (n < 65536) { head = Buffer.alloc(4); head[1] = 126; head.writeUInt16BE(n, 2); }
  else { head = Buffer.alloc(10); head[1] = 127; head.writeBigUInt64BE(BigInt(n), 2); }
  head[0] = 0x80 | op; sock.write(Buffer.concat([head, payload]));
}
function attach(sock, end) {
  let buf = Buffer.alloc(0), frag = null;
  const gone = () => { if (end.closed && end.reported) return; end.reported = true; const was = end.closed; end.closed = true; if (end.room) { try { end.room.webSocketClose(end, 1006, '', false); } catch (e) { console.error(e); } } };
  sock.on('data', d => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      if (buf.length < 2) return;
      const fin = buf[0] & 0x80, op = buf[0] & 15, masked = buf[1] & 0x80; let n = buf[1] & 127, o = 2;
      if (n === 126) { if (buf.length < 4) return; n = buf.readUInt16BE(2); o = 4; }
      else if (n === 127) { if (buf.length < 10) return; n = Number(buf.readBigUInt64BE(2)); o = 10; }
      const mk = masked ? buf.slice(o, o + 4) : null; if (masked) o += 4;
      if (buf.length < o + n) return;
      let p = buf.slice(o, o + n); buf = buf.slice(o + n);
      if (mk) { p = Buffer.from(p); for (let i = 0; i < p.length; i++) p[i] ^= mk[i & 3]; }
      if (op === 8) { const code = p.length >= 2 ? p.readUInt16BE(0) : 1005; if (!end.closed) { try { writeFrame(sock, 8, p.slice(0, 2)); } catch (e) {} } end.closed = true; end.reported = true; if (end.room) end.room.webSocketClose(end, code, '', true); sock.end(); return; }
      if (op === 9) { writeFrame(sock, 10, p); continue; }
      if (op === 10) continue;
      if (op === 0 && frag) { frag.push(p); if (fin) { const all = Buffer.concat(frag); frag = null; deliver(all); } continue; }
      if (op === 1) { if (!fin) { frag = [p]; continue; } deliver(p); }
    }
  });
  const deliver = p => { const s = p.toString('utf8'); if (LOG) console.log('<', s.slice(0, 160)); if (end.room && !end.closed) { try { end.room.webSocketMessage(end, s); } catch (e) { console.error(e); } } };
  sock.on('close', gone); sock.on('error', gone);
}

const server = http.createServer(async (req, res) => {
  const r = await worker.fetch(new Request('http://localhost:' + PORT + req.url, { headers: req.headers }), env);
  res.writeHead(r.status, Object.assign({ 'access-control-allow-origin': '*' }, r.headers)); res.end(r.body == null ? '' : String(r.body));
});
server.on('upgrade', async (req, sock) => {
  const key = req.headers['sec-websocket-key'];
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  sock.setNoDelay(true);
  bindSocket = sock;
  const r = await worker.fetch(new Request('http://localhost:' + PORT + req.url, { headers: { upgrade: 'websocket' } }), env);
  bindSocket = null;
  if (r.status !== 101 || !r.webSocket) { sock.end(); return; }
  // the server end created inside the room's fetch is the one the room accepted for this socket
  const room = [...rooms.values()].find(x => x._sockets.some(s => s.sock === sock));
  const end = room && room._sockets.find(s => s.sock === sock);
  if (!end) { sock.end(); return; }
  attach(sock, end);
});
server.listen(PORT, () => console.log('Saltshot Seas test server on ws://localhost:' + PORT));
