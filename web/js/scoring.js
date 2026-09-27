// Pure scoring logic: no DOM, no network. Runs in the browser and in Node tests.

export const POSITIONS = { 1: 'GKP', 2: 'DEF', 3: 'MID', 4: 'FWD' };

export const CHIP_LABELS = {
  bboost: 'BB',
  '3xc': 'TC',
  freehit: 'FH',
  wildcard: 'WC',
  manager: 'AM',
};

/**
 * Official FPL bonus allocation from a list of { element, value } BPS entries.
 * Ties share the higher reward and consume the following places:
 *   tie for 1st -> 3,3,1 ; tie for 2nd -> 3,2,2 ; tie for 3rd -> 3,2,1,1
 * @returns {Map<number, number>} element id -> bonus points
 */
export function computeBonus(bpsEntries) {
  const sorted = [...bpsEntries].sort((a, b) => b.value - a.value);
  const bonus = new Map();
  let place = 0;
  let i = 0;
  while (i < sorted.length && place < 3) {
    let j = i;
    while (j < sorted.length && sorted[j].value === sorted[i].value) j++;
    const pts = 3 - place;
    for (let k = i; k < j; k++) bonus.set(sorted[k].element, pts);
    place += j - i;
    i = j;
  }
  return bonus;
}

/**
 * Build a lookup context for one gameweek.
 * @param {object} bootstrap  /api/bootstrap-static/
 * @param {object} live       /api/event/{gw}/live/
 * @param {Array}  fixtures   /api/fixtures/?event={gw}
 * @param {number} gw
 */
export function buildContext(bootstrap, live, fixtures, gw) {
  const players = new Map(
    bootstrap.elements.map((e) => [
      e.id,
      { id: e.id, name: e.web_name, team: e.team, type: e.element_type, price: e.now_cost || 0 },
    ]),
  );
  const teams = new Map(
    bootstrap.teams.map((t) => [t.id, { id: t.id, name: t.name, short: t.short_name }]),
  );
  const event = bootstrap.events.find((e) => e.id === gw) || null;

  const gwFixtures = fixtures.filter((f) => f.event === gw);
  const fixturesByTeam = new Map();
  for (const f of gwFixtures) {
    for (const team of [f.team_h, f.team_a]) {
      if (!fixturesByTeam.has(team)) fixturesByTeam.set(team, []);
      fixturesByTeam.get(team).push(f);
    }
  }

  // Provisional bonus for matches whose bonus has not been confirmed yet.
  const bonusByFixture = new Map();
  for (const f of gwFixtures) {
    if (!f.started || f.finished) continue;
    const bps = (f.stats || []).find((s) => s.identifier === 'bps');
    if (bps) bonusByFixture.set(f.id, computeBonus([...(bps.h || []), ...(bps.a || [])]));
  }

  const liveById = new Map();
  for (const el of live.elements || []) {
    const info = players.get(el.id);
    let provisionalBonus = 0;
    for (const f of (info && fixturesByTeam.get(info.team)) || []) {
      const table = bonusByFixture.get(f.id);
      if (!table || !table.has(el.id)) continue;
      const explain = (el.explain || []).find((x) => x.fixture === f.id);
      const confirmed = explain?.stats?.some((s) => s.identifier === 'bonus' && s.value > 0);
      if (!confirmed) provisionalBonus += table.get(el.id);
    }
    liveById.set(el.id, {
      minutes: el.stats?.minutes || 0,
      basePoints: el.stats?.total_points || 0,
      provisionalBonus,
      points: (el.stats?.total_points || 0) + provisionalBonus,
    });
  }

  /** 'blank' | 'done' | 'live' | 'pending' for a player's team this gameweek. */
  function fixtureState(elementId) {
    const info = players.get(elementId);
    const fx = (info && fixturesByTeam.get(info.team)) || [];
    if (fx.length === 0) return 'blank';
    const isDone = (f) => f.finished || f.finished_provisional;
    if (fx.every(isDone)) return 'done';
    if (fx.some((f) => f.started && !isDone(f))) return 'live';
    return 'pending';
  }

  return {
    gw,
    event,
    eventFinished: Boolean(event?.finished && event?.data_checked),
    players,
    teams,
    fixtures: gwFixtures,
    fixturesByTeam,
    liveById,
    fixtureState,
  };
}

