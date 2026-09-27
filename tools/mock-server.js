// Offline mock of the FPL endpoints the app uses, for UI development without the real API.
// Usage: node tools/mock-server.js   -> http://localhost:8787   (then open the web app with ?league=1)
import http from 'node:http';

let seed = 42;
const rnd = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

const GW = 5;
const TEAM_NAMES = [
  ['Arsenal', 'ARS'], ['Aston Villa', 'AVL'], ['Bournemouth', 'BOU'], ['Brentford', 'BRE'],
  ['Brighton', 'BHA'], ['Burnley', 'BUR'], ['Chelsea', 'CHE'], ['Crystal Palace', 'CRY'],
  ['Everton', 'EVE'], ['Fulham', 'FUL'], ['Leeds', 'LEE'], ['Liverpool', 'LIV'],
  ['Man City', 'MCI'], ['Man Utd', 'MUN'], ['Newcastle', 'NEW'], ["Nott'm Forest", 'NFO'],
  ['Sunderland', 'SUN'], ['Spurs', 'TOT'], ['West Ham', 'WHU'], ['Wolves', 'WOL'],
];
const teams = TEAM_NAMES.map(([name, short], i) => ({ id: i + 1, name, short_name: short }));

const SYL = ['ka', 'ro', 'mi', 'le', 'sa', 'to', 'ne', 'vi', 'da', 'ri', 'go', 'lu', 'be', 'ma', 'zo'];
const makeName = () => {
  const s = pick(SYL) + pick(SYL) + (rnd() > 0.5 ? pick(SYL) : '');
  return s[0].toUpperCase() + s.slice(1);
};

// 2 GK, 5 DEF, 5 MID, 3 FWD per team
const elements = [];
for (const t of teams) {
  for (const [type, n] of [[1, 2], [2, 5], [3, 5], [4, 3]]) {
    for (let k = 0; k < n; k++) {
      elements.push({ id: elements.length + 1, web_name: makeName(), team: t.id, element_type: type });
    }
  }
}

const events = Array.from({ length: 38 }, (_, i) => ({
  id: i + 1,
  is_current: i + 1 === GW,
  finished: i + 1 < GW,
  data_checked: i + 1 < GW,
}));

// Fixtures: 10 matches; 4 finished, 3 live, 3 pending
const order = [...teams.map((t) => t.id)].sort(() => rnd() - 0.5);
const now = Date.now();
const fixtures = [];
for (let i = 0; i < 10; i++) {
  const status = i < 4 ? 'done' : i < 7 ? 'live' : 'pending';
  fixtures.push({
    id: 100 + i,
    event: GW,
    team_h: order[i * 2],
    team_a: order[i * 2 + 1],
    kickoff_time: new Date(now + (i - 6) * 3600e3).toISOString(),
    started: status !== 'pending',
    finished: status === 'done' && i < 2,
    finished_provisional: status === 'done',
    minutes: status === 'done' ? 90 : status === 'live' ? 30 + i * 8 : 0,
    team_h_score: status === 'pending' ? null : Math.floor(rnd() * 4),
    team_a_score: status === 'pending' ? null : Math.floor(rnd() * 3),
    stats: [],
  });
}
const fixtureOf = new Map();
for (const f of fixtures) { fixtureOf.set(f.team_h, f); fixtureOf.set(f.team_a, f); }

const liveEls = elements.map((e) => {
  const f = fixtureOf.get(e.team);
  const played = f.started && rnd() > 0.25;
  const minutes = played ? Math.min(f.minutes, 20 + Math.floor(rnd() * 71)) : 0;
  const pts = minutes ? Math.max(1, Math.floor(rnd() * rnd() * 16)) : 0;
  const bonus = f.finished && minutes ? pick([0, 0, 0, 1, 2, 3]) : 0;
  return {
    id: e.id,
    stats: { minutes, total_points: pts + bonus, bonus, bps: minutes ? Math.floor(rnd() * 40) : 0 },
    explain: [{ fixture: f.id, stats: bonus ? [{ identifier: 'bonus', points: bonus, value: bonus }] : [] }],
  };
});
for (const f of fixtures) {
  const bps = (team) =>
    liveEls
      .filter((l) => elements[l.id - 1].team === team && l.stats.minutes > 0)
      .map((l) => ({ element: l.id, value: l.stats.bps }));
  if (f.started) f.stats = [{ identifier: 'bps', h: bps(f.team_h), a: bps(f.team_a) }];
}

