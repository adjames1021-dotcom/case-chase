# Case Sim

A case-opening game with an inventory, an upgrader, trading, case battles and a global leaderboard.

## ▶ Play: **https://case-sim.pages.dev**

Make an account (a username and password) to keep your coins and items in the cloud, play from any device, trade with other players, join online battles and get on the leaderboard. Or play as a guest: everything stays on your device, with no trading or leaderboard.

Made by lilbean.

---

## What's in this repo

```
site/                  the game (this folder is what goes live)
  index.html           the whole game in one file; its CORE block holds the rules
  assets/              optional custom item images
server/                the account server: logins, inventories, trades, battles
functions/             runs the server on the site itself, under /api
wrangler.toml          the Pages site's settings (database, admin key)
scripts/
  check.mjs            pre-deploy checks
  smoke.mjs            plays the game in a headless browser
  api-test.mjs         tests the server: accounts, cases, trades, battles, gifts
  sync-core.mjs        copies the game's CORE block to the server
  item-order.json      the saved order of every item (see the rules below)
.github/workflows/     the automatic tests and deploy
```

Everything is one website:

| Part | Lives at | Deployed from |
| --- | --- | --- |
| Game | https://case-sim.pages.dev | `site/` |
| Server | https://case-sim.pages.dev/api | `server/`, run by `functions/` |

The game only ever talks to its own site. A copy opened from a file talks to `case-sim.pages.dev`.

## How updates work

Push a change to `main`. That can be an edit on GitHub, a push from your computer, or a change Claude makes. GitHub then:

1. **Checks** the game and server for mistakes: syntax errors, a missing server address, items moved out of their saved order, rules the server can't run, and a leaked admin private key.
2. **Plays the game** in a headless browser as a guest: it opens a case, keeps the item, visits every tab and reloads.
3. **Tests the server** on a private copy. It makes accounts, opens cases, sells, upgrades, trades, runs battles and races requests against each other, then checks that every coin and item ends up where it should.
4. **Deploys** only what changed. The server goes first, then the game.

If step 1, 2 or 3 fails, **nothing is deployed** and the live site keeps running the last good version. You can see each run under the repo's **Actions** tab. A red ✗ means the update was held back, and clicking it shows why.

### One-time setup: let GitHub deploy for you

GitHub needs a Cloudflare API token before it can deploy. Until you add one, the checks still run but nothing gets deployed.

1. Go to <https://dash.cloudflare.com/profile/api-tokens>, click **Create Token**, then **Create Custom Token** (at the bottom).
2. Name it `case-sim deploy` and add these permissions:

   | | | |
   | --- | --- | --- |
   | Account | Cloudflare Pages | Edit |
   | Account | Workers Scripts | Edit |
   | Account | D1 | Edit |
   | Account | Account Settings | Read |
   | User | User Details | Read |

   Leave **Account Resources** on "Include · All accounts" (or pick your account), then click **Continue to summary** and **Create Token**. Copy the token. Cloudflare only shows it once.
3. In this repo, go to **Settings → Secrets and variables → Actions → New repository secret**.
   - Name: `CLOUDFLARE_API_TOKEN`
   - Secret: paste the token
4. Go to **Actions → Check and deploy → Run workflow** to test it. When it goes green, you're set.
5. Optional: add a second secret, `ADMIN_KEY`, set to your `ADMK-...` admin key. The server tests will then also cover gift codes and moderation. GitHub keeps secrets hidden and never shows them in logs.

### Rules that keep updates from breaking things

- **Don't rename the Pages project or change the game's address.** Saves are stored per website address, so a new address starts everyone from zero.
- **Don't change `SAVE_KEY`** in `site/index.html`. The checks block this, because changing it wipes every guest save.
- **Game rules live in the CORE block** of `site/index.html` (between `CORE:BEGIN` and `CORE:END`). The server runs a copy of that block, so a change there changes what accounts roll. Keep page code (anything touching the screen) out of it; the checks enforce this.
- **Bump `GAME_VERSION`** when you change cases, items or odds. Battles only run between games on the server's version, and older games are told to update.
- **Never reorder, rename or remove items.** Every saved item points at its position in the item list. The checks compare against `scripts/item-order.json` and block any change that would turn existing items into different ones. To add an item to any case, give it the current `GAME_VERSION` as a fifth value, for example `I('KR-74 | Nightfall', 'rifle_ak', 'rare', 30, 2)`. Items marked like that are listed after every older item, so nothing moves. New cases go at the end of `CASES`, with their items marked the same way. Then run `node scripts/check.mjs --update-order` to save the new order.
- **Database changes go in `server/schema.sql`** and must be safe to run twice (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`). It runs automatically when the file changes.
- **Never commit the admin key** (`ADMK-...`). The checks block it anyway.

### If an update does go wrong

Cloudflare keeps every deploy. In the Cloudflare dashboard, open **Workers & Pages**, then **case-sim**, then **Deployments**. Click ⋯ next to the last good one and choose **Rollback to this deployment**. That rolls back the server too, since it's part of the site. Player data stays in the database either way.

## Running things by hand

Deploying by hand works too. You need Node.js and a Cloudflare login (`npx wrangler login`). Run these from the repo root:

```bash
node scripts/check.mjs                                               # the pre-deploy checks
node scripts/sync-core.mjs                                           # copy the game's rules for the server
npx wrangler pages deploy site --project-name case-sim --branch main # deploy the site and its server
```

To run the whole thing on your computer: `npx wrangler d1 execute case-sim --local --file server/schema.sql`, then `npx wrangler pages dev`. Open http://127.0.0.1:8788, and the game talks to the server on that same address.

To play from the file, open `site/index.html` in a browser. Accounts work there too, because it connects to the live server. Guest progress in the file is separate from guest progress on the website.

See [`server/README.md`](server/README.md) for how the server works, moderation, free-tier limits and the API.
