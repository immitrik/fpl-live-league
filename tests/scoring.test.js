import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeBonus, buildContext, scoreEntry, aggregateLeague, buildTeamOfTheWeek } from '../web/js/scoring.js';

// ---------- helpers ----------
// Squad: GK 1, DEF 2-5, MID 6-9, FWD 10-11 as starters; bench GK 12, DEF 13, MID 14, FWD 15.
// Every player's id == his squad position; each player is on his own team so fixtures can differ.
const TYPES = [1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 1, 2, 3, 4];

function bootstrap({ finished = false } = {}) {
  return {
    elements: TYPES.map((t, i) => ({ id: i + 1, web_name: `P${i + 1}`, team: i + 1, element_type: t })),
    teams: TYPES.map((_, i) => ({ id: i + 1, name: `Team ${i + 1}`, short_name: `T${i + 1}` })),
    events: [{ id: 1, finished, data_checked: finished, is_current: true }],
  };
}

// state per player: 'done' | 'live' | 'pending'; each player's team has one fixture vs team 100+id
function fixtures(states, extra = {}) {
  return TYPES.map((_, i) => {
    const s = states[i + 1] || 'done';
    return {
      id: i + 1,
      event: 1,
      team_h: i + 1,
      team_a: 100 + i,
      started: s !== 'pending',
      finished: s === 'done',
      finished_provisional: s === 'done',
      stats: extra[i + 1] || [],
    };
  });
}

function live(points, minutes = {}) {
  return {
    elements: TYPES.map((_, i) => ({
      id: i + 1,
      stats: { minutes: minutes[i + 1] ?? 90, total_points: points[i + 1] ?? 2, bonus: 0 },
      explain: [{ fixture: i + 1, stats: [] }],
    })),
  };
}

function picks({ captain = 10, vice = 11, chip = null, history = {} } = {}) {
  return {
    active_chip: chip,
    entry_history: { points: 0, total_points: 100, event_transfers_cost: 0, ...history },
    picks: TYPES.map((_, i) => ({
      element: i + 1,
      position: i + 1,
      multiplier: i < 11 ? (i + 1 === captain ? 2 : 1) : 0,
      is_captain: i + 1 === captain,
      is_vice_captain: i + 1 === vice,
    })),
  };
}

// ---------- bonus ----------
test('bonus: no ties', () => {
  const b = computeBonus([
    { element: 1, value: 30 },
    { element: 2, value: 25 },
    { element: 3, value: 20 },
    { element: 4, value: 10 },
  ]);
  assert.deepEqual([...b.entries()], [[1, 3], [2, 2], [3, 1]]);
});

test('bonus: tie for first -> 3,3,1', () => {
  const b = computeBonus([
    { element: 1, value: 30 },
    { element: 2, value: 30 },
    { element: 3, value: 20 },
    { element: 4, value: 10 },
  ]);
  assert.deepEqual(Object.fromEntries(b), { 1: 3, 2: 3, 3: 1 });
});

test('bonus: tie for second -> 3,2,2', () => {
  const b = computeBonus([
    { element: 1, value: 30 },
    { element: 2, value: 25 },
    { element: 3, value: 25 },
    { element: 4, value: 10 },
  ]);
  assert.deepEqual(Object.fromEntries(b), { 1: 3, 2: 2, 3: 2 });
});

test('bonus: tie for third -> 3,2,1,1', () => {
  const b = computeBonus([
    { element: 1, value: 30 },
    { element: 2, value: 25 },
    { element: 3, value: 20 },
    { element: 4, value: 20 },
  ]);
  assert.deepEqual(Object.fromEntries(b), { 1: 3, 2: 2, 3: 1, 4: 1 });
});

test('bonus: three-way tie for first leaves nothing else', () => {
  const b = computeBonus([
    { element: 1, value: 30 },
    { element: 2, value: 30 },
    { element: 3, value: 30 },
    { element: 4, value: 20 },
  ]);
  assert.deepEqual(Object.fromEntries(b), { 1: 3, 2: 3, 3: 3 });
});

// ---------- scoring ----------
test('basic score: 11 starters x 2 pts, captain doubled', () => {
  const ctx = buildContext(bootstrap(), live({ 10: 8 }), fixtures({}), 1);
  const s = scoreEntry(picks(), ctx);
  assert.equal(s.gwPoints, 10 * 2 + 8 * 2);
  assert.equal(s.effectiveCaptain, 10);
  assert.equal(s.subs.length, 0);
});

