# FPL Live League

A lightweight, self-hosted alternative to [livefpl.net](https://www.livefpl.net) for **one mini-league**:
live Fantasy Premier League standings with provisional bonus, projected auto-subs, captaincy,
chips, transfer hits and league ownership, straight from the official FPL API to a web page.
No database and no spreadsheet in between.

## Features

- **Live league table**: live GW points, live total, live rank and rank movement since the start of the gameweek
- **Provisional bonus** from the live BPS table (official tie rules), dropped automatically once FPL confirms bonus
- **Projected auto-subs** (goalkeeper only for goalkeeper, formation rules: 1 GK / ≥3 DEF / ≥2 MID / ≥1 FWD)
- **Captaincy**: vice-captain takes the armband if the captain doesn't play; Triple Captain supported
- **Chips**: Bench Boost, Triple Captain, Free Hit, Wildcard shown per manager
- **Transfer hits** subtracted from the live total
- **Players progress**: finished / playing now / yet to play for every team
- **Team drill-down**: tap a manager to see all 15 picks with minutes, points and bonus
- **League ownership**: owned %, captained % and effective ownership (EO) within the league
- **Live fixtures strip** with scores and match minute
- Past gameweeks can be viewed via the GW selector
- Auto-refresh every 60 seconds during a live gameweek; mobile friendly with a dark theme

## How it works

```
 Browser (GitHub Pages)              Cloudflare Worker                 FPL API
┌────────────────────────┐  HTTPS  ┌──────────────────────┐  HTTPS  ┌──────────────────────────┐
│ web/ static app        │ ──────► │ worker/ CORS proxy    │ ──────► │ fantasy.premierleague.com │
│ - loads league + picks │ ◄────── │ - path whitelist      │ ◄────── │ /api/...                  │
│ - computes live table  │  JSON   │ - edge cache 30-600s  │  JSON   └──────────────────────────┘
└────────────────────────┘         └──────────────────────┘
```

The FPL API does not send CORS headers, so a browser cannot call it directly. A tiny Cloudflare
Worker (free plan is enough) forwards whitelisted read-only requests and caches them at the edge.
All scoring happens in the browser (`web/js/scoring.js`), so there is no server to maintain.

On page load the app fetches the league standings and each manager's picks once, then refreshes
only two endpoints (`event/{gw}/live` and `fixtures`) every minute, which keeps the load small.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the endpoints and scoring rules.

## Quick start (local)

Requirements: [Node.js](https://nodejs.org) 20+ and Git.

```bash
git clone https://github.com/<your-username>/fpl-live-league.git
cd fpl-live-league

# Option A: fully offline with mock data
npm run dev:mock        # mock FPL API on http://localhost:8787
npm run dev:web         # web app on http://localhost:5173
# open http://localhost:5173/?league=1

# Option B: real FPL data through the Worker running locally
npm run dev:worker      # Cloudflare Worker on http://localhost:8787
npm run dev:web
# open http://localhost:5173/?league=<your league id>
```

When the page is served from `localhost` it automatically uses `http://localhost:8787` as the proxy.

Run the tests:

```bash
npm test
```

## Deploy (free)

1. Deploy the Worker to Cloudflare, which gives you `https://fpl-live-proxy.<you>.workers.dev`
2. Set the `WORKER_URL` repository variable on GitHub
3. Enable GitHub Pages (source: GitHub Actions); the site is published at `https://<you>.github.io/fpl-live-league/`

Full step-by-step guide: **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**.

## Usage

- `https://<you>.github.io/fpl-live-league/?league=123456` opens a league directly
- `&gw=7` opens a specific gameweek
- Set the `DEFAULT_LEAGUE_ID` repository variable (or edit `web/js/config.js`) to open your league by default

Finding your league ID: open the league on the FPL website; the number in the URL
`https://fantasy.premierleague.com/leagues/123456/standings/c` is the ID. The input form also accepts the full URL.

## Configuration

`web/js/config.js`:

| Setting | Default | Meaning |
|---|---|---|
| `WORKER_URL` | injected at deploy | Base URL of your Worker |
| `DEFAULT_LEAGUE_ID` | `null` | League opened without `?league=` |
| `MAX_MANAGERS` | `50` | Only the top N managers are loaded (one request each) |
| `REFRESH_SECONDS` | `60` | Auto-refresh interval during a live gameweek |
| `CONCURRENCY` | `6` | Parallel requests when loading picks |

`worker/wrangler.toml`: `ALLOWED_ORIGIN` restricts which sites may use your proxy
(for example `https://<you>.github.io,http://localhost:5173`).

## Project structure

```
fpl-live-league/
├── web/                      # static site (GitHub Pages)
│   ├── index.html
│   ├── css/style.css
│   └── js/
│       ├── config.js         # settings
│       ├── api.js            # calls to the Worker
│       ├── scoring.js        # live points, bonus, auto-subs, league aggregation (pure functions)
│       └── app.js            # UI
├── worker/                   # Cloudflare Worker (CORS proxy + cache)
│   ├── src/index.js
│   └── wrangler.toml
├── tests/scoring.test.js     # node --test
├── tools/mock-server.js      # offline mock FPL API
├── docs/
│   ├── DEPLOYMENT.md
│   └── ARCHITECTURE.md
└── .github/workflows/        # tests, Pages deploy, Worker deploy
```

## Limitations

- Classic leagues only (head-to-head leagues use a different endpoint)
- Live values are projections until FPL finishes processing the gameweek; once it is marked
  finished and checked, the official score is used
- Very large leagues are capped at `MAX_MANAGERS`, and ranks are then relative to the loaded managers
- The FPL API is unofficial and undocumented; it can change between seasons or be briefly unavailable
  while "the game is being updated"

## License

MIT. Not affiliated with the Premier League or Fantasy Premier League.
