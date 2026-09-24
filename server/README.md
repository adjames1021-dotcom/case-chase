# Case Sim server

The backend for accounts. It holds every account's coins and items and does every roll: opening cases, the upgrader, trades, battles and gift codes. It also serves the global leaderboard. The code is `api.js`, with a D1 database (`schema.sql`), both on Cloudflare's free plan.

- **Live at:** https://case-sim.pages.dev/api. It runs on the game's own site, as a Pages Function (`functions/api/[[path]].js` at the repo root simply hands every `/api` request to `api.js`). There is no separate worker.
- **Settings:** the root `wrangler.toml` holds the database id, the admin public key and the permanent admin accounts. It's the only Cloudflare config in the repo.
- **Game setting:** a page served from the site calls its own `/api`. A copy opened as a file calls `SERVER_URL` in `site/index.html`.

It deploys with the site whenever `site/`, `server/` or `functions/` changes on `main`, after the tests pass (see the main [README](../README.md)). If `schema.sql` changed, its tables are updated first.

## How it works

- **Accounts.** Players sign up with a username and password. Passwords are stored as salted PBKDF2 hashes, never as plain text. Logging in gives the game a random session token, which it keeps until the player logs out. Five wrong passwords in a row lock that account's login for a minute.
- **Usernames.** Rude usernames are refused, including disguised ones like `sh1t`, `fuuuck` or `Big_Dick`. So are names that pose as staff: anything that looks like `admin`, `moderator` or `LILBEAN`, including look-alikes such as `L1LBEAN`. The rules are `nameProblem()` in the CORE block of `site/index.html`, so the game warns as you type and the server enforces the same rules. The word list is stored in ROT13 so the file isn't a wall of slurs. To change it, edit `BLOCKED_NAMES` there (run `rot13` on the words). Names that were made before these rules show up under **Names that break the rules** in the admin Overview, where you can rename them.
- **No bot accounts.** Before signing up, the game fetches a challenge from `/api/challenge` and works out a matching answer (a small proof of work: about a second of the browser's time, done while the player types). The server checks the answer, and each challenge works for one account only. Sign-ups are also refused if the form's hidden "website" field is filled in (people never see it; bots fill in every field), or if the form comes back quicker than a person could type. On top of that, each network can make 20 accounts an hour and 60 a day, and the whole game takes at most 300 new accounts an hour.
- **Devices.** The game sends a random id it keeps on the device and a hash of the browser's traits with every request. The server records these for each account, along with the network, all as keyed hashes (never raw IP addresses). A device can make at most 5 accounts a day. A blocked device can't make accounts or log in. Once any account on a device is banned, that device can't make new ones. Device ids are the strong signal. Browser hashes and networks are weak ones, because a class of identical school laptops shares both.
- **Rate limits.** Every API route is limited. Each request first passes a quick check held in memory, per network and per logged-in account (about 4 requests a second per account, with room for bursts). Actions worth abusing are also counted in the database, so their limits hold across all of Cloudflare's servers:

  | What | Limit |
  | --- | --- |
  | Sign-up attempts | 60 per network per 10 minutes |
  | New accounts | 20 per network per hour, 60 a day; 300 per hour overall |
  | Wrong passwords | 5 in a row locks that account for a minute; 50 per network per 10 minutes |
  | Trade offers, battles made | 40 each per account per 10 minutes |
  | Gift codes tried | 30 per account per 10 minutes |
  | Password changes | 10 per account per hour |

  Networks get far more room than accounts, because a whole school can share one IP address. A refused request gets HTTP 429 with a `Retry-After` header, and the game shows the message.
- **The server is in charge.** The game asks the server to open a case, sell, upgrade, trade or join a battle. The server checks that the account can afford it and owns the items, rolls the result and saves it. The game then shows what came back. Editing the game or its save can't create coins or items for an account.
- **Same rules everywhere.** The server doesn't keep its own copy of the items, cases and odds. `core.js` is built from the CORE block in `site/index.html` by `scripts/sync-core.mjs`, before every deploy and every test run. Don't edit `core.js` itself; it isn't committed.
- **All or nothing.** Each change to coins or items runs as a single database transaction. If any part fails, for example the coins ran out or an item was sold a moment earlier, none of it happens. Coins can never go below zero, and every item belongs to exactly one account.
- **Trades.** Offered items are set aside and the offered coins are taken when the offer is made. Accepting swaps everything at once. Declining or cancelling gives it all back.
- **Battles.** Entry is paid on joining. When the last seat fills, or the creator starts early and bots take the empty seats, the server picks a seed, rolls the whole battle and pays the winner. Every player's game replays the same rolls from that seed, starting at the same moment.
- **Cases pay back more the more they cost.** The odds in the CORE block are tuned by price (`tuneOdds`): the cheapest paid cases pay back about 95% of their price on average, rising to break-even for the 50,000-coin case, and dearer cases have better chances of the rarest items. The free case pays much less (mostly commons, a 1 in 10,000 chance of its knife). It has no cooldown and opens up to 5 at once, like the paid cases.
- **Holiday cases.** Haunted Hollow (Halloween, Oct 1 – Nov 2), Harvest Crate (Thanksgiving, Nov 1 – 30) and Winter Wonder (Christmas, Dec 1 – Jan 6) are only sold, and only battled, in their season. The admin panel's **Game** tab can switch a season on early or off. The **Frosty Present** can't be bought: presents come from rewards, gifts, admin gifts and Winter Wonder cases (a 2% bonus drop), open without a key at any time of year, and show on the case page while you hold one.
- **Locked items.** Players lock items they want to keep (the lock on each inventory tile). A locked item can't be sold (Sell shown skips it), staked in the upgrader, offered or asked for in a trade, listed on the market, or used up opening a case until it's unlocked. The lock belongs to the owner and goes when the item changes hands. Guests' locks are kept in their save.
- **Rewards.** A reward track players claim from the gift button at the top: one reward a day, in order (Day 1, Day 2, …), starting over each week (from Monday, UTC) or each month. Each day can give coins and up to 10 items (any item, including presents and Vault keys). The admin panel's **Game** tab edits it: title, weekly or monthly, how many days, and each day's coins and items, or switch it off. It starts as a weekly track of 100–500 coins with a Vault Key and Vault Case on day 7.
- **Login gift.** From the **Gifts** tab, *Give it to everyone when they log in* turns the gift you've built into a login gift: every account is offered it once, in a pop-up, when it next logs in or plays (new accounts too). It shows how many have claimed it, and you can end it.
- **Battle invites.** When making an online battle you can invite up to 3 players by name, and make it invite-only (hidden from the open list; only invited players can join). Anyone in a waiting room can invite more. Invites arrive with a pop-up and a badge on the Battles tab, where players can join or decline.
- **Market.** Players list items for a price in coins (1 to 1,000,000,000). A listed item is set aside, so it can't be sold, upgraded or traded, and it comes back if the listing is taken down. Buying moves the coins and the item in one transaction, so two people can't buy the same thing. The seller gets every coin (there's no fee) and is told about the sale on their next heartbeat. Each account can have 20 items listed at once and list 60 every 10 minutes. Listings by banned players are hidden and can't be bought; deleting an account takes its listings down. Guests can browse but not buy or sell.
- **Suggestions.** Players post ideas (10–300 characters, the same word filter as usernames, 5 an hour) and vote for the ones they like; posting one counts as your vote. Admins see a status (Open, Planned, Done, Not planned), a reply box and Delete on each suggestion. Suggestions by banned players are hidden.
- **Gifts.** Gift codes are signed with the admin key. The server checks the signature, and each account can claim a given gift once.
- **Time played** is counted by the server from the game's heartbeat, which it sends every 30 seconds.

Guests (players without an account) never talk to the server. Their progress stays on their own device, and they can't trade or appear on the leaderboard.

## Admin panel

There are two ways in:

- **Admin accounts.** Log in to an admin account and the panel unlocks by itself. No key needed. `LILBEAN` always has admin: its account id is listed in `ADMIN_ACCOUNTS` in the root `wrangler.toml`. It goes by id, not name, so nobody else can get it by taking the name. To give another account permanent admin, add its id there, separated by commas. With the key you can also make any account an admin (or remove it) from its page in **Players**. Admin accounts can't change or ban other admin accounts, and can't ban or delete themselves.
- **The admin key.** Unlock the panel with the lock icon and your admin key (`ADMK-...`). On a phone, the lock icon is in the top bar. It works whether or not you're logged in.

Tabs:

- **Overview:** accounts, who's online, new today, coins and item value in circulation, cases opened, open trades and battles, gifts claimed. Also lists of the richest, newest and most recently active players. Click a name to manage that player. Clean-up tools:
  - **Names that break the rules:** ban all or delete all of them at once.
  - **Flagged devices:** devices shared by 3 or more accounts, or used by an account with a rude name. Browsers are flagged at 6 or more accounts and networks at 10. Click one to see every account on it, then ban them all, ban them and block the device, block it only, or delete them all.
  - **Blocked devices,** with a link to unblock each one.
  - **Banned accounts:** delete every banned account for good (type DELETE to confirm).

  Bulk actions never touch admin accounts.
- **Players:** find anyone by username. For each player you can:
  - see their stats, recent trades and full inventory, and the devices, browsers and networks they've used, each with how many other accounts share it (click one to open it)
  - give, take or set coins
  - give any item (choose the wear, a tracker, and up to 100 at once)
  - remove selected items
  - rename them (the name rules apply, but admins may use staff names like `Moderator`), set a new password, or log them out on every device
  - ban them with a reason (they're shown it) or unban them
  - delete the account. You have to type the name to confirm. Their open trades and battles are cancelled and refunded.
- **Gifts:** build gift codes, or give what you've built to every account as a login gift. With the key they're signed codes (`GIFT.`) that also work for guests. From an admin account they're stored on the server (`GIFT2.`) and work for accounts only. Each code now shows how many accounts claimed it. You can cancel a code so nobody else can claim it (existing claims are kept), or reinstate it.
- **Trades, market & battles:** every open trade offer and battle lobby, each with a Cancel button that refunds everyone. It also lists every open market listing, each with a Take down button that returns the item to its owner.
- **Game:** publish an announcement banner that every player sees, edit the rewards track, switch holiday cases on or off (or leave them on the calendar), and turn maintenance mode on or off. Maintenance pauses opening cases, selling, upgrades, trades, battles and gifts for every account, while still letting players log in and look around.
- **Log:** every change made from the panel, newest first.

The leaderboard also gets **Manage** and **Ban** buttons on each row while admin is unlocked.

How it's protected: an admin account's requests use its login, and the server checks the account is still an admin every time. Each key request is signed with your admin key, carries a one-time id, and expires after five minutes. The server checks all three, so a copied request can't be replayed. The public half of the key is in `wrangler.toml` (`ADMIN_X` / `ADMIN_Y`) and is safe to publish. The private key never goes to the server.

Players manage their own account from the **Account** button in the top bar. It shows their stats and lets them change their password (which logs out their other devices) or log out on every device.

To wipe every account and start over:

```bash
npx wrangler d1 execute case-sim --remote --command "DELETE FROM accounts; DELETE FROM sessions; DELETE FROM items; DELETE FROM offers; DELETE FROM lobbies; DELETE FROM gift_claims; DELETE FROM admin_accounts; DELETE FROM server_gifts; DELETE FROM signups; DELETE FROM hits;"
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

JSON in and out. Logged-in routes take `Authorization: Bearer <token>`. The game also sends `X-Device` and `X-Device-FP` (see **Devices**); signing up needs `X-Device`. Items are sent as `[id, item index, wear 0-5, float × 10000, tracker 0/1]`.

| Method | Path | Login | Body / query |
| --- | --- | --- | --- |
| GET | `/api/challenge` | | → `{ challenge, bits }` (the sign-up check) |
| POST | `/api/signup` | | `{ name, password, challenge, nonce }` → `{ token, me, inventory }` |
| POST | `/api/login` | | `{ name, password }` → `{ token, me, inventory }` |
| POST | `/api/logout` | ✓ | |
| GET | `/api/me` | ✓ | → `{ me, inventory, locks, invites, reward_ready, login_gift }` |
| POST | `/api/ping` | ✓ | heartbeat → `{ me, pending, sold, invites, reward_ready, login_gift }` |
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
| POST | `/api/battles` | ✓ | `{ case_id, rounds 1-10, max_players 2-4, mode high\|low, version, bots, invite: [names], private }` |
| GET | `/api/battles` | | open lobbies |
| GET | `/api/battles/:id` | | one battle (`seed` and `start_at` once running) |
| POST | `/api/battles/:id/join\|leave\|start` | ✓ | |
| GET | `/api/market` | | `?q=name&rarity=&idx=&sort=new\|cheap\|dear\|deal&offset=` open listings |
| GET | `/api/market/mine` | ✓ | your listings, open and past |
| POST | `/api/market` | ✓ | `{ item, price }` |
| POST | `/api/market/:id/buy\|cancel` | ✓ | |
| GET | `/api/suggestions` | | `?sort=top\|new` (with a login, says which you voted for) |
| POST | `/api/suggestions` | ✓ | `{ text }` |
| POST | `/api/suggestions/:id/vote\|delete` | ✓ | vote toggles |
| POST | `/api/lock` | ✓ | `{ ids, lock }` → `{ locks }` |
| GET | `/api/rewards` | ✓ | the reward track and your progress |
| POST | `/api/rewards/claim` | ✓ | today's reward |
| GET | `/api/invites` | ✓ | battles you've been invited to |
| POST | `/api/battles/:id/invite\|decline` | ✓ | `{ to }` (invite needs you in the battle) |
| GET | `/api/config` | | `{ announcement, maintenance, version, seasons, season_modes }` |
| POST | `/api/account/password` | ✓ | `{ old, password }` (logs out other devices) |
| POST | `/api/account/logout-all` | ✓ | |
| POST | `/api/admin` | signed or admin account | `{ p: '{"a": action, "n": one-time id, "ts", ...}', g: signature }`, or `{ p }` with an admin account's login |

Admin actions: `stats`, `find {q}`, `player {id}`, `coins {id, delta \| set}`, `give {id, idx, wear, tracker, count}`, `take {id, ids}`, `rename {id, name}`, `ban {id, reason}`, `unban {id}`, `reset {id, password}`, `logout {id}`, `delete {id, confirm}`, `offers`, `cancel_offer {offer}`, `lobbies`, `cancel_lobby {lobby}`, `settings {announcement, maintenance}`, `gifts {gifts}`, `revoke_gift {gift, undo}`, `make_gift {coins, items, message, ttl}`, `devices`, `device {kind, value}`, `ban_device {kind, value, reason, block}`, `block_device {kind, value, reason}`, `unblock_device {kind, value}`, `delete_device {kind, value, confirm}`, `bad_names {mode, confirm}`, `delete_banned {confirm}`, `listings`, `cancel_listing {listing}`, `suggestion {id, status, reply}`, `delete_suggestion {id}`, `rewards {on, title, period, days}` (no fields: read), `login_gift {coins, items, message, ttl}` (no fields: read; `end`: stop), `settings {seasons}`, `log`. Key only: `grant_admin {id}`, `revoke_admin {id}`. `id` can be a player id or a username.

Limits: usernames are 3–16 letters, numbers, `_` or `-` and must pass the name rules, and passwords are 6–72 characters. See **Rate limits** above for the rest. Each account holds up to 3,000 items and can have 20 open offers. Unfilled lobbies close after 15 minutes and refund everyone.