test('provisional bonus added for live match, skipped once confirmed', () => {
  const bps = [{ identifier: 'bps', h: [{ element: 6, value: 40 }, { element: 7, value: 10 }], a: [] }];
  // Player 6's fixture is live with BPS 40 -> +3 provisional
  const fx = fixtures({ 6: 'live' }, { 6: bps });
  const ctx = buildContext(bootstrap(), live({ 6: 5 }), fx, 1);
  assert.equal(ctx.liveById.get(6).provisionalBonus, 3);
  assert.equal(ctx.liveById.get(6).points, 8);

  // Same, but bonus already present in explain -> no double count
  const lv = live({ 6: 8 });
  lv.elements[5].explain = [{ fixture: 6, stats: [{ identifier: 'bonus', points: 3, value: 3 }] }];
  const ctx2 = buildContext(bootstrap(), lv, fx, 1);
  assert.equal(ctx2.liveById.get(6).provisionalBonus, 0);
  assert.equal(ctx2.liveById.get(6).points, 8);
});

test('auto-sub: DEF who did not play replaced by first eligible bench player', () => {
  // DEF 2 blanks (0 min, match done). Bench DEF 13 played.
  const ctx = buildContext(bootstrap(), live({ 2: 0, 13: 6 }, { 2: 0 }), fixtures({}), 1);
  const s = scoreEntry(picks(), ctx);
  assert.deepEqual(s.subs, [{ out: 2, in: 13 }]);
  assert.equal(s.gwPoints, 9 * 2 + 2 * 2 + 6); // 9 non-captain starters + captain + sub
});

test('auto-sub respects formation: 3 DEF minimum', () => {
  // Starting XI with 4 DEF... make two DEF out -> formation would drop to 2 DEF if MID subbed in.
  // Bench order: GK 12, DEF 13 (did not play), MID 14 (played), FWD 15 (played)
  const mins = { 2: 0, 3: 0, 13: 0 };
  const ctx = buildContext(bootstrap(), live({ 2: 0, 3: 0, 13: 0, 14: 5, 15: 4 }, mins), fixtures({}), 1);
  const s = scoreEntry(picks(), ctx);
  // First DEF out (2): 4->3 DEF with MID 14 is valid (3 DEF). Second DEF out (3): would leave 2 DEF,
  // FWD 15 cannot come in -> no second sub.
  assert.deepEqual(s.subs, [{ out: 2, in: 14 }]);
});

test('auto-sub: no sub while starter match still pending', () => {
  const ctx = buildContext(bootstrap(), live({ 2: 0, 13: 6 }, { 2: 0 }), fixtures({ 2: 'pending' }), 1);
  const s = scoreEntry(picks(), ctx);
  assert.equal(s.subs.length, 0);
  assert.equal(s.counts.pending, 1);
});

test('goalkeeper only replaced by bench goalkeeper', () => {
  const ctx = buildContext(bootstrap(), live({ 1: 0, 12: 3 }, { 1: 0 }), fixtures({}), 1);
  const s = scoreEntry(picks(), ctx);
  assert.deepEqual(s.subs, [{ out: 1, in: 12 }]);
});

test('captain did not play -> vice gets armband', () => {
  const ctx = buildContext(bootstrap(), live({ 10: 0, 11: 7, 15: 1 }, { 10: 0 }), fixtures({}), 1);
  const s = scoreEntry(picks({ captain: 10, vice: 11 }), ctx);
  assert.equal(s.effectiveCaptain, 11);
  // captain subbed by first eligible outfield bench player (DEF 13, 2pt), vice doubled (14)
  assert.deepEqual(s.subs, [{ out: 10, in: 13 }]);
  assert.equal(s.gwPoints, 9 * 2 + 14 + 2);
});

test('triple captain and bench boost', () => {
  const ctx = buildContext(bootstrap(), live({ 10: 10 }), fixtures({}), 1);
  assert.equal(scoreEntry(picks({ chip: '3xc' }), ctx).gwPoints, 10 * 2 + 30);
  assert.equal(scoreEntry(picks({ chip: 'bboost' }), ctx).gwPoints, 14 * 2 + 20);
});

test('finished & checked gameweek uses the official score', () => {
  const ctx = buildContext(bootstrap({ finished: true }), live({}), fixtures({}), 1);
  const s = scoreEntry(picks({ history: { points: 77 } }), ctx);
  assert.equal(s.gwPoints, 77);
});

