import { CONFIG } from './config.js';
import { api, loadStandings, mapLimit, ApiError } from './api.js';
import { buildContext, aggregateLeague, POSITIONS, CHIP_LABELS } from './scoring.js';

const $ = (sel) => document.querySelector(sel);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const state = {
  leagueId: null,
  gw: null,
  currentGw: null,
  bootstrap: null,
  standings: null,
  picks: new Map(),
  result: null,
  ctx: null,
  expanded: new Set(),
  auto: true,
  timer: null,
  updatedAt: null,
  loading: false,
};

// ---------------------------------------------------------------- bootstrapping

function readParams() {
  const p = new URLSearchParams(location.search);
  const league = p.get('league') || CONFIG.DEFAULT_LEAGUE_ID;
  const gw = p.get('gw');
  state.leagueId = league && /^\d+$/.test(String(league)) ? Number(league) : null;
  state.gw = gw && /^\d+$/.test(gw) ? Number(gw) : null;
}

function writeParams() {
  const p = new URLSearchParams();
  if (state.leagueId) p.set('league', state.leagueId);
  if (state.gw && state.gw !== state.currentGw) p.set('gw', state.gw);
  const qs = p.toString();
  history.replaceState(null, '', qs ? `?${qs}` : location.pathname);
}

function setStatus(text, kind = 'info') {
  const el = $('#status');
  el.textContent = text || '';
  el.dataset.kind = kind;
  el.hidden = !text;
}

function showForm() {
  $('#league-form-section').hidden = false;
  $('#league-view').hidden = true;
}

async function init() {
  readParams();
  $('#league-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const raw = $('#league-input').value.trim();
    const m = raw.match(/leagues\/(\d+)/) || raw.match(/^(\d+)$/);
    if (!m) {
      setStatus('Enter a numeric league ID or a league URL.', 'error');
      return;
    }
    state.leagueId = Number(m[1]);
    state.gw = null;
    state.expanded.clear();
    loadLeague();
  });
  $('#refresh-btn').addEventListener('click', () => refreshLive(true));
  $('#auto-toggle').addEventListener('change', (e) => {
    state.auto = e.target.checked;
    schedule();
  });
  $('#gw-select').addEventListener('change', (e) => {
    state.gw = Number(e.target.value);
    state.expanded.clear();
    loadLeague({ keepBootstrap: true });
  });
  $('#change-league').addEventListener('click', () => {
    clearTimeout(state.timer);
    state.leagueId = null;
    writeParams();
    showForm();
  });
  $('#standings').addEventListener('click', (e) => {
    const row = e.target.closest('tr[data-entry]');
    if (!row) return;
    const id = Number(row.dataset.entry);
    state.expanded.has(id) ? state.expanded.delete(id) : state.expanded.add(id);
    renderStandings();
  });

  if (CONFIG.WORKER_URL.includes('__WORKER_URL__')) {
    setStatus('WORKER_URL is not configured. Edit web/js/config.js or set the WORKER_URL repository variable.', 'error');
  }
  if (state.leagueId) loadLeague();
  else showForm();
}

// ---------------------------------------------------------------- data loading

async function loadLeague({ keepBootstrap = false } = {}) {
  clearTimeout(state.timer);
  $('#league-form-section').hidden = true;
  $('#league-view').hidden = false;
  state.loading = true;
  try {
    if (!keepBootstrap || !state.bootstrap) {
      setStatus('Loading FPL data…');
      state.bootstrap = await api.bootstrap();
      const events = state.bootstrap.events;
      const current =
        events.find((e) => e.is_current) || [...events].reverse().find((e) => e.finished) || events[0];
      state.currentGw = current.id;
    }
    if (!state.gw) state.gw = state.currentGw;
    writeParams();
    renderGwSelect();

    setStatus('Loading league standings…');
    state.standings = await loadStandings(state.leagueId, CONFIG.MAX_MANAGERS);
    $('#league-name').textContent = state.standings.league?.name || `League ${state.leagueId}`;
    document.title = `${state.standings.league?.name || 'League'} · FPL Live`;

    const entries = state.standings.results;
    let done = 0;
    state.picks = new Map();
    await mapLimit(entries, CONFIG.CONCURRENCY, async (s) => {
      try {
        state.picks.set(s.entry, await api.picks(s.entry, state.gw));
      } catch (err) {
        if (!(err instanceof ApiError) || err.status !== 404) console.warn(err);
        state.picks.set(s.entry, null); // e.g. joined after this gameweek
      }
      done++;
      setStatus(`Loading teams… ${done}/${entries.length}`);
    });

    await refreshLive();
  } catch (err) {
    console.error(err);
    setStatus(
      err.status === 404
        ? `League ${state.leagueId} not found. Only classic leagues are supported.`
        : `Could not load data: ${err.message}`,
      'error',
    );
  } finally {
    state.loading = false;
  }
}

