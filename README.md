# Saltshot Seas multiplayer server

The small server that lets friends' phones find each other. It is one file, `worker.js`, running free on
Cloudflare Workers. It doesn't run the game: it passes messages between the phones in a room. In co-op the host's
phone runs the sea; in the battle arena the first captain's phone keeps the round clock.

## Put it online (once, about 10 minutes, free)

1. **Cloudflare account.** Sign up at <https://dash.cloudflare.com/sign-up>. The Free plan is enough.
2. **This folder on GitHub.** It lives in your repository `saltshot-seas-server`.
3. **Connect the two.** In the Cloudflare dashboard open **Workers & Pages → Create application**, choose
   **Import a repository** (Continue with GitHub), let Cloudflare see `saltshot-seas-server`, and pick it.
   - Project name: `saltshot-seas-server`. It must match `name` in `wrangler.toml`.
   - Leave the build command empty and the deploy command as `npx wrangler deploy`.
   - Press **Create and deploy**. The first build takes a minute or two.
4. **Your address.** When it's done, Cloudflare shows a link like
   `https://saltshot-seas-server.yourname.workers.dev`. Open it in a browser: it should say
   *"Saltshot Seas server is running."* That address goes into the game (`MP_SERVER` in `index.html`, or the
   **Server** box under *Sail with friends*).

From then on, every change pushed to the repository's main branch is deployed automatically.

## What the free plan covers

Each room is a Durable Object (SQLite-backed, which the Workers Free plan includes). Phones send ten small
updates a second while they're in a room. Cloudflare counts 20 of those as one request, so the free 100,000
requests a day are roughly 13 hours of a full four-captain room, or about 27 hours of two friends sailing together,
every day. An empty room costs nothing (WebSocket hibernation). The limits reset at midnight UTC; if they run out,
new rooms can't open until then.

## How it works

- `wss://<address>/room/<CODE>?mode=coop|arena&create=1&name=…&v=52`: the first phone creates the room and is
  its host; friends join with the same four-letter code (`create=0`).
- The server refuses a code that's taken, a room that doesn't exist, the wrong mode, a different game version, or a
  full room (4 captains in co-op, 8 in the arena), with a message the game shows.
- Every message a phone sends goes to everyone else in the room (or to one player, with `to`), stamped with the
  sender's id. More than 40 messages a second from one phone are dropped.
- When the host leaves, the longest-serving captain becomes host. In co-op the guests go back to their own sea
  (the host's phone was running the shared one); in the arena play carries on.
- Names are cleaned to letters, digits, spaces and `' -`, 18 characters at most. There is no chat beyond four
  fixed quick messages.

## Leaderboards, fleets and save codes (game version 56)

The same Worker also answers a small JSON API under `/api`, kept by one more SQLite-backed Durable Object (`Boards`,
binding `BOARDS`, added by migration `v2` in `wrangler.toml`; Cloudflare creates it on the next deploy).

- `POST /api/score` `{pid, key, nm, b, s}`: a player's score on a board. `b` is `ev:<ISO week>` (this week's event
  tokens; they only go up) or `ar:<YYYY-MM>` (this month's arena rating). Only the current (or just-ended) week and month
  are open. At most one score per board every 8 seconds per player, and event scores can't climb faster than a keen player
  earns (35 tokens a minute since the last score, plus 300; a first score at most 3,000).
- `GET /api/board?b=…&pid=…`: the top 50 and your own rank. `fl:<ISO week>` adds the event board up by fleet.
- `POST /api/fleet-new` `{pid, key, fnm}`, `fleet-join` `{pid, key, code}`, `fleet-leave` `{pid, key}`; `GET
  /api/fleet?code=…&w=…`: fleets of up to 20 captains with five-letter codes, and their members' weekly scores.
- `POST /api/save` `{pid, key, data}` makes a ten-letter save code (one per player; a new one replaces the old) that
  `POST /api/load` `{code}` returns for 30 days. Guesses are slowed to one every 3 seconds per address.

Players are a random 12-letter id and a 24-letter secret made by the game; the server keeps only the secret's SHA-256.
**Nobody can type text that other players see:** names are numbers that the game turns into names from fixed word lists
(captains: 576 names, fleets: 256), so there is nothing to moderate. Old data is cleared now and then: scores after
40 days, save codes after 30, empty fleets after a week, players with nothing left after 60 days. New players are limited to one
a minute from any one address, save codes to one every 10 seconds, and request bodies are checked by size before they are read. `node test/api-test.mjs http://localhost:8787` checks the API.

## Testing without Cloudflare

`node test/local-server.mjs 8787` runs `worker.js` on your own computer with small stand-ins for the Workers
runtime (Node 22.5 or newer for the leaderboards' SQLite, no packages needed). Point the game at `ws://localhost:8787`.
`node test/protocol-test.mjs ws://localhost:8787` checks the server's rules.

## Cloud backups (game version 59)

`POST /api/backup` `{pid, key, nm, data}` stores the player's latest save (one row per player, replaced each time, at
most one a minute, up to 400 KB). `POST /api/restore` `{pid, key}` returns it (never registers a new player; a wrong key
or unknown player gets 404, and tries from one address are slowed to one every 3 seconds). The game shows the id and key
together as a 36-letter recovery code. Backups are deleted 400 days after the last one.