// ---------- league ----------
test('league aggregation: totals, hits, ranks and effective ownership', () => {
  const ctx = buildContext(bootstrap(), live({ 10: 8 }), fixtures({}), 1);
  const standings = [
    { entry: 100, entry_name: 'A', player_name: 'Alice', total: 0 },
    { entry: 200, entry_name: 'B', player_name: 'Bob', total: 0 },
    { entry: 300, entry_name: 'C', player_name: 'Carl', total: 0 },
  ];
  // prevTotal = total_points - (points - cost)
  const map = new Map([
    [100, picks({ history: { points: 30, total_points: 530, event_transfers_cost: 0 } })], // prev 500
    [200, picks({ captain: 11, vice: 10, history: { points: 30, total_points: 526, event_transfers_cost: 4 } })], // prev 500, -4
    [300, null],
  ]);
  const { rows, players, managers } = aggregateLeague(standings, map, ctx);
  assert.equal(managers, 2);
  const a = rows.find((r) => r.entry === 100);
  const b = rows.find((r) => r.entry === 200);
  assert.equal(a.prevTotal, 500);
  assert.equal(a.liveTotal, 500 + 36);
  assert.equal(b.prevTotal, 500);
  assert.equal(b.liveTotal, 500 + (9 * 2 + 8 + 2 * 2) - 4); // captain P11 (2pt) doubled, P10 scores 8
  assert.equal(rows[0].entry, 100);
  assert.equal(rows[0].liveTotalRank, 1);
  assert.ok(rows.find((r) => r.entry === 300).missing);
  const p10 = players.find((p) => p.element === 10);
  assert.equal(p10.ownedPct, 100);
  assert.equal(p10.captainedPct, 50);
  assert.equal(p10.eoPct, 150);
});

// ---------- team of the week ----------
function totwPlayer(element, type, team, cost, points, captained = 0, captainMultiplier = 0) {
  return { element, name: `P${element}`, team, type, price: cost, points, started: 1, owned: 1, captained, captainMultiplier };
}

test('team of the week: never picks the same player twice', () => {
  // Deliberately give club 6 four strong DEF/FWD candidates -> forces the club-limit repair,
  // which used to reconstruct duplicate picks (regression for a real production bug).
  const players = [
    totwPlayer(1, 1, 1, 45, 6),
    totwPlayer(2, 1, 2, 50, 5),
    totwPlayer(10, 2, 6, 65, 16),
    totwPlayer(11, 2, 6, 55, 16),
    totwPlayer(12, 2, 1, 97, 2),
    totwPlayer(13, 2, 4, 88, 9),
    totwPlayer(14, 2, 8, 113, 4),
    totwPlayer(15, 2, 1, 76, 0),
    totwPlayer(16, 2, 3, 60, 7),
    totwPlayer(20, 3, 2, 90, 10),
    totwPlayer(21, 3, 3, 80, 9),
    totwPlayer(22, 3, 5, 70, 8),
    totwPlayer(23, 3, 6, 100, 12),
    totwPlayer(24, 3, 7, 85, 11),
    totwPlayer(30, 4, 6, 174, 21),
    totwPlayer(31, 4, 6, 165, 21),
    totwPlayer(32, 4, 1, 173, 11),
    totwPlayer(33, 4, 2, 137, 8),
    totwPlayer(34, 4, 3, 76, 5),
  ];
  const totw = buildTeamOfTheWeek(players);
  assert.ok(totw);
  const all = [...totw.gk, ...totw.def, ...totw.mid, ...totw.fwd];
  const ids = all.map((p) => p.element);
  assert.equal(new Set(ids).size, ids.length, `duplicate pick in ${JSON.stringify(ids)}`);
  assert.ok(totw.cost <= 1000, `over budget: ${totw.cost}`);
  const byClub = new Map();
  for (const p of all) byClub.set(p.team, (byClub.get(p.team) || 0) + 1);
  for (const [club, n] of byClub) assert.ok(n <= 3, `club ${club} has ${n} players`);
});

test('team of the week: randomized pools never duplicate a pick or break budget/club rules', () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  const gen = (n, type, priceBase, priceRange, pointsRange, clubs) =>
    Array.from({ length: n }, (_, i) =>
      totwPlayer(
        type * 1000 + i,
        type,
        (i % clubs) + 1,
        priceBase + Math.floor(rnd() * priceRange),
        Math.floor(rnd() * pointsRange),
        rnd() < 0.05 ? 1 : 0,
        rnd() < 0.5 ? 2 : 3,
      ),
    );

  for (let trial = 0; trial < 60; trial++) {
    const players = [
      ...gen(5 + Math.floor(rnd() * 10), 1, 40, 80, 15, 8),
      ...gen(15 + Math.floor(rnd() * 25), 2, 38, 90, 18, 8),
      ...gen(15 + Math.floor(rnd() * 25), 3, 45, 110, 20, 8),
      ...gen(8 + Math.floor(rnd() * 15), 4, 45, 130, 22, 8),
    ];
    const totw = buildTeamOfTheWeek(players);
    if (!totw) continue;
    const all = [...totw.gk, ...totw.def, ...totw.mid, ...totw.fwd];
    const ids = all.map((p) => p.element);
    assert.equal(new Set(ids).size, ids.length, `trial ${trial}: duplicate pick`);
    assert.ok(totw.cost <= 1000, `trial ${trial}: over budget (${totw.cost})`);
    const byClub = new Map();
    for (const p of all) byClub.set(p.team, (byClub.get(p.team) || 0) + 1);
    for (const [club, n] of byClub) assert.ok(n <= 3, `trial ${trial}: club ${club} has ${n} players`);
  }
});