async function refreshLive(manual = false) {
  clearTimeout(state.timer);
  try {
    if (manual) setStatus('Refreshing…');
    const [live, fixtures] = await Promise.all([api.live(state.gw), api.fixtures(state.gw)]);
    state.ctx = buildContext(state.bootstrap, live, fixtures, state.gw);
    state.result = aggregateLeague(state.standings.results, state.picks, state.ctx);
    state.updatedAt = new Date();
    setStatus(
      state.standings.truncated
        ? `Showing the top ${CONFIG.MAX_MANAGERS} managers of this league (ranks are among them).`
        : '',
    );
    render();
  } catch (err) {
    console.error(err);
    setStatus(`Refresh failed (${err.message}). Showing the last loaded data.`, 'error');
  }
  schedule();
}

function isLiveGw() {
  return state.gw === state.currentGw && !state.ctx?.eventFinished;
}

function schedule() {
  clearTimeout(state.timer);
  if (state.auto && state.result && isLiveGw()) {
    state.timer = setTimeout(() => refreshLive(), CONFIG.REFRESH_SECONDS * 1000);
  }
}

// ---------------------------------------------------------------- rendering

function renderGwSelect() {
  const sel = $('#gw-select');
  const events = state.bootstrap.events.filter((e) => e.id <= state.currentGw);
  sel.innerHTML = events
    .map((e) => `<option value="${e.id}" ${e.id === state.gw ? 'selected' : ''}>GW ${e.id}</option>`)
    .join('');
}

const teamShort = (id) => state.ctx?.teams.get(id)?.short ?? '';
const playerName = (id) => state.ctx?.players.get(id)?.name ?? '—';

function render() {
  const { rows } = state.result;
  const live = isLiveGw();
  $('#gw-badge').textContent = `GW ${state.gw}`;
  $('#live-badge').hidden = !live;
  $('#updated').textContent = state.updatedAt
    ? `Updated ${state.updatedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`
    : '';
  $('#auto-wrap').hidden = !live;

  const scored = rows.filter((r) => !r.missing);
  const avg = scored.length ? scored.reduce((a, r) => a + r.net, 0) / scored.length : 0;
  const best = scored.reduce((a, r) => (!a || r.net > a.net ? r : a), null);
  const capCount = new Map();
  for (const r of scored) if (r.captain) capCount.set(r.captain, (capCount.get(r.captain) || 0) + 1);
  const topCap = [...capCount.entries()].sort((a, b) => b[1] - a[1])[0];
  const chips = scored.filter((r) => r.chip).length;

  $('#summary').innerHTML = [
    card('Managers', scored.length),
    card('Average GW', avg.toFixed(1)),
    card('Top GW score', best ? `${best.net}` : '—', best ? esc(best.teamName) : ''),
    card('Most captained', topCap ? esc(playerName(topCap[0])) : '—', topCap ? `${topCap[1]} of ${scored.length}` : ''),
    card('Chips played', chips),
  ].join('');

  renderFixtures();
  renderStandings();
  renderPlayers();
}

function card(label, value, sub = '') {
  return `<div class="card"><div class="card-label">${label}</div><div class="card-value">${value}</div>${
    sub ? `<div class="card-sub">${sub}</div>` : ''
  }</div>`;
}

function renderFixtures() {
  const fx = [...state.ctx.fixtures].sort(
    (a, b) => new Date(a.kickoff_time || 0) - new Date(b.kickoff_time || 0),
  );
  $('#fixtures').innerHTML = fx
    .map((f) => {
      const done = f.finished || f.finished_provisional;
      const status = done ? 'FT' : f.started ? `${f.minutes}'` : kickoff(f.kickoff_time);
      const score = f.started ? `${f.team_h_score ?? 0} – ${f.team_a_score ?? 0}` : 'v';
      return `<div class="fixture ${f.started && !done ? 'is-live' : ''}">
        <span class="fx-team">${esc(teamShort(f.team_h))}</span>
        <span class="fx-score">${score}</span>
        <span class="fx-team">${esc(teamShort(f.team_a))}</span>
        <span class="fx-status">${esc(status)}</span>
      </div>`;
    })
    .join('');
}