const EMPTY_LIVE = { minutes: 0, basePoints: 0, provisionalBonus: 0, points: 0 };

function validFormation(xi) {
  const count = { 1: 0, 2: 0, 3: 0, 4: 0 };
  for (const p of xi) count[p.type] = (count[p.type] || 0) + 1;
  return count[1] === 1 && count[2] >= 3 && count[3] >= 2 && count[4] >= 1;
}

/**
 * Score one manager's gameweek with projected auto-subs and provisional bonus.
 * @param {object} picksData /api/entry/{id}/event/{gw}/picks/
 * @param {object} ctx       from buildContext
 */
export function scoreEntry(picksData, ctx) {
  const chip = picksData.active_chip || null;
  const picks = [...picksData.picks]
    .filter((p) => p.position <= 15)
    .sort((a, b) => a.position - b.position)
    .map((p) => {
      const info = ctx.players.get(p.element);
      return {
        element: p.element,
        position: p.position,
        isCaptain: p.is_captain,
        isVice: p.is_vice_captain,
        name: info?.name ?? `#${p.element}`,
        type: info?.type ?? 0,
        team: info?.team ?? 0,
        price: info?.price ?? 0,
        live: ctx.liveById.get(p.element) || EMPTY_LIVE,
        state: ctx.fixtureState(p.element),
      };
    });

  const didNotPlay = (p) =>
    p.live.minutes === 0 && (p.state === 'done' || p.state === 'blank');

  let xi = picks.filter((p) => p.position <= 11);
  const subs = [];

  if (chip === 'bboost') {
    xi = picks.slice();
  } else {
    const bench = picks.filter((p) => p.position > 11);
    for (let i = 0; i < xi.length; i++) {
      const starter = xi[i];
      if (!didNotPlay(starter)) continue;
      for (let j = 0; j < bench.length; j++) {
        const cand = bench[j];
        if (!(cand.live.minutes > 0)) continue;
        const starterGK = starter.type === 1;
        if (starterGK !== (cand.type === 1)) continue;
        const trial = xi.slice();
        trial[i] = cand;
        if (!starterGK && !validFormation(trial)) continue;
        xi = trial;
        bench.splice(j, 1);
        subs.push({ out: starter.element, in: cand.element });
        break;
      }
    }
  }

  const captain = picks.find((p) => p.isCaptain) || null;
  const vice = picks.find((p) => p.isVice) || null;
  const captainMultiplier = chip === '3xc' ? 3 : 2;
  const captainOut = !captain || !xi.includes(captain) || didNotPlay(captain);
  let effectiveCaptain = captain;
  if (captainOut) {
    // A vice whose match is still pending is projected as captain until proven otherwise.
    effectiveCaptain = vice && xi.includes(vice) && !didNotPlay(vice) ? vice : null;
  }

  let gwPoints = 0;
  let benchPoints = 0;
  const counts = { done: 0, live: 0, pending: 0 };
  for (const p of picks) {
    p.inXI = xi.includes(p);
    p.subIn = subs.some((s) => s.in === p.element);
    p.subOut = subs.some((s) => s.out === p.element);
    p.multiplier = !p.inXI ? 0 : p === effectiveCaptain ? captainMultiplier : 1;
    p.total = p.live.points * p.multiplier;
    gwPoints += p.total;
    if (p.inXI) {
      if (p.state === 'live') counts.live++;
      else if (p.state === 'pending') counts.pending++;
      else counts.done++;
    } else {
      benchPoints += p.live.points;
    }
  }

  const history = picksData.entry_history || {};
  if (ctx.eventFinished && typeof history.points === 'number') {
    gwPoints = history.points; // official, fully processed score
  }

  return {
    chip,
    gwPoints,
    benchPoints,
    hits: history.event_transfers_cost || 0,
    transfers: history.event_transfers || 0,
    captain: captain?.element ?? null,
    vice: vice?.element ?? null,
    effectiveCaptain: effectiveCaptain?.element ?? null,
    subs,
    counts,
    picks,
  };
}

function assignRanks(rows, key) {
  const sorted = [...rows].sort((a, b) => b[key] - a[key]);
  let rank = 0;
  sorted.forEach((row, i) => {
    if (i === 0 || row[key] !== sorted[i - 1][key]) rank = i + 1;
    row[`${key}Rank`] = rank;
  });
}

