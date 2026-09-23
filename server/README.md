# Case Sim server

The backend for accounts. It holds every account's coins and items and does every roll: opening cases, the upgrader, trades, battles and gift codes. It also serves the global leaderboard. It's a Cloudflare Worker (`src/worker.js`) with a D1 database (`schema.sql`), both on Cloudflare's free plan.

- **Live at:** https://case-sim-server.caseopeningsim.workers.dev
- **Database:** `case-sim` (its id is in `wrangler.toml`)
- **Game setting:** `SERVER_URL` in `site/index.html` points here

It deploys automatically when `server/` or the game file changes on `main`, after the tests pass (see the main [README](../README.md)). If `schema.sql` changed, its tables are updated first.

## How it works

- **Accounts.** Players sign up with a username and password. Passwords are stored as salted PBKDF2 hashes, never as plain text. Logging in gives the game a random session token, which it keeps until the player logs out. Five wrong passwords in a row lock that account's login for a minute.
- **The server is in charge.** The game asks the server to open a case, sell, upgrade, trade or join a battle. The server checks that the account can afford it and owns the items, rolls the result and saves it. The game then shows what came back. Editing the game or its save can't create coins or items for an account.
- **Same rules everywhere.** The server doesn't keep its own copy of the items, cases and odds. `src/core.js` is built from the CORE block in `site/index.html` by `scripts/sync-core.mjs`, before every deploy and every test run. Don't edit `core.js` itself; it isn't committed.
- **All or nothing.** Each change to coins or items runs as a single database transaction. If any part fails, for example the coins ran out or an item was sold a moment earlier, none of it happens. Coins can never go below zero, and every item belongs to exactly one account.
- **Trades.** Offered items are set aside and the offered coins are taken when the offer is made. Accepting swaps everything at once. Declining or cancelling gives it all back.
- **Battles.** Entry is paid on joining. When the last seat fills, or the creator starts early and bots take the empty seats, the server picks a seed, rolls the whole battle and pays the winner. Every player's game replays the same rolls from that seed, starting at the same moment.
- **Gifts.** Gift codes are signed with the admin key. The server checks the signature, and each account can claim a given gift once.
- **Time played** is counted by the server from the game's once-a-minute heartbeat.

Guests (players without an account) never talk to the server. Their progress stays on their own device, and they can't trade or appear on the leaderboard.

## Moderation

Unlock the admin panel in the game with your admin key (`ADMK-...`). You then get:

- a **Ban** button on every row of the global leaderboard
- a **Moderation** card in the admin panel. Type a username to ban or unban it, or give it a new password when someone forgets theirs. There's no email, so password resets go through you.

A banned player is signed out, drops off the leaderboard and can't log in until unbanned. Their items are kept. Admin requests are signed with your admin key and checked against the public half in `wrangler.toml` (`ADMIN_X` / `ADMIN_Y`). Those two values are safe to publish. The private key never goes to the server.

To wipe every account and start over:

```bash
npx wrangler d1 execute case-sim --remote --command "DELETE FROM accounts; DELETE FROM sessions; DELETE FROM items; DELETE FROM offers; DELETE FROM lobbies; DELETE FROM gift_claims;"
```

## Deploying by hand

```bash
cd server
npm install
npx wrangler login
npm run db:init      # only needed when schema.sql changed; safe to repeat
npm run deploy       # rebuilds src/core.js from the game first
```

## Running it locally

```bash
cd server
npm install
npm run db:init:local
npm run dev          # http://127.0.0.1:8787
node ../scripts/api-test.mjs          # in a second terminal: the server tests
```

To play against the local server, open a **copy** of `site/index.html` and change its `SERVER_URL` to `http://127.0.0.1:8787`. Don't commit that change: the pre-deploy checks refuse any `SERVER_URL` that isn't `https://`.

Set `ADMIN_KEY=ADMK-...` before running the tests to include the gift and moderation tests.

## Free-tier limits

At the time of writing, Cloudflare's free plan includes about **100,000 Worker requests a day**. D1 allows **5 million row reads and 100,000 row writes a day**, plus **5 GB** of storage. Limits change, so check <https://developers.cloudflare.com/workers/platform/pricing/> and <https://developers.cloudflare.com/d1/platform/pricing/>.

A logged-in player sends a request for each case, sale, upgrade and trade, plus a heartbeat about once a minute. The Trade and Battles tabs also check for updates every few seconds while open. A busy player makes a few hundred requests an hour. If the limit is reached, requests fail until the daily reset. Players see a red dot next to their name and can switch to guest play.

## API

JSON in and out. Logged-in routes take `Authorization: Bearer <token>`. Items are sent as `[id, item index, wear 0-5, float × 10000, tracker 0/1]`.

| Method | Path | Login | Body / query |
| --- | --- | --- | --- |
| POST | `/api/signup` | | `{ name, password }` → `{ token, me, inventory }` |
| POST | `/api/login` | | `{ name, password }` → `{ token, me, inventory }` |
| POST | `/api/logout` | ✓ | |
| GET | `/api/me` | ✓ | → `{ me, inventory }` |
| POST | `/api/ping` | ✓ | heartbeat → `{ me, pending }` |
| POST | `/api/open` | ✓ | `{ case_id, count 1-5 }` |
| POST | `/api/sell` | ✓ | `{ ids }` |
| POST | `/api/upgrade` | ✓ | `{ ids, mult }` |
| POST | `/api/gift` | ✓ | `{ code }` |
| GET | `/api/leaderboard` | | `?sort=value\|best\|opened\|played&limit=1-200` |
| GET | `/api/players` | | `?q=name-prefix` |
| GET | `/api/players/:id` | | public profile and inventory |
| POST | `/api/offers` | ✓ | `{ to, give, give_coins, want, want_coins, message }` |
| GET | `/api/offers` | ✓ | your last 50 offers |
| POST | `/api/offers/:id/accept\|decline\|cancel` | ✓ | |
| POST | `/api/battles` | ✓ | `{ case_id, rounds 1-10, max_players 2-4, mode high\|low, version, bots }` |
| GET | `/api/battles` | | open lobbies |
| GET | `/api/battles/:id` | | one battle (`seed` and `start_at` once running) |
| POST | `/api/battles/:id/join\|leave\|start` | ✓ | |
| POST | `/api/admin` | signed | `{ p: '{"a":"ban"\|"unban"\|"reset","id","password","ts"}', g: signature }` |

Limits: usernames are 3–16 letters, numbers, `_` or `-`, and passwords are 6–72 characters. There can be at most 20 new accounts per network per hour, and the free case opens at most once every 3 seconds. Each account holds up to 3,000 items and can have 20 open offers. Unfilled lobbies close after 15 minutes and refund everyone.