function kickoff(iso) {
  if (!iso) return 'TBC';
  const d = new Date(iso);
  return d.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

function rankMove(n) {
  if (!n) return '<span class="move same">–</span>';
  return n > 0
    ? `<span class="move up" title="Up ${n}">▲${n}</span>`
    : `<span class="move down" title="Down ${-n}">▼${-n}</span>`;
}

function renderStandings() {
  const { rows } = state.result;
  const body = rows
    .map((r) => {
      if (r.missing) {
        return `<tr class="missing"><td class="num">${r.liveTotalRank}</td><td></td>
          <td>${teamCell(r)}</td><td class="num" colspan="2">no team this GW</td>
          <td class="num strong">${r.liveTotal}</td><td colspan="2"></td></tr>`;
      }
      const open = state.expanded.has(r.entry);
      const cap = r.effectiveCaptain ?? r.captain;
      const capSwapped = r.effectiveCaptain && r.effectiveCaptain !== r.captain;
      const main = `<tr data-entry="${r.entry}" class="entry-row ${open ? 'open' : ''}">
        <td class="num strong">${r.liveTotalRank}</td>
        <td class="num">${rankMove(r.rankChange)}</td>
        <td>${teamCell(r)}</td>
        <td class="num strong">${r.net}${r.hits ? `<span class="hit">-${r.hits}</span>` : ''}</td>
        <td class="hide-sm">${esc(playerName(cap))}${capSwapped ? ' <span class="tag" title="Vice-captain took the armband">VC</span>' : ''}</td>
        <td class="num strong">${r.liveTotal}</td>
        <td>${r.chip ? `<span class="chip chip-${esc(r.chip)}">${esc(CHIP_LABELS[r.chip] || r.chip)}</span>` : ''}</td>
        <td class="hide-sm progress">${progress(r.counts)}</td>
      </tr>`;
      return open ? main + `<tr class="detail"><td colspan="8">${teamDetail(r)}</td></tr>` : main;
    })
    .join('');
  $('#standings tbody').innerHTML = body;
}

function teamCell(r) {
  return `<div class="team-name">${esc(r.teamName)}</div><div class="manager">${esc(r.manager)}</div>`;
}

function progress(c) {
  const parts = [];
  if (c.done) parts.push(`<span class="p-done" title="Finished">${c.done}✓</span>`);
  if (c.live) parts.push(`<span class="p-live" title="Playing now">${c.live}●</span>`);
  if (c.pending) parts.push(`<span class="p-pending" title="Yet to play">${c.pending}⏳</span>`);
  return parts.join(' ');
}

function pickLine(p) {
  const badges = [];
  if (p.multiplier === 3) badges.push('<span class="tag cap">TC</span>');
  else if (p.multiplier === 2) badges.push('<span class="tag cap">C</span>');
  if (p.isVice) badges.push('<span class="tag">V</span>');
  if (p.subIn) badges.push('<span class="tag in">IN</span>');
  if (p.subOut) badges.push('<span class="tag out">OUT</span>');
  const bonus = p.live.provisionalBonus ? `<span class="bonus" title="Provisional bonus">+${p.live.provisionalBonus}b</span>` : '';
  const stateIcon = { live: '●', pending: '⏳', done: '', blank: '—' }[p.state] || '';
  return `<li class="pick state-${p.state} ${p.inXI ? '' : 'benched'}">
    <span class="pos">${POSITIONS[p.type] || ''}</span>
    <span class="pname">${esc(p.name)} <small>${esc(teamShort(p.team))}</small> ${badges.join('')}</span>
    <span class="pstate">${stateIcon}</span>
    <span class="pmin">${p.live.minutes}'</span>
    <span class="ppts">${p.inXI ? p.total : `(${p.live.points})`}${bonus}</span>
  </li>`;
}

function teamDetail(r) {
  const xi = r.picks.filter((p) => p.inXI).sort((a, b) => a.type - b.type || a.position - b.position);
  const bench = r.picks.filter((p) => !p.inXI).sort((a, b) => a.position - b.position);
  const link = `https://fantasy.premierleague.com/entry/${r.entry}/event/${state.gw}`;
  return `<div class="team-detail">
    <ul class="picks">${xi.map(pickLine).join('')}</ul>
    ${bench.length ? `<div class="bench-title">Bench</div><ul class="picks">${bench.map(pickLine).join('')}</ul>` : ''}
    <div class="detail-foot">
      <span>Transfers: ${r.transfers}${r.hits ? ` (−${r.hits})` : ''}</span>
      <span>Before GW: ${r.prevTotal}</span>
      <a href="${link}" target="_blank" rel="noopener">Open on FPL ↗</a>
    </div>
  </div>`;
}

function renderPlayers() {
  const top = state.result.players.slice(0, 25);
  $('#players tbody').innerHTML = top
    .map(
      (p) => `<tr class="state-${p.state}">
      <td>${esc(p.name)}</td>
      <td class="hide-sm">${POSITIONS[p.type] || ''}</td>
      <td>${esc(teamShort(p.team))}</td>
      <td class="num strong">${p.points}</td>
      <td class="num">${p.ownedPct.toFixed(0)}%</td>
      <td class="num">${p.captainedPct.toFixed(0)}%</td>
      <td class="num strong">${p.eoPct.toFixed(0)}%</td>
    </tr>`,
    )
    .join('');
}

init();