/**
 * Aggregate a classic league.
 * @param {Array} standings  results[] from /leagues-classic/{id}/standings/
 * @param {Map<number, object|null>} picksByEntry entry id -> picks response (null if unavailable)
 * @param {object} ctx
 */
export function aggregateLeague(standings, picksByEntry, ctx) {
  const rows = [];
  for (const s of standings) {
    const picksData = picksByEntry.get(s.entry);
    if (!picksData) {
      rows.push({
        entry: s.entry,
        teamName: s.entry_name,
        manager: s.player_name,
        prevTotal: s.total,
        liveTotal: s.total,
        net: 0,
        benchPoints: 0,
        squadValue: 0,
        missing: true,
      });
      continue;
    }
    const score = scoreEntry(picksData, ctx);
    const h = picksData.entry_history || {};
    const prevTotal = (h.total_points ?? 0) - ((h.points ?? 0) - (h.event_transfers_cost ?? 0));
    const net = score.gwPoints - score.hits;
    const squadValue = score.picks.reduce((sum, p) => sum + (p.price || 0), 0);
    rows.push({
      entry: s.entry,
      teamName: s.entry_name,
      manager: s.player_name,
      prevTotal,
      liveTotal: prevTotal + net,
      net,
      squadValue,
      ...score,
    });
  }

  assignRanks(rows, 'prevTotal');
  assignRanks(rows, 'liveTotal');
  for (const r of rows) r.rankChange = r.prevTotalRank - r.liveTotalRank;
  rows.sort((a, b) => a.liveTotalRank - b.liveTotalRank || b.net - a.net);

  // League ownership / captaincy / effective ownership.
  const scored = rows.filter((r) => !r.missing);
  const n = scored.length || 1;
  const stats = new Map();
  for (const r of scored) {
    for (const p of r.picks) {
      if (!stats.has(p.element)) {
        stats.set(p.element, {
          element: p.element,
          name: p.name,
          team: p.team,
          type: p.type,
          price: p.price,
          points: p.live.points,
          state: p.state,
          owned: 0,
          started: 0,
          captained: 0,
          captainMultiplier: 0,
          multiplierSum: 0,
        });
      }
      const st = stats.get(p.element);
      st.owned++;
      if (p.inXI) st.started++;
      if (p.multiplier > 1) {
        st.captained++;
        st.captainMultiplier = Math.max(st.captainMultiplier, p.multiplier);
      }
      st.multiplierSum += p.multiplier;
    }
  }
  const players = [...stats.values()]
    .map((s) => ({
      ...s,
      ownedPct: (s.owned / n) * 100,
      captainedPct: (s.captained / n) * 100,
      eoPct: (s.multiplierSum / n) * 100,
    }))
    .sort((a, b) => b.eoPct - a.eoPct || b.points - a.points);

  return { rows, players, managers: scored.length };
}

// ---------------------------------------------------------------- dashboard extras

/** Group a list by element_type (1..4) and keep the top N by keyFn, extending the
 *  cut-off to include ties with the last qualifying value. */
function topByPosition(list, keyFn, take) {
  const byPos = { 1: [], 2: [], 3: [], 4: [] };
  for (const p of list) byPos[p.type]?.push(p);
  const result = {};
  for (const type of [1, 2, 3, 4]) {
    const sorted = [...byPos[type]].sort((a, b) => keyFn(b) - keyFn(a));
    const cutValue = sorted[take - 1] ? keyFn(sorted[take - 1]) : null;
    result[type] = cutValue === null ? sorted : sorted.filter((p, i) => i < take || keyFn(p) === cutValue);
  }
  return result;
}

/** Top 3 most-owned players per position. */
export function mostPopularByPosition(players) {
  return topByPosition(
    players.filter((p) => p.owned > 0),
    (p) => p.owned,
    3,
  );
}

/** Top 3 point-scorers per position this gameweek (ties at the cut-off included). */
export function mostValuableByPosition(players) {
  return topByPosition(
    players.filter((p) => p.owned > 0),
    (p) => p.points,
    3,
  );
}

