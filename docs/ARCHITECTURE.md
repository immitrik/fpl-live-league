# Architecture

## Components

| Part | Location | Runs on | Responsibility |
|---|---|---|---|
| Web app | `web/` | GitHub Pages (static) | Fetch data, compute live standings, render UI |
| Scoring engine | `web/js/scoring.js` | Browser + Node tests | Pure functions: bonus, auto-subs, captaincy, league aggregation |
| Proxy | `worker/src/index.js` | Cloudflare Workers | Add CORS headers, whitelist endpoints, edge-cache responses |
| Mock API | `tools/mock-server.js` | Local Node | Offline development |

## FPL endpoints used

| Endpoint | Used for | Proxy cache |
|---|---|---|
| `/api/bootstrap-static/` | players, teams, gameweeks (current GW) | 300 s |
| `/api/leagues-classic/{id}/standings/?page_standings=N` | league members (50 per page) | 120 s |
| `/api/entry/{id}/event/{gw}/picks/` | a manager's 15 picks, captain, chip, hits, totals | 300 s |
| `/api/event/{gw}/live/` | live minutes and points of every player | 30 s |
| `/api/fixtures/?event={gw}` | match status, scores, live BPS table | 30 s |

`/api/entry/{id}/` and `/api/entry/{id}/history/` are also whitelisted for future features.

## Data flow

1. **Page load**: `bootstrap-static` (once) → league standings (paginated, capped at `MAX_MANAGERS`)
   → picks for every manager (`CONCURRENCY` parallel requests).
2. **Every refresh** (60 s while the gameweek is live): `event/{gw}/live` + `fixtures` only.
   Picks can't change after the deadline, so they are not refetched.
3. `buildContext()` indexes players/teams/fixtures and computes provisional bonus;
   `aggregateLeague()` scores each manager and builds the tables.

## Scoring rules

### Player live points
`total_points` from `event/{gw}/live` plus **provisional bonus** for every fixture that has
started but is not `finished` (bonus not yet confirmed), unless the player's `explain` for that
fixture already contains a bonus stat.

Provisional bonus comes from the fixture's `bps` stat (home + away), ranked with official tie rules:

| BPS ranking | Bonus |
|---|---|
| no ties | 3, 2, 1 |
| tie for 1st | 3, 3, 1 |
| tie for 2nd | 3, 2, 2 |
| tie for 3rd | 3, 2, 1, 1 |

### Fixture state per player
- `done`: all of his team's GW fixtures are `finished` or `finished_provisional`
- `live`: a fixture has started and isn't done
- `pending`: nothing started yet
- `blank`: no fixture this gameweek

### Projected auto-subs (not with Bench Boost)
A starter is replaced when he has **0 minutes and all his fixtures are done** (or blank).
Bench players are tried in bench order; a candidate must have played (minutes > 0).
The goalkeeper is only swapped with the bench goalkeeper; outfield swaps must keep a valid formation
(1 GK, ≥ 3 DEF, ≥ 2 MID, ≥ 1 FWD).

### Captaincy
Captain scores ×2 (×3 with Triple Captain). If the captain did not play (0 minutes, fixtures done)
the vice-captain gets the multiplier, provided he is in the final XI and hasn't also failed to play.
A vice whose match is still pending is projected as captain.

### Max possible points
`maxPossiblePoints` takes the 15 squad players' final points and picks the best valid XI
(1 GK, ≥ 3 DEF, ≥ 2 MID, ≥ 1 FWD) with the armband (×2, ×3 with Triple Captain) on its top scorer.
With Bench Boost all 15 count. Hits are not deducted.

### Manager totals
```
prevTotal = entry_history.total_points - (entry_history.points - event_transfers_cost)
net       = liveGwPoints - event_transfers_cost
liveTotal = prevTotal + net
```
When the gameweek is `finished` and `data_checked`, the official `entry_history.points` is used
instead of the projection.

Ranks are computed with ties (equal totals share a rank). Rank movement compares the live rank
with the rank by `prevTotal`.

### League ownership
Over all loaded managers with a team this gameweek:
- **Owned %**: in the 15-man squad
- **Captained %**: effective captain (multiplier > 1)
- **EO %**: sum of final multipliers / managers × 100 (a player captained by everyone and started by everyone = 200%)

## Why this design

- **No backend state**: nothing to store, back up or migrate; the page always reflects FPL.
- **Worker instead of a server**: FPL blocks browser calls via CORS; a Worker is free, fast and
  always on (no cold start sleeping like free PaaS tiers).
- **Client-side fan-out**: each picks request is a separate, cached Worker invocation, which keeps each
  one well under the Workers free-plan limit of 50 subrequests per invocation.
- **Edge caching**: many viewers of the same league share cached upstream responses, so FPL sees
  roughly one request per endpoint per cache window.

## Ideas for extensions

- Head-to-head leagues (`/api/leagues-h2h/{id}/standings/`)
- Transfers made this GW (`/api/entry/{id}/transfers/`) with net points gained
- Season chart per manager from `/api/entry/{id}/history/`
- "Differentials": players with low league EO who are scoring
- Server-side snapshot (Worker Cron Trigger + KV) for very large leagues
