# Case Sim server

The backend for accounts. It holds every account's coins and items and does every roll: opening cases, the upgrader, trades, battles and gift codes. It also serves the global leaderboard. The code is `src/worker.js`, with a D1 database (`schema.sql`), both on Cloudflare's free plan.

- **Live at:** https://case-sim.pages.dev/api. It runs on the game's own site, as a Pages Function (`functions/api/[[path]].js` at the repo root simply hands every `/api` request to `src/worker.js`).
- **Database:** `case-sim` (its id is in `wrangler.toml` here and in the root `wrangler.toml`; the checks keep them the same)
- **Game setting:** a page served from the site calls its own `/api`. A copy opened as a file calls `SERVER_URL` in `site/index.html`.

It deploys with the site whenever `site/`, `server/` or `functions/` changes on `main`, after the tests pass (see the main [README](../README.md)). If `schema.sql` changed, its tables are updated first.

## How it works

- **Accounts.** Players sign up with a username and password. Passwords are stored as salted PBKDF2 hashes, never as plain text. Logging in gives the game a random session token, which it keeps until the player logs out. Five wrong passwords in a row lock that account's login for a minute.
- **The server is in charge.** The game asks the server to open a case, sell, upgrade, trade or join a battle. The server checks that the account can afford it and owns the items, rolls the result and saves it. The game then shows what came back. Editing the game or its save can't create coins or items for an account.
- **Same rules everywhere.** The server doesn't keep its own copy of the items, cases and odds. `src/core.js` is built from the CORE block in `site/index.html` by `scripts/sync-core.mjs`, before every deploy and every test run. Don't edit `core.js` itself; it isn't committed.
- **All or nothing.** Each change to coins or items runs as a single database transaction. If any part fails, for example the coins ran out or an item was sold a moment earlier, none of it happens. Coins can never go below zero, and every item belongs to exactly one account.
- **Trades.** Offered items are set aside and the offered coins are taken when the offer is made. Accepting swaps everything at once. Declining or cancelling gives it all back.
- **Battles.** Entry is paid on joining. When the last seat fills, or the creator starts early and bots take the empty seats, the server picks a seed, rolls the whole battle and pays the winner. Every player's game replays the same rolls from that seed, starting at the same moment.
- **Gifts.** Gift codes are signed with the admin key. The server checks the signature, and each account can claim a given gift once.
- **Time played** is counted by the server from the game's heartbeat, which it sends every 30 seconds.

Guests (players without an account) never talk to the server. Their progress stays on their own device, and they can't trade or appear on the leaderboard.

## Admin panel

Unlock it in the game with the lock icon and your admin key (`ADMK-...`). On a phone, the lock icon is in the top bar. It works whether or not you're logged in. Tabs:

- **Overview:** accounts, who's online, new today, coins and item value in circulation, cases opened, open trades and battles, gifts claimed. Also lists of the richest, newest and most recently active players. Click a name to manage that player.
- **Players:** find anyone by username. For each player you can:
  - see their stats, devices, recent trades and full inventory
  - give, take or set coins
  - give any item (choose the wear, a tracker, and up to 100 at once)
  - remove selected items
  - rename them, set a new password, or log them out on every device
  - ban them with a reason (they're shown it) or unban them
  - delete the account. You have to type the name to confirm. Their open trades and battles are cancelled and refunded.
- **Gifts:** build gift codes as before. Each code now shows how many accounts claimed it. You can cancel a code so nobody else can claim it (existing claims are kept), or reinstate it.
- **Trades & battles:** every open trade offer and battle lobby, each with a Cancel button that refunds everyone.
- **Game:** publish an announcement banner that every player sees, and turn maintenance mode on or off. Maintenance pauses opening cases, selling, upgrades, trades, battles and gifts for every account, while still letting players log in and look around.
- **Log:** every change made from the panel, newest first.

The leaderboard also gets **Manage** and **Ban** buttons on each row while admin is unlocked.

How it's protected: each admin request is signed with your admin key, carries a one-time id, and expires after five minutes. The server checks all three, so a copied request can't be replayed. The public half of the key is in `wrangler.toml` (`ADMIN_X` / `ADMIN_Y`) and is safe to publish. The private key never goes to the server.

Players manage their own account from the **Account** button in the top bar. It shows their stats and lets them change their password (which logs out their other devices) or log out on every device.

To wipe every account and start over:

```bash
npx wrangler d1 execute case-sim --remote --command "DELETE FROM accounts; DELETE FROM sessions; DELETE FROM items; DELETE FROM offers; DELETE FROM lobbies; DELETE FROM gift_claims;"
```

## Deploying by hand

From the repo root:

```bash
npx wrangler login
npx wrangler d1 execute case-sim --remote --file server/schema.sql   # only when schema.sql changed; safe to repeat
node scripts/sync-core.mjs
npx wrangler pages deploy site --project-name case-sim --branch main
```

## Running it locally

From the repo root:

```bash
node scripts/sync-core.mjs
npx wrangler d1 execute case-sim --local --file server/schema.sql
npx wrangler pages dev                                     # game and server on http://127.0.0.1:8788
API_BASE=http://127.0.0.1:8788 node scripts/api-test.mjs   # in a second terminal: the server tests
```

Open http://127.0.0.1:8788 to play against the local copy.

Set `ADMIN_KEY=ADMK-...` before running the tests to include the gift and moderation tests.

## Free-tier limits

At the time of writing, Cloudflare's free plan includes about **100,000 Worker requests a day**. D1 allows **5 million row reads and 100,000 row writes a day**, plus **5 GB** of storage. Limits change, so check <https://developers.cloudflare.com/workers/platform/pricing/> and <https://developers.cloudflare.com/d1/platform/pricing/>.

A logged-in player sends a request for each case, sale, upgrade and trade, plus a heartbeat every 30 seconds. The Trade and Battles tabs also check for updates every few seconds while open. A busy player makes a few hundred requests an hour. If the limit is reached, requests fail until the daily reset. Players see a red dot next to their name and can switch to guest play.

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
| GET | `/api/config` | | `{ announcement, maintenance, version }` |
| POST | `/api/account/password` | ✓ | `{ old, password }` (logs out other devices) |
| POST | `/api/account/logout-all` | ✓ | |
| POST | `/api/admin` | signed | `{ p: '{"a": action, "n": one-time id, "ts", ...}', g: signature }` |

Admin actions: `stats`, `find {q}`, `player {id}`, `coins {id, delta \| set}`, `give {id, idx, wear, tracker, count}`, `take {id, ids}`, `rename {id, name}`, `ban {id, reason}`, `unban {id}`, `reset {id, password}`, `logout {id}`, `delete {id, confirm}`, `offers`, `cancel_offer {offer}`, `lobbies`, `cancel_lobby {lobby}`, `settings {announcement, maintenance}`, `gifts {gifts}`, `revoke_gift {gift, undo}`, `log`. `id` can be a player id or a username.

Limits: usernames are 3–16 letters, numbers, `_` or `-`, and passwords are 6–72 characters. There can be at most 20 new accounts per network per hour, and the free case opens at most once every 3 seconds. Each account holds up to 3,000 items and can have 20 open offers. Unfilled lobbies close after 15 minutes and refund everyone.
