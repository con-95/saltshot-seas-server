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
 *
 * Since game version 56 it also answers a small JSON API under /api, kept by one more Durable Object (Boards, below):
 * weekly event leaderboards, monthly arena leaderboards, fleets of up to 20 captains, and save codes that move a
 * career to another phone. Nobody can type text other players see: public names are numbers the game turns into
 * names from fixed word lists.
 */

const MAX = { coop: 4, arena: 8 };
const ROOM_RE = /^\/room\/([A-Z]{4})$/;
const MAX_MSG = 48 * 1024;     // bytes
const RATE = 40;               // messages per second per player before the extras are dropped
const RESERVED = new Set(['hello', 'join', 'leave', 'host', 'err']); // only the server sends these

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/api/')) { // leaderboards, fleets and save codes (version 56)
      if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
      const stub = env.BOARDS.get(env.BOARDS.idFromName('main'));
      return stub.fetch(req);
    }
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

/* ---------- Leaderboards, fleets and save codes (game version 56) ----------
 * One Durable Object ("main") with a small SQLite database:
 *   players (pid, key hash, name number, fleet code), scores (board, pid, score), fleets (code, name number, owner),
 *   saves (code, pid, the save as text, time).
 * A player id and secret key are made by the game and kept in its save; the first request with a new id registers it,
 * and every later one must carry the same key (only its SHA-256 is stored). Boards are "ev:<ISO week>" (event tokens,
 * which only go up within a week) and "ar:<YYYY-MM>" (arena rating); "fl:<ISO week>" is read-only, the members' event
 * scores added up per fleet. Old rows are cleared now and then: scores after 40 days, save codes after 30, empty
 * fleets after a week.
 */
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type' };
const ABC = 'BCDFGHJKLMNPQRSTVWXZ';
const ID_RE = /^[A-Z]{12}$/, KEY_RE = /^[A-Z]{24}$/, FLEET_RE = /^[A-Z]{5}$/, SAVE_RE = /^[A-Z]{10}$/;
const MAX_FLEET = 20, MAX_SAVE = 400 * 1024, MAX_BODY = 450 * 1024, DAY = 864e5;
const EV_RATE = 35, EV_STEP = 300, EV_FIRST = 3000; // event tokens: a minute's worth a player can plausibly earn (keen play is about 22), a little more per score, and a first score's limit
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: Object.assign({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, CORS) });
const fail = (err, msg, status = 400) => json({ err, msg }, status);
function isoWeek(ms) {
  const d = new Date(ms), mon = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - (d.getUTCDay() + 6) % 7);
  const th = new Date(mon + 3 * DAY), y = th.getUTCFullYear(), w = 1 + Math.floor((th - Date.UTC(y, 0, 1)) / (7 * DAY));
  return `${y}-W${String(w).padStart(2, '0')}`;
}
const monthId = ms => { const d = new Date(ms); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`; };
function boardOk(b, now) { // only this week's (or last week's) event board, and this month's (or last month's) arena board
  const m = /^(ev|ar|fl):(.+)$/.exec(b || ''); if (!m) return false;
  if (m[1] === 'ar') return m[2] === monthId(now) || m[2] === monthId(now - 3 * DAY);
  return m[2] === isoWeek(now) || m[2] === isoWeek(now - 2 * DAY);
}
async function sha(t) { const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t)); return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join(''); }
function code(n) { const a = new Uint8Array(n); crypto.getRandomValues(a); return [...a].map(x => ABC[x % ABC.length]).join(''); }
const int = (v, lo, hi) => { v = Math.round(+v); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo; };

export class Boards {
  constructor(ctx, env) {
    this.ctx = ctx; this.sql = ctx.storage.sql; this.rate = new Map();
    for (const q of [
      'CREATE TABLE IF NOT EXISTS players (pid TEXT PRIMARY KEY, kh TEXT NOT NULL, nm INTEGER NOT NULL DEFAULT 0, fleet TEXT, t INTEGER NOT NULL)',
      'CREATE TABLE IF NOT EXISTS scores (b TEXT NOT NULL, pid TEXT NOT NULL, s INTEGER NOT NULL, t INTEGER NOT NULL, PRIMARY KEY (b, pid))',
      'CREATE INDEX IF NOT EXISTS scores_rank ON scores (b, s)',
      'CREATE TABLE IF NOT EXISTS fleets (code TEXT PRIMARY KEY, nm INTEGER NOT NULL, owner TEXT NOT NULL, t INTEGER NOT NULL)',
      'CREATE INDEX IF NOT EXISTS players_fleet ON players (fleet)',
      'CREATE TABLE IF NOT EXISTS saves (code TEXT PRIMARY KEY, pid TEXT NOT NULL, data TEXT NOT NULL, t INTEGER NOT NULL)',
    ]) this.sql.exec(q);
  }
  rows(q, ...b) { return this.sql.exec(q, ...b).toArray(); }
  one(q, ...b) { return this.rows(q, ...b)[0] || null; }
  limited(k, gap) { // at most one request per `gap` ms for this key
    const now = Date.now(), t = this.rate.get(k) || 0;
    if (now - t < gap) return true;
    this.rate.set(k, now); if (this.rate.size > 5000) this.rate.clear();
    return false;
  }
  async who(body, ip) { // the player making the request; registers a new id (one a minute from any one address)
    const pid = String(body.pid || ''), key = String(body.key || '');
    if (!ID_RE.test(pid) || !KEY_RE.test(key)) return null;
    const kh = await sha(key), p = this.one('SELECT pid, kh, nm, fleet FROM players WHERE pid = ?', pid), now = Date.now();
    if (!p && ip !== 'local' && this.limited('r:' + ip, 60000)) return 'slow'; // ('local': the test server, which has no addresses)
    if (!p) { this.sql.exec('INSERT INTO players (pid, kh, nm, fleet, t) VALUES (?, ?, ?, NULL, ?)', pid, kh, int(body.nm, 0, 575), now); return { pid, nm: int(body.nm, 0, 575), fleet: null }; }
    if (p.kh !== kh) return null;
    if (body.nm !== undefined && int(body.nm, 0, 575) !== p.nm) { p.nm = int(body.nm, 0, 575); this.sql.exec('UPDATE players SET nm = ?, t = ? WHERE pid = ?', p.nm, now, pid); }
    return p;
  }
  tidy() { // now and then, clear what's old
    if (Math.random() > 0.02) return;
    const now = Date.now();
    this.sql.exec('DELETE FROM scores WHERE t < ?', now - 40 * DAY);
    this.sql.exec('DELETE FROM saves WHERE t < ?', now - 30 * DAY);
    this.sql.exec('DELETE FROM fleets WHERE t < ? AND code NOT IN (SELECT fleet FROM players WHERE fleet IS NOT NULL)', now - 7 * DAY);
    this.sql.exec('DELETE FROM players WHERE t < ? AND fleet IS NULL AND pid NOT IN (SELECT pid FROM scores) AND pid NOT IN (SELECT pid FROM saves)', now - 60 * DAY);
  }
  async fetch(req) {
    const url = new URL(req.url), path = url.pathname.slice(5), now = Date.now(), ip = req.headers.get('cf-connecting-ip') || 'local';
    try {
      if (req.method === 'GET') {
        if (this.limited('g:' + ip + ':' + path, 300)) return fail('slow', 'Too many requests. Try again in a moment.', 429);
        if (path === 'board') return this.board(url.searchParams.get('b'), url.searchParams.get('pid'), now);
        if (path === 'fleet') return this.fleet(url.searchParams.get('code'), url.searchParams.get('w'), url.searchParams.get('pid'), now);
        return fail('nope', 'Not found.', 404);
      }
      if (req.method !== 'POST') return fail('nope', 'Not found.', 404);
      const len = +(req.headers.get('content-length') || 0); // checked before reading, so a huge body is never held
      if (!len || len > MAX_BODY) return fail('big', 'That is too big to send.', 413);
      const text = await req.text(); if (text.length > MAX_BODY) return fail('big', 'That is too big to send.', 413);
      let body; try { body = JSON.parse(text); } catch (e) { return fail('json', 'Bad request.'); }
      if (!body || typeof body !== 'object') return fail('json', 'Bad request.');
      this.tidy();
      if (path === 'load') {
        if (this.limited('l:' + ip, 3000)) return fail('slow', 'Wait a few seconds before trying another code.', 429);
        const c = String(body.code || '').toUpperCase(); if (!SAVE_RE.test(c)) return fail('nosave', 'Save codes are ten letters.');
        const r = this.one('SELECT data, t FROM saves WHERE code = ?', c);
        if (!r || now - r.t > 30 * DAY) return fail('nosave', 'No career has that code. Codes last 30 days; check the letters.', 404);
        return json({ data: r.data });
      }
      const me = await this.who(body, ip); if (me === 'slow') return fail('slow', 'Too many new players from here. Try again in a minute.', 429);
      if (!me) return fail('auth', 'This phone could not be recognised by the server.', 403);
      if (path === 'score') {
        if (this.limited('s:' + me.pid + ':' + String(body.b).slice(0, 2), 8000)) return fail('slow', 'Too many scores at once.', 429);
        const b = String(body.b || ''); if (!boardOk(b, now) || b.startsWith('fl:')) return fail('board', 'That leaderboard is closed.');
        let sc = b.startsWith('ev:') ? int(body.s, 0, 200000) : int(body.s, 0, 5000);
        const old = this.one('SELECT s FROM scores WHERE b = ? AND pid = ?', b, me.pid);
        if (b.startsWith('ev:')) { // a week's tokens only go up, and no faster than a player could earn them
          const cap = old ? old.s + EV_STEP + (now - old.t) / 60000 * EV_RATE : EV_FIRST; // (a phone that played offline catches up as it keeps playing)
          sc = Math.min(sc, Math.floor(cap)); if (old) sc = Math.max(sc, old.s);
        }
        this.sql.exec('INSERT INTO scores (b, pid, s, t) VALUES (?, ?, ?, ?) ON CONFLICT (b, pid) DO UPDATE SET s = excluded.s, t = excluded.t', b, me.pid, sc, now);
        const rank = this.one('SELECT COUNT(*) AS n FROM scores WHERE b = ? AND s > ?', b, sc).n + 1;
        return json({ ok: true, rank });
      }
      if (path === 'fleet-new') {
        if (this.limited('f:' + me.pid, 20000)) return fail('slow', 'Wait a moment before starting another fleet.', 429);
        let c = code(5); while (this.one('SELECT code FROM fleets WHERE code = ?', c)) c = code(5);
        this.sql.exec('INSERT INTO fleets (code, nm, owner, t) VALUES (?, ?, ?, ?)', c, int(body.fnm, 0, 255), me.pid, now);
        this.sql.exec('UPDATE players SET fleet = ?, t = ? WHERE pid = ?', c, now, me.pid);
        return json({ code: c });
      }
      if (path === 'fleet-join') {
        if (this.limited('j:' + me.pid, 2000)) return fail('slow', 'Wait a moment and try again.', 429);
        const c = String(body.code || '').toUpperCase(); const f = FLEET_RE.test(c) && this.one('SELECT code FROM fleets WHERE code = ?', c);
        if (!f) return fail('nofleet', 'No fleet has that code. Check the five letters.', 404);
        if (me.fleet !== c && this.one('SELECT COUNT(*) AS n FROM players WHERE fleet = ?', c).n >= MAX_FLEET) return fail('full', `That fleet is full (${MAX_FLEET} captains).`);
        this.sql.exec('UPDATE players SET fleet = ?, t = ? WHERE pid = ?', c, now, me.pid);
        this.sql.exec('UPDATE fleets SET t = ? WHERE code = ?', now, c);
        return json({ code: c });
      }
      if (path === 'fleet-leave') { this.sql.exec('UPDATE players SET fleet = NULL, t = ? WHERE pid = ?', now, me.pid); return json({ ok: true }); }
      if (path === 'save') {
        if (this.limited('v:' + me.pid, 10000) || this.limited('vi:' + ip, 10000)) return fail('slow', 'Wait a few seconds before making another code.', 429);
        const data = String(body.data || ''); if (!data || data.length > MAX_SAVE) return fail('big', 'That career is too big to send.');
        this.sql.exec('DELETE FROM saves WHERE pid = ?', me.pid);
        let c = code(10); while (this.one('SELECT code FROM saves WHERE code = ?', c)) c = code(10);
        this.sql.exec('INSERT INTO saves (code, pid, data, t) VALUES (?, ?, ?, ?)', c, me.pid, data, now);
        return json({ code: c });
      }
      return fail('nope', 'Not found.', 404);
    } catch (e) { return fail('server', 'The server had a problem. Try again later.', 500); }
  }
  board(b, pid, now) {
    if (!boardOk(b, now)) return fail('board', 'That leaderboard is closed.');
    if (b.startsWith('fl:')) { // fleets: members' event tokens this week, added up
      const ev = 'ev:' + b.slice(3);
      const top = this.rows(`SELECT p.fleet AS code, f.nm AS nm, SUM(s.s) AS s, COUNT(*) AS m FROM scores s JOIN players p ON p.pid = s.pid JOIN fleets f ON f.code = p.fleet
        WHERE s.b = ? GROUP BY p.fleet ORDER BY s DESC LIMIT 50`, ev);
      const mine = ID_RE.test(pid || '') ? (this.one('SELECT fleet FROM players WHERE pid = ?', pid) || {}).fleet : null;
      return json({ top: top.map(r => ({ nm: r.nm, s: r.s, m: r.m, me: r.code === mine })), n: top.length });
    }
    const top = this.rows(`SELECT s.pid AS pid, s.s AS s, p.nm AS nm, f.nm AS fnm FROM scores s JOIN players p ON p.pid = s.pid LEFT JOIN fleets f ON f.code = p.fleet
      WHERE s.b = ? ORDER BY s.s DESC, s.t ASC LIMIT 50`, b);
    const n = this.one('SELECT COUNT(*) AS n FROM scores WHERE b = ?', b).n;
    let me = null;
    if (ID_RE.test(pid || '')) { const r = this.one('SELECT s FROM scores WHERE b = ? AND pid = ?', b, pid); if (r) me = { s: r.s, rank: this.one('SELECT COUNT(*) AS n FROM scores WHERE b = ? AND s > ?', b, r.s).n + 1 }; }
    return json({ top: top.map(r => ({ nm: r.nm, s: r.s, f: r.fnm === null || r.fnm === undefined ? -1 : r.fnm, me: r.pid === pid })), me, n });
  }
  fleet(c, w, pid, now) {
    c = String(c || '').toUpperCase(); if (!FLEET_RE.test(c)) return fail('nofleet', 'No fleet has that code.');
    const f = this.one('SELECT code, nm FROM fleets WHERE code = ?', c);
    if (!f) return json({ code: c, gone: true });
    const b = 'ev:' + (/^\d{4}-W\d{2}$/.test(w || '') ? w : isoWeek(now));
    const members = this.rows('SELECT p.pid AS pid, p.nm AS nm, COALESCE(s.s, 0) AS s FROM players p LEFT JOIN scores s ON s.pid = p.pid AND s.b = ? WHERE p.fleet = ? ORDER BY s DESC LIMIT 20', b, c);
    return json({ code: c, nm: f.nm, members: members.map(m => ({ nm: m.nm, s: m.s, me: m.pid === pid })), total: members.reduce((t, m) => t + m.s, 0) });
  }
}
