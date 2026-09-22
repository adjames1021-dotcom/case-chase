# Case Sim online server

This folder is the backend for online play. It turns on three things in the game:

- **Global leaderboard.** Every online player, ranked by inventory value, best drop, cases opened or time played.
- **Direct trades.** Find a player, pick items from both inventories, add coins and a message, and send an offer. They accept or decline from their Trade tab.
- **Online case battles.** Create a lobby and other players join it. If you don't want to wait, start early and bots fill the empty seats. Everyone watches the same rolls at the same time.

It runs on Cloudflare's free tier as one Worker (a small server script) plus one D1 database (SQLite). You don't need a credit card for it.

If you never set it up, the game still works offline, with trade codes, bot battles and the leaderboard that travels in codes.

---

## What you need

- A free Cloudflare account: <https://dash.cloudflare.com/sign-up>
- Node.js 18 or newer: <https://nodejs.org> (the LTS installer is fine)
- A terminal open in this `server` folder

## Setup (about 10 minutes)

### 1. Install the tools

```bash
cd server
npm install
```

This installs `wrangler`, Cloudflare's command-line tool, into this folder.

### 2. Log in to Cloudflare

```bash
npx wrangler login
```

A browser window opens. Click **Allow**.

### 3. Create the database

```bash
npx wrangler d1 create case-sim
```

The output includes something like:

```toml
[[d1_databases]]
binding = "DB"
database_name = "case-sim"
database_id = "0f1e2d3c-aaaa-bbbb-cccc-1234567890ab"
```

Copy the `database_id` value and paste it into `wrangler.toml` in place of `REPLACE_WITH_YOUR_DATABASE_ID`.

### 4. Create the tables

```bash
npm run db:init
```

(This runs `wrangler d1 execute case-sim --remote --file schema.sql`. It's safe to run again later.)

### 5. Deploy the server

```bash
npm run deploy
```

At the end it prints your server's address:

```
https://case-sim-server.<your-name>.workers.dev
```

Open that address in a browser. You should see `{"ok":true,"service":"case-sim-server"}`.

### 6. Point the game at it

Open `case-opening-sim.html` in a text editor, search for `SERVER_URL`, and paste your address:

```js
const SERVER_URL = 'https://case-sim-server.<your-name>.workers.dev';
```

Save the file and reload the game. A green dot next to your name in the top bar means you're connected. Trade, Battles and Ranks now open on their **Online** views. The **Codes** and **Vs bots** views still work as before.

### 7. Share the game

Everyone has to play the **same copy** of the HTML file, with `SERVER_URL` set. Two ways to do that:

- **Send the file.** It runs straight from disk (double-click it). Send the edited `case-opening-sim.html` to your friends.
- **Host it (recommended).** Then everyone just opens a link. Free options:
  - **Cloudflare Pages:** in the dashboard go to *Workers & Pages → Create → Pages → Upload assets*. Upload a folder that holds the game renamed to `index.html` (plus `assets/` if you use an image pack). You get a `https://<name>.pages.dev` link.
  - **GitHub Pages:** in the repo, open *Settings → Pages* and choose the branch. This only works if the repo is public, or on a paid GitHub plan.

The server accepts requests from any page (CORS `*`), so both options, and plain files, work with no extra settings.

---

## Trying it locally first (optional)

You can run the whole thing on your own computer before you deploy:

```bash
npm run db:init:local
npm run dev
```

The server runs at `http://127.0.0.1:8787`. Set `SERVER_URL` to that address and open the game in two different browsers, or one normal window and one private window, to play against yourself.

## Updating

- **Server code changed?** Run `npm run deploy` again. Players' data stays.
- **Schema changed?** Run `npm run db:init` again. It only adds what's missing.
- **Game changed?** Replace the HTML file you share or host. When you change how items roll or which cases exist, bump `GAME_VERSION` in the game. Battles only match players on the same version, so rolls always line up, and older games are told to update.

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
