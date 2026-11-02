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

## Testing without Cloudflare

`node test/local-server.mjs 8787` runs `worker.js` on your own computer with small stand-ins for the Workers
runtime (Node 18 or newer, no packages needed). Point the game at `ws://localhost:8787`.
`node test/protocol-test.mjs ws://localhost:8787` checks the server's rules.