/** Distribution of the (effective) captain armband across the league. */
export function captainDistribution(rows) {
  const scored = rows.filter((r) => !r.missing);
  const n = scored.length || 1;
  const counts = new Map();
  for (const r of scored) {
    const cap = r.effectiveCaptain ?? r.captain;
    if (!cap) continue;
    counts.set(cap, (counts.get(cap) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([element, count]) => ({ element, count, pct: (count / n) * 100 }))
    .sort((a, b) => b.count - a.count);
}

/** Differentials: started by 1-2 managers and scored more than 6 points this GW. */
export function differentials(players, { maxOwners = 2, minPoints = 6 } = {}) {
  return players
    .filter((p) => p.started >= 1 && p.started <= maxOwners && p.points > minPoints)
    .sort((a, b) => b.points - a.points);
}

/** Aggregate the current gameweek's transfers across the league. */
export function aggregateTransfers(transfersByEntry, gw, ctx) {
  const inCounts = new Map();
  const outCounts = new Map();
  const events = [];
  for (const [entry, list] of transfersByEntry) {
    if (!list) continue;
    for (const t of list) {
      if (t.event !== gw) continue;
      inCounts.set(t.element_in, (inCounts.get(t.element_in) || 0) + 1);
      outCounts.set(t.element_out, (outCounts.get(t.element_out) || 0) + 1);
      events.push({
        entry,
        elementIn: t.element_in,
        elementOut: t.element_out,
        pointsIn: ctx.liveById.get(t.element_in)?.points ?? 0,
        pointsOut: ctx.liveById.get(t.element_out)?.points ?? 0,
      });
    }
  }
  for (const e of events) e.delta = e.pointsIn - e.pointsOut;
  const toList = (map) =>
    [...map.entries()]
      .map(([element, count]) => ({ element, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

  const byEntry = new Map();
  for (const e of events) {
    const cur = byEntry.get(e.entry) || { entry: e.entry, delta: 0, count: 0 };
    cur.delta += e.delta;
    cur.count++;
    byEntry.set(e.entry, cur);
  }

  const best = [...events].sort((a, b) => b.delta - a.delta).slice(0, 3);
  const worst = [...events].sort((a, b) => a.delta - b.delta).slice(0, 3);

  return {
    mostBought: toList(inCounts),
    mostSold: toList(outCounts),
    best,
    worst,
    byEntry: [...byEntry.values()],
    count: events.length,
  };
}

/** Highest and lowest total squad value (all 15 picks) across the league this GW. */
export function teamValueExtremes(rows) {
  const scored = rows.filter((r) => !r.missing);
  if (!scored.length) return null;
  const withValue = scored.map((r) => ({
    entry: r.entry,
    teamName: r.teamName,
    manager: r.manager,
    value: r.squadValue,
  }));
  return {
    best: withValue.reduce((a, r) => (r.value > a.value ? r : a)),
    worst: withValue.reduce((a, r) => (r.value < a.value ? r : a)),
  };
}

/** Best and worst manager this gameweek by net points swing from their own transfers (hits included). */
export function managerTransferExtremes(byEntry, rows) {
  if (!byEntry.length) return null;
  const rowsByEntry = new Map(rows.map((r) => [r.entry, r]));
  const withNet = byEntry.map((e) => {
    const row = rowsByEntry.get(e.entry);
    return {
      entry: e.entry,
      teamName: row?.teamName,
      manager: row?.manager,
      transfers: e.count,
      delta: e.delta,
      hits: row?.hits || 0,
      net: e.delta - (row?.hits || 0),
    };
  });
  return {
    best: withNet.reduce((a, r) => (r.net > a.net ? r : a)),
    worst: withNet.reduce((a, r) => (r.net < a.net ? r : a)),
  };
}

// ---------------------------------------------------------------- team of the week

const TOTW_FORMATIONS = [
  [3, 4, 3], [3, 5, 2],
  [4, 3, 3], [4, 4, 2], [4, 5, 1],
  [5, 2, 3], [5, 3, 2], [5, 4, 1],
];
const TOTW_BUDGET = 1000; // tenths of a million, matches FPL `now_cost`
const TOTW_MAX_PER_CLUB = 3;

/** dp[k][b] = max points choosing exactly k items with total cost <= b. */
function knapsackValues(items, maxK, maxBudget) {
  const NEG = -Infinity;
  const dp = Array.from({ length: maxK + 1 }, () => new Float64Array(maxBudget + 1).fill(NEG));
  dp[0].fill(0);
  for (const it of items) {
    for (let k = Math.min(maxK, items.length); k >= 1; k--) {
      const prev = dp[k - 1];
      const cur = dp[k];
      for (let b = maxBudget; b >= it.cost; b--) {
        const v = prev[b - it.cost];
        if (v !== NEG && v + it.points > cur[b]) cur[b] = v + it.points;
      }
    }
  }
  return dp;
}

/** Best achievable value combining two independent knapsack value rows over a shared budget. */
function convolveMax(a, b) {
  const n = a.length;
  const out = new Float64Array(n).fill(-Infinity);
  for (let i = 0; i < n; i++) {
    if (a[i] === -Infinity) continue;
    for (let j = 0; j <= n - 1 - i; j++) {
      if (b[j] === -Infinity) continue;
      const v = a[i] + b[j];
      if (v > out[i + j]) out[i + j] = v;
    }
  }
  return out;
}

/**
 * Reconstructs the exact item set achieving dp[k][maxBudget] for a single position pool.
 * Keeps a full before/after snapshot per item (rather than a single rolling table with
 * "last item that touched this cell" pointers) so backtracking can't double-pick an item:
 * a rolling table can't tell whether a later item's update to a *different* cell also
 * happens to reuse the same item this cell's chain already used.
 */
function knapsackReconstruct(items, k, maxBudget) {
  if (k === 0) return { value: 0, items: [] };
  const NEG = -Infinity;
  const makeLayer = () => Array.from({ length: k + 1 }, () => new Float64Array(maxBudget + 1).fill(NEG));

  let before = makeLayer();
  before[0].fill(0);
  const history = [before];

  for (const it of items) {
    const after = before.map((row) => row.slice());
    for (let c = k; c >= 1; c--) {
      const prevRow = before[c - 1];
      const curRow = after[c];
      for (let b = maxBudget; b >= it.cost; b--) {
        const v = prevRow[b - it.cost];
        if (v !== NEG && v + it.points > curRow[b]) curRow[b] = v + it.points;
      }
    }
    history.push(after);
    before = after;
  }

  const finalValue = history[items.length][k][maxBudget];
  const picked = [];
  let c = k;
  let b = maxBudget;
  for (let t = items.length; t >= 1 && c > 0; t--) {
    if (history[t][c][b] !== history[t - 1][c][b]) {
      const it = items[t - 1];
      picked.push(it);
      b -= it.cost;
      c--;
    }
  }
  return { value: finalValue === NEG ? 0 : finalValue, items: picked };
}

/**
 * Best single replacement for `type`, excluding `exclude` elements and any club that would
 * hit (or stay over) the 3-per-club cap once this player joins -- not just clubs already
 * *over* the cap, otherwise swapping one violation away just recreates it at a club that was
 * sitting exactly at 3, and the repair loop oscillates forever between the two clubs.
 */
function bestReplacement(pool, type, exclude, budget, byClub) {
  const candidates = pool[type].filter(
    (p) => !exclude.has(p.element) && (byClub.get(p.team) || 0) < TOTW_MAX_PER_CLUB && p.cost <= budget,
  );
  if (!candidates.length) return null;
  return candidates.reduce((a, p) => (p.points > a.points ? p : a));
}

/** Swap out over-the-cap club players for the best legal alternative until the 3-per-club rule holds. */
function repairClubLimits(team, pool) {
  let guard = 0;
  while (guard++ < 40) {
    const byClub = new Map();
    for (const p of team) byClub.set(p.team, (byClub.get(p.team) || 0) + 1);
    const offendingEntries = [...byClub.entries()].filter(([, n]) => n > TOTW_MAX_PER_CLUB);
    if (!offendingEntries.length) break;

    // Try every offender (lowest points first, within each offending club) until one has a
    // legal replacement -- the single lowest scorer overall may have no swap available (wrong
    // type / no budget) while a different offender does.
    let swapped = false;
    for (const [club] of offendingEntries) {
      const offenders = team.filter((p) => p.team === club).sort((a, b) => a.points - b.points);
      for (const victim of offenders) {
        const usedCost = team.reduce((s, p) => s + p.cost, 0);
        const budget = TOTW_BUDGET - usedCost + victim.cost;
        const exclude = new Set(team.map((p) => p.element));
        const replacement = bestReplacement(pool, victim.type, exclude, budget, byClub);
        if (!replacement) continue;
        team[team.indexOf(victim)] = replacement;
        swapped = true;
        break;
      }
      if (swapped) break;
    }
    if (!swapped) break; // no legal swap found anywhere; leave the (rare) violation in place
  }
  return team;
}

/**
 * Build the league's "team of the week": the highest-scoring legal XI (formation,
 * budget <= 100.0m, max 3 per club) drawn only from players who started for at
 * least one manager, captained by whoever the league actually made captain.
 */
export function buildTeamOfTheWeek(players) {
  const pool = { 1: [], 2: [], 3: [], 4: [] };
  for (const p of players) {
    if (p.started < 1) continue;
    pool[p.type]?.push({
      element: p.element,
      name: p.name,
      team: p.team,
      type: p.type,
      cost: p.price || 0,
      points: p.points,
      owned: p.started,
      captained: p.captained,
      captainMultiplier: p.captainMultiplier || 0,
    });
  }
  if (!pool[1].length || pool[2].length < 3 || pool[3].length < 2 || pool[4].length < 1) return null;

  const gkTable = knapsackValues(pool[1], 1, TOTW_BUDGET);
  const defTable = knapsackValues(pool[2], 5, TOTW_BUDGET);
  const midTable = knapsackValues(pool[3], 5, TOTW_BUDGET);
  const fwdTable = knapsackValues(pool[4], 3, TOTW_BUDGET);

  let formation = null;
  let bestValue = -Infinity;
  for (const [d, m, f] of TOTW_FORMATIONS) {
    if (pool[2].length < d || pool[3].length < m || pool[4].length < f) continue;
    let combo = convolveMax(gkTable[1], defTable[d]);
    combo = convolveMax(combo, midTable[m]);
    combo = convolveMax(combo, fwdTable[f]);
    const value = combo[TOTW_BUDGET];
    if (value > bestValue) {
      bestValue = value;
      formation = [d, m, f];
    }
  }
  if (!formation) return null;
  const [d, m, f] = formation;

  const gk = knapsackReconstruct(pool[1], 1, TOTW_BUDGET).items;
  const budgetLeft = TOTW_BUDGET - gk.reduce((s, p) => s + p.cost, 0);
  const defT = knapsackValues(pool[2], d, budgetLeft);
  const midT = knapsackValues(pool[3], m, budgetLeft);
  const fwdT = knapsackValues(pool[4], f, budgetLeft);

  let split = null;
  let splitValue = -Infinity;
  for (let bd = 0; bd <= budgetLeft; bd++) {
    const vd = defT[d][bd];
    if (vd === -Infinity) continue;
    for (let bm = 0; bm <= budgetLeft - bd; bm++) {
      const vm = midT[m][bm];
      if (vm === -Infinity) continue;
      const bf = budgetLeft - bd - bm;
      const vf = fwdT[f][bf];
      if (vf === -Infinity) continue;
      const total = vd + vm + vf;
      if (total > splitValue) {
        splitValue = total;
        split = [bd, bm, bf];
      }
    }
  }
  if (!split) return null;
  const [bd, bm, bf] = split;

  let team = [
    ...gk,
    ...knapsackReconstruct(pool[2], d, bd).items,
    ...knapsackReconstruct(pool[3], m, bm).items,
    ...knapsackReconstruct(pool[4], f, bf).items,
  ];
  team = repairClubLimits(team, pool);

  const eligibleCaptains = team.filter((p) => p.captained > 0);
  const captainBonus = (p) => p.points * ((p.captainMultiplier || 2) - 1);
  const captain = eligibleCaptains.length
    ? eligibleCaptains.reduce((a, p) => (captainBonus(p) > captainBonus(a) ? p : a))
    : null;
  const captainMultiplier = captain ? captain.captainMultiplier || 2 : null;

  const baseTotal = team.reduce((s, p) => s + p.points, 0);
  const totalPoints = captain ? baseTotal + captainBonus(captain) : baseTotal;
  const cost = team.reduce((s, p) => s + p.cost, 0);

  return {
    formation: `${d}-${m}-${f}`,
    captainMultiplier,
    gk: team.filter((p) => p.type === 1),
    def: team.filter((p) => p.type === 2),
    mid: team.filter((p) => p.type === 3),
    fwd: team.filter((p) => p.type === 4),
    captain: captain?.element ?? null,
    totalPoints,
    cost,
  };
}