// League of 14 managers
const MANAGERS = ['Alex', 'Boris', 'Chris', 'Dasha', 'Egor', 'Fedor', 'Galina', 'Ivan', 'Katya', 'Lev', 'Masha', 'Nikita', 'Olga', 'Pavel'];
const entries = MANAGERS.map((m, i) => {
  const byType = (t, n) => {
    const pool = elements.filter((e) => e.element_type === t).sort(() => rnd() - 0.5);
    return pool.slice(0, n).map((e) => e.id);
  };
  const gks = byType(1, 2), defs = byType(2, 5), mids = byType(3, 5), fwds = byType(4, 3);
  const xi = [gks[0], ...defs.slice(0, 4), ...mids.slice(0, 4), ...fwds.slice(0, 2)];
  const bench = [gks[1], defs[4], mids[4], fwds[2]];
  const all = [...xi, ...bench];
  const capIdx = 5 + Math.floor(rnd() * 6);
  const chip = i === 2 ? 'bboost' : i === 5 ? '3xc' : i === 9 ? 'freehit' : null;
  const cost = i % 4 === 1 ? 4 : 0;
  const prevTotal = 280 + Math.floor(rnd() * 60);
  const official = 40 + Math.floor(rnd() * 20);
  return {
    entry: 1000 + i,
    entry_name: `${m}'s XI`,
    player_name: `${m} ${pick(['Ivanov', 'Petrov', 'Smirnova', 'Kuznets', 'Sokol'])}`,
    prevTotal,
    picks: {
      active_chip: chip,
      automatic_subs: [],
      entry_history: {
        event: GW,
        points: official,
        total_points: prevTotal + official - cost,
        event_transfers: cost ? 2 : 1,
        event_transfers_cost: cost,
      },
      picks: all.map((el, idx) => ({
        element: el,
        position: idx + 1,
        multiplier: idx < 11 ? (idx === capIdx ? (chip === '3xc' ? 3 : 2) : 1) : chip === 'bboost' ? 1 : 0,
        is_captain: idx === capIdx,
        is_vice_captain: idx === (capIdx === 10 ? 9 : capIdx + 1),
      })),
    },
  };
});

const routes = [
  [/^\/api\/bootstrap-static\/$/, () => ({ events, teams, elements })],
  [/^\/api\/fixtures\/$/, () => fixtures],
  [/^\/api\/event\/\d+\/live\/$/, () => ({ elements: liveEls })],
  [/^\/api\/leagues-classic\/\d+\/standings\/$/, () => ({
    league: { id: 1, name: 'Mock Mini-League' },
    standings: {
      has_next: false,
      page: 1,
      results: entries
        .sort((a, b) => b.prevTotal - a.prevTotal)
        .map((e, i) => ({ entry: e.entry, entry_name: e.entry_name, player_name: e.player_name, rank: i + 1, last_rank: i + 1, total: e.prevTotal, event_total: 0 })),
    },
  })],
  [/^\/api\/entry\/(\d+)\/event\/\d+\/picks\/$/, (m) => entries.find((e) => e.entry === Number(m[1]))?.picks],
];

http
  .createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
    for (const [re, handler] of routes) {
      const m = url.pathname.match(re);
      if (m) {
        const body = handler(m);
        res.writeHead(body ? 200 : 404, headers);
        return res.end(JSON.stringify(body ?? { detail: 'Not found.' }));
      }
    }
    res.writeHead(404, headers);
    res.end('{"error":"Not found"}');
  })
  .listen(8787, () => console.log('Mock FPL API on http://localhost:8787'));
