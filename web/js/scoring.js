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
      { id: e.id, name: e.web_name, team: e.team, type: e.element_type },
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
    }
  }

  const history = picksData.entry_history || {};
  if (ctx.eventFinished && typeof history.points === 'number') {
    gwPoints = history.points; // official, fully processed score
  }

  return {
    chip,
    gwPoints,
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
        missing: true,
      });
      continue;
    }
    const score = scoreEntry(picksData, ctx);
    const h = picksData.entry_history || {};
    const prevTotal = (h.total_points ?? 0) - ((h.points ?? 0) - (h.event_transfers_cost ?? 0));
    const net = score.gwPoints - score.hits;
    rows.push({
      entry: s.entry,
      teamName: s.entry_name,
      manager: s.player_name,
      prevTotal,
      liveTotal: prevTotal + net,
      net,
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
          points: p.live.points,
          state: p.state,
          owned: 0,
          started: 0,
          captained: 0,
          multiplierSum: 0,
        });
      }
      const st = stats.get(p.element);
      st.owned++;
      if (p.inXI) st.started++;
      if (p.multiplier > 1) st.captained++;
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
