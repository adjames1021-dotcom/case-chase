# Case Sim

A case-opening game with an inventory, an upgrader, trading, case battles and a global leaderboard.

## ▶ Play: **https://case-sim.pages.dev**

Made by lilbean.

---

## What's in this repo

```
site/                  the game (this folder is what goes live)
  index.html           the whole game in one file
  assets/              optional custom item images
server/                the online server (leaderboard, trades, battles)
scripts/               checks that run before every deploy
.github/workflows/     the automatic deploy
```

| Part | Lives at | Deployed from |
| --- | --- | --- |
| Game | https://case-sim.pages.dev | `site/` |
| Server | https://case-sim-server.caseopeningsim.workers.dev | `server/` |

## How updates work

Push a change to `main`. That can be an edit on GitHub, a push from your computer, or a change Claude makes. GitHub then:

1. **Checks** the game and server for syntax errors and a missing server address. It also checks that the admin private key hasn't slipped into the repo and that players' saves won't be wiped.
2. **Plays the game** in a headless browser: it opens a case, keeps the item, visits every tab and reloads.
3. **Deploys** only what changed. The server goes first, then the game.

If step 1 or 2 fails, **nothing is deployed** and the live site keeps running the last good version. You can see each run under the repo's **Actions** tab. A red ✗ means the update was held back, and clicking it shows why.

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

### Rules that keep updates from breaking things

- **Don't rename the Pages project or change the game's address.** Saves are stored per website address, so a new address starts everyone from zero.
- **Don't change `SAVE_KEY`** in `site/index.html`. The checks block this, because changing it wipes every save.
- **Bump `GAME_VERSION`** when you change cases, items or odds. Online battles only match players on the same version, so rolls line up. Older games are told to update instead of breaking.
- **Only add items and cases at the end of the lists.** Trade codes, online trades and the leaderboard refer to items by their position in the list, so inserting one in the middle would turn existing items into different ones.
- **Database changes go in `server/schema.sql`** and must be safe to run twice (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`). It runs automatically when the file changes.
- **Never commit the admin key** (`ADMK-...`). The checks block it anyway.

### If an update does go wrong

Cloudflare keeps every deploy. In the Cloudflare dashboard, open **Workers & Pages**, then **case-sim**, then **Deployments**. Click ⋯ next to the last good one and choose **Rollback to this deployment**. The server has the same thing under **case-sim-server → Deployments**. Player data stays in the database either way.

## Running things by hand

Deploying by hand works too. You need Node.js and a Cloudflare login (`npx wrangler login`). Run these from the repo root:

```bash
node scripts/check.mjs                                               # the pre-deploy checks
npx wrangler pages deploy site --project-name case-sim --branch main # deploy the game
cd server && npx wrangler deploy                                     # deploy the server
```

To play offline or test locally, open `site/index.html` in a browser. It still connects to the live server. Your save there is separate from the one on the website.

See [`server/README.md`](server/README.md) for how the server works, moderation, free-tier limits and the API.
