# Case Sim online server

The backend for online play: the global leaderboard, direct trades and online case battles. It's a Cloudflare Worker (`src/worker.js`) with a D1 database (`schema.sql`), both on Cloudflare's free plan.

- **Live at:** https://case-sim-server.caseopeningsim.workers.dev
- **Database:** `case-sim` (its id is in `wrangler.toml`)
- **Game setting:** `SERVER_URL` in `site/index.html` points here

It deploys automatically when `server/` changes on `main` (see the main [README](../README.md)). If `schema.sql` changed, its tables are updated first. The game works offline if the server can't be reached.

## Deploying by hand

```bash
cd server
npm install
npx wrangler login
npm run db:init      # only needed when schema.sql changed; safe to repeat
npm run deploy
```

## Running it locally

```bash
cd server
npm run db:init:local
npm run dev          # http://127.0.0.1:8787
```

To use the local server, change `SERVER_URL` in a **copy** of `site/index.html` to `http://127.0.0.1:8787`. Then open that copy in two different browsers (or a normal and a private window) to play against yourself. Don't commit that change: the pre-deploy checks refuse any `SERVER_URL` that isn't `https://`.

## Starting from scratch on a new Cloudflare account

1. `npx wrangler d1 create case-sim`, then put the printed `database_id` in `wrangler.toml`. Also set `account_id` there, and in `.github/workflows/deploy.yml`.
2. `npm run db:init`, then `npm run deploy`. Put the address it prints into `SERVER_URL` in `site/index.html`, and into the last step of the workflow.

## Moderation

Unlock the admin panel in the game with your admin key (`ADMK-...`). You then get:

- a **Ban** button on every row of the global leaderboard
- a **Moderation** card in the admin panel, to ban or unban by player id (hover a name on the leaderboard to see its id)

A banned player drops off the leaderboard and can't trade or join battles. Admin requests are signed with your admin key, and the server checks them against the public half in `wrangler.toml` (`ADMIN_X` / `ADMIN_Y`). Those two values are public and safe to commit. The private key never goes to the server.

To wipe everything and start over:

```bash
npx wrangler d1 execute case-sim --remote --command "DELETE FROM players; DELETE FROM trades; DELETE FROM battles;"
```

Players who reconnect after a wipe are signed up again automatically.

## How it works

- **Sign-up.** When a player picks a username, the game registers and gets a random token, which it keeps in its save. The token is what identifies the player on every request.
- **Stats.** The game sends its stats and a public copy of its inventory after changes, at most once every 10 seconds. That copy feeds the leaderboard and lets other players pick items to ask for.
- **Trades.** Items and coins you offer leave your inventory as soon as you send the offer, so you can't sell or spend them while it's open. If the offer is declined or cancelled, they come back. When it's accepted, each game applies its own half and tells the server it has done so. A ledger in the save stops a trade from being applied twice.
- **Battles.** When a lobby fills up or the creator starts it, the server picks a random seed and a start time 4 seconds ahead. Every game in the battle rolls from that seed, so all of them show the same items. The winner's game adds the whole table to its inventory. If you close the game mid-battle, you get your result when you open it again.

### About security

Security here is deliberately light. It stops people from casually pretending to be someone else, but it isn't cheat-proof. Inventories and rolls live in each player's own save, so someone who edits their save can give themselves items and then trade them away. For a game among friends that's normally fine, and bans handle anyone who spoils it. Making it cheat-proof would mean moving case opening and inventories onto the server. The API was laid out with that upgrade in mind.

## Free-tier limits

At the time of writing, Cloudflare's free plan includes about **100,000 Worker requests a day**. D1 allows **5 million row reads and 100,000 row writes a day**, plus **5 GB** of storage. Limits change, so check <https://developers.cloudflare.com/workers/platform/pricing/> and <https://developers.cloudflare.com/d1/platform/pricing/>.

An active player makes roughly 300–700 requests an hour, depending on which tab is open. The Trade and Battles tabs poll more often. So the free tier covers a few hundred player-hours a day. When you go over, requests fail until the daily reset, and the game shows the red "can't reach the server" dot and keeps working offline.

## API reference

JSON in, JSON out. Authenticated routes take `Authorization: Bearer <token>`.

| Method | Path | Auth | Body / query | Returns |
| --- | --- | --- | --- | --- |
| POST | `/api/register` | | `{ name }` | `{ id, name, token }` |
| POST | `/api/stats` | ✓ | `{ played, opened, best_value, best_item, inv_value, inventory }` | `{ ok }` |
| GET | `/api/leaderboard` | | `?sort=value\|best\|opened\|played&limit=1-200` | `{ players, now }` |
| GET | `/api/players` | | `?q=name-prefix` | `{ players, now }` |
| GET | `/api/players/:id` | | | public profile with inventory |
| POST | `/api/trades` | ✓ | `{ to, give:{items,coins}, want:{items,coins}, message }` | `{ ok, id }` |
| GET | `/api/trades` | ✓ | | `{ trades, now }` (your last 60) |
| POST | `/api/trades/:id/accept` | ✓ | | recipient only, while pending |
| POST | `/api/trades/:id/decline` | ✓ | | recipient only, while pending |
| POST | `/api/trades/:id/cancel` | ✓ | | sender only, while pending |
| POST | `/api/trades/:id/settle` | ✓ | | marks your side as applied |
| POST | `/api/battles` | ✓ | `{ case_id, rounds 1-10, max_players 2-4, mode high\|low, version }` | the lobby |
| GET | `/api/battles` | | | open lobbies |
| GET | `/api/battles/:id` | | | one battle (with `seed`, `start_at` once running) |
| POST | `/api/battles/:id/join` | ✓ | `{ version }` | the lobby |
| POST | `/api/battles/:id/leave` | ✓ | | the lobby (the creator leaving cancels it) |
| POST | `/api/battles/:id/start` | ✓ | | creator only; bots fill empty seats |
| POST | `/api/admin` | signed | `{ p: '{"a":"ban"\|"unban","id","ts"}', g: signature }` | `{ ok }` |

Items are sent as `[uid, item index, wear 0-5, float × 10000, tracker 0/1]`. Names are 3–16 characters: letters, numbers, `_` and `-`. Unfilled lobbies close after 15 minutes. Each player can have up to 20 open offers.
