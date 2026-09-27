# Deployment guide

Everything below uses free tiers: **GitHub** (code + Pages hosting) and **Cloudflare Workers** (API proxy).
Total time: about 20 minutes.

## 0. What you need to install

| Tool | Why | Install |
|---|---|---|
| Git | push the code to GitHub | https://git-scm.com/downloads |
| Node.js 20+ (includes `npm`/`npx`) | run tests, local dev, Wrangler CLI | https://nodejs.org (LTS) |
| GitHub account | repository + Pages | https://github.com/signup |
| Cloudflare account | Worker proxy | https://dash.cloudflare.com/sign-up |

Optional: [GitHub CLI](https://cli.github.com) (`gh`) makes creating the repo a one-liner.

Check the installation:

```bash
git --version
node --version   # v20 or newer
```

## 1. Create the GitHub repository

From the project folder:

```bash
cd fpl-live-league
git init -b main
git add .
git commit -m "Initial commit"
```

Then **either** with GitHub CLI:

```bash
gh auth login
gh repo create fpl-live-league --public --source=. --push
```

**or** manually: create an empty repository named `fpl-live-league` at https://github.com/new
(no README, no .gitignore), then:

```bash
git remote add origin https://github.com/<your-username>/fpl-live-league.git
git push -u origin main
```

> The repository must be **public** for free GitHub Pages (private repos need a paid plan).

## 2. Deploy the Cloudflare Worker

Choose **one** of the two ways.

### 2a. From your computer (simplest)

```bash
cd worker
npx wrangler login          # opens the browser, authorize Wrangler
npx wrangler deploy
```

The output ends with the Worker URL, for example:

```
https://fpl-live-proxy.<your-subdomain>.workers.dev
```

On the first deploy Cloudflare may ask you to choose a `workers.dev` subdomain; pick any name.

Check it works:

```bash
curl https://fpl-live-proxy.<your-subdomain>.workers.dev/health
curl "https://fpl-live-proxy.<your-subdomain>.workers.dev/api/leagues-classic/<league-id>/standings/"
```

### 2b. From GitHub Actions (automatic on every change in `worker/`)

1. Cloudflare dashboard → **My Profile → API Tokens → Create Token** → template
   **"Edit Cloudflare Workers"** → create, copy the token.
2. Cloudflare dashboard → **Workers & Pages** → copy your **Account ID** (right sidebar).
3. GitHub repo → **Settings → Secrets and variables → Actions → New repository secret**:
   - `CLOUDFLARE_API_TOKEN` = the token
   - `CLOUDFLARE_ACCOUNT_ID` = the account ID
4. GitHub repo → **Actions → Deploy Cloudflare Worker → Run workflow**.
   The Worker URL is printed in the job log.

## 3. Point the website at the Worker

GitHub repo → **Settings → Secrets and variables → Actions → Variables tab → New repository variable**:

| Name | Value |
|---|---|
| `WORKER_URL` | `https://fpl-live-proxy.<your-subdomain>.workers.dev` |
| `DEFAULT_LEAGUE_ID` *(optional)* | your league ID, e.g. `123456` |

The Pages workflow writes these into `web/js/config.js` at deploy time, so no secrets end up in the code.

## 4. Enable GitHub Pages

1. GitHub repo → **Settings → Pages**
2. **Build and deployment → Source: GitHub Actions**
3. **Actions → Deploy web app to GitHub Pages → Run workflow** (it also runs automatically on every push that touches `web/`)

Your site is live at:

```
https://<your-username>.github.io/fpl-live-league/
https://<your-username>.github.io/fpl-live-league/?league=<league-id>
```

## 5. (Recommended) Lock the proxy to your site

Edit `worker/wrangler.toml`:

```toml
[vars]
ALLOWED_ORIGIN = "https://<your-username>.github.io,http://localhost:5173"
```

Redeploy the Worker (`npx wrangler deploy` or push to `main` if you use 2b). This stops other websites
from using your proxy from a browser. It does not protect against non-browser clients, but the Worker
only forwards a small whitelist of read-only FPL endpoints anyway.

## 6. (Optional) Custom domain

- **GitHub Pages**: Settings → Pages → Custom domain, then add a `CNAME` DNS record pointing to
  `<your-username>.github.io`.
- **Worker**: Cloudflare dashboard → your Worker → Settings → Domains & Routes (the domain must be on Cloudflare).

Remember to update `WORKER_URL` / `ALLOWED_ORIGIN` if you change either URL.

## Updating

Edit code → `git commit` → `git push`. Workflows redeploy automatically:

| Changed files | Workflow |
|---|---|
| `web/**` | Deploy web app to GitHub Pages |
| `worker/**` | Deploy Cloudflare Worker (only if you set up 2b) |
| anything | Tests |

## Troubleshooting

| Symptom | Fix |
|---|---|
| "WORKER_URL is not configured" | Set the `WORKER_URL` variable (step 3) and re-run the Pages workflow |
| "Cannot reach the proxy" | Wrong `WORKER_URL`, or `ALLOWED_ORIGIN` doesn't include your site's origin (scheme + host, no path) |
| "League … not found" | Wrong ID, or it's a head-to-head league (only classic leagues are supported) |
| 503 / "FPL API unavailable" | FPL is updating (typically around deadlines and after matches); the page keeps the last data and retries |
| 403 from the Worker for every request | FPL occasionally blocks some cloud IP ranges. Wait and retry; if it persists, run the same `worker/src/index.js` on another edge platform (e.g. Deno Deploy) and change `WORKER_URL` |
| Pages shows 404 | Pages source must be **GitHub Actions**, and the repository must be public |
| Numbers differ slightly from the FPL app during matches | Expected: bonus and auto-subs are projections until FPL finalises the gameweek |

## Free-tier limits

- Cloudflare Workers free: 100,000 requests/day. One open page in a live gameweek makes about
  2 requests per minute (plus one request per manager on page load). Many friends with the page open at once is still fine.
- GitHub Pages: 100 GB bandwidth/month soft limit; the site is ~40 KB.
