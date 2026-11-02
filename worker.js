/* Saltshot Seas multiplayer server: a Cloudflare Worker with one Durable Object per room.
 *
 * Players connect with a WebSocket to   wss://<your-worker>.workers.dev/room/<CODE>?mode=coop|arena&create=1&name=...&v=52
 * The first player creates the room (create=1) and becomes its host; friends join with the same four-letter code.
 * The server only relays: every message a player sends ({"to":0,...} for everyone, {"to":<id>,...} for one player)
 * is passed on with "from" set to the sender's id. The game itself runs on the players' phones; the host's phone runs
 * the shared sea in co-op, and the round clock in the arena.
 *
 * Messages from the server: hello (your id, the host, who is here), join, leave, host (the host changed), err.
 * It uses the WebSocket Hibernation API, so a quiet room costs nothing, and SQLite-backed Durable Objects, which the
 * Workers Free plan includes.
 */

const MAX = { coop: 4, arena: 8 };
const ROOM_RE = /^\/room\/([A-Z]{4})$/;
const MAX_MSG = 48 * 1024;     // bytes
const RATE = 40;               // messages per second per player before the extras are dropped
const RESERVED = new Set(['hello', 'join', 'leave', 'host', 'err']); // only the server sends these

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/' || url.pathname === '') {
      return new Response('Saltshot Seas server is running. Put this address into the game: ' + url.origin, {
        headers: { 'content-type': 'text/plain; charset=utf-8', 'access-control-allow-origin': '*' },
      });
    }
    const m = url.pathname.match(ROOM_RE);
    if (!m) return new Response('Not found', { status: 404 });
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket', { status: 426 });
    const stub = env.ROOMS.get(env.ROOMS.idFromName(m[1]));
    return stub.fetch(req);
  },
};

export class Room {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.rate = new Map(); // id -> { t, n }
    // a client's "ping" gets "pong" without waking the room
    try { ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong')); } catch (e) { /* older runtime */ }
  }

  players() { // who is here: rebuilt from the sockets' attachments, so it survives hibernation
    const out = [];
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment();
      if (a && !a.gone) out.push({ ws, a });
    }
    return out;
  }

  async fetch(req) {
    const url = new URL(req.url), q = url.searchParams;
    const mode = q.get('mode') === 'arena' ? 'arena' : 'coop';
    const create = q.get('create') === '1';
    const v = String(q.get('v') || '').slice(0, 12);
    const name = cleanName(q.get('name')) || 'Captain';
    const code = (url.pathname.match(ROOM_RE) || [])[1] || '';

    const pair = new WebSocketPair();
    const client = pair[0], server = pair[1];
    const here = this.players();
    const refuse = (codeErr, msg) => {
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ gone: true });
      server.send(JSON.stringify({ t: 'err', code: codeErr, msg }));
      server.close(4000, codeErr);
      return new Response(null, { status: 101, webSocket: client });
    };
    if (create && here.length) return refuse('taken', 'That room code is in use.');
    if (!create && !here.length) return refuse('noroom', 'No room with that code. Check it, or ask your friend to open the room again.');
    if (here.length) {
      const first = here[0].a;
      if (first.mode !== mode) return refuse('mode', first.mode === 'arena' ? 'That code is a battle arena, not a co-op voyage.' : 'That code is a co-op voyage, not a battle arena.');
      if (first.v !== v) return refuse('version', 'Your game and the host\'s game are different versions. Update the game on both phones.');
      if (here.length >= MAX[mode]) return refuse('full', `That room is full (${MAX[mode]} captains).`);
    }

    const id = here.reduce((m, p) => Math.max(m, p.a.id), 0) + 1;
    const host = here.length ? (here.find(p => p.a.host) || here[0]).a.id : id;
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ id, name, mode, v, code, host: id === host, joined: Date.now() });
    server.send(JSON.stringify({ t: 'hello', id, host, mode, code, players: here.map(p => ({ id: p.a.id, name: p.a.name })).concat([{ id, name }]) }));
    this.broadcast({ t: 'join', id, name }, id);
    return new Response(null, { status: 101, webSocket: client });
  }

  broadcast(obj, except) {
    const s = JSON.stringify(obj);
    for (const p of this.players()) if (p.a.id !== except) { try { p.ws.send(s); } catch (e) { /* closing */ } }
  }

  webSocketMessage(ws, data) {
    const a = ws.deserializeAttachment();
    if (!a || a.gone) return;
    if (typeof data !== 'string' || data.length > MAX_MSG) return;
    if (data === 'ping') { try { ws.send('pong'); } catch (e) { /* closing */ } return; }
    const now = Date.now(), r = this.rate.get(a.id) || { t: now, n: 0 };
    if (now - r.t >= 1000) { r.t = now; r.n = 0; }
    if (++r.n > RATE) { this.rate.set(a.id, r); return; }
    this.rate.set(a.id, r);
    let msg;
    try { msg = JSON.parse(data); } catch (e) { return; }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || RESERVED.has(msg.t)) return;
    const to = msg.to | 0;
    delete msg.to;
    msg.from = a.id;
    const out = JSON.stringify(msg);
    for (const p of this.players()) {
      if (p.a.id === a.id) continue;
      if (to && p.a.id !== to) continue;
      try { p.ws.send(out); } catch (e) { /* closing */ }
    }
  }

  webSocketClose(ws, code, reason) { this.leave(ws); try { ws.close(1000, 'bye'); } catch (e) { /* already closed */ } }
  webSocketError(ws) { this.leave(ws); }

  leave(ws) {
    const a = ws.deserializeAttachment();
    if (!a || a.gone) return;
    ws.serializeAttachment({ gone: true });
    this.rate.delete(a.id);
    const rest = this.players();
    this.broadcast({ t: 'leave', id: a.id }, a.id);
    if (a.host && rest.length) { // the longest-serving captain takes over as host
      const next = rest.reduce((b, p) => (p.a.id < b.a.id ? p : b), rest[0]);
      for (const p of rest) { const x = p.a; x.host = p === next; p.ws.serializeAttachment(x); }
      this.broadcast({ t: 'host', id: next.a.id });
    }
  }
}

function cleanName(v) {
  return [...String(v || '').normalize('NFC').replace(/[^\p{L}\p{M}\p{N} '’-]/gu, '').replace(/\s+/g, ' ').trim()].slice(0, 18).join('').trim();
}
