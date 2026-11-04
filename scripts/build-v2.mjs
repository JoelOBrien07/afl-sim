// BUILDS SIRENSIM v2: a model that learns from player data. Runs in the GitHub Action after fetch-data.mjs and fetch-players.R.
//
// WHAT IT DOES, IN PLAIN ENGLISH
// For every game it works out a few numbers using ONLY what was known before the game:
//   1. Club rating gap   (the same idea as SirenSim v1: ratings that move toward results)
//   2. Rest              (days since each side last played)
//   3. Travel            (distance each side flies or drives)
//   4. Lineup strength   (how good the 22 players on the team sheet are, from their recent form, scored from Fryzigg's ratings)
//   5. Team form         (how each side has been doing lately on inside 50s, clearances, contested ball, tackles,
//                         score involvements and metres gained, compared with its opponents)
// Then a ridge regression (a straight-line fit that is told not to over-trust any one number) learns how many points of
// margin each of those numbers is worth. That is the "pattern finding".
//
// HOW IT STAYS HONEST
// A season is only predicted by a model trained on EARLIER seasons. So the backtest scores are what the model would really
// have done, and it can not have peeked at the answers. Upcoming games use a model trained on everything played so far.
//
// WHAT IT WRITES: site/data/v2.json  = { meta, weights, pred: { squiggleGameId: expected home margin } }
// It only publishes our own predictions and the learned weights. The raw player data stays in build/ and is not published.
//
// Settings (environment variables): DATA_DIR (default site/data), PLAYERS_FILE (build/players.tsv), LINEUPS_FILE (build/lineups.tsv).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const DATA = process.env.DATA_DIR || 'site/data';
const PLAYERS_FILE = process.env.PLAYERS_FILE || 'build/players.tsv';
const LINEUPS_FILE = process.env.LINEUPS_FILE || 'build/lineups.tsv';
const OUT = process.env.V2_OUT || DATA + '/v2.json';

// ---------------------------------------------------------------------------------------------
// SMALL HELPERS
const num = (v) => { const n = Number(v); return v === undefined || v === '' || v === 'NA' || !isFinite(n) ? NaN : n; };
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
// Reads a tab separated file into a list of objects. Returns null if the file does not exist.
function readTsv(file) {
  if (!existsSync(file)) return null;
  const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
  const head = lines.shift().split('\t');
  return lines.map((l) => { const c = l.split('\t'); const o = {}; head.forEach((h, i) => { o[h] = c[i]; }); return o; });
}
// Different sources spell club names differently. This turns any spelling into one short key.
const TEAM_ALIASES = {
  adelaide: 'adelaide', adelaidecrows: 'adelaide', brisbane: 'brisbane', brisbanelions: 'brisbane', brisbanebears: 'brisbane',
  carlton: 'carlton', carltonblues: 'carlton', collingwood: 'collingwood', collingwoodmagpies: 'collingwood',
  essendon: 'essendon', essendonbombers: 'essendon', fremantle: 'fremantle', fremantledockers: 'fremantle',
  geelong: 'geelong', geelongcats: 'geelong', goldcoast: 'goldcoast', goldcoastsuns: 'goldcoast',
  gws: 'gws', greaterwesternsydney: 'gws', gwsgiants: 'gws', giants: 'gws',
  hawthorn: 'hawthorn', hawthornhawks: 'hawthorn', melbourne: 'melbourne', melbournedemons: 'melbourne',
  northmelbourne: 'northmelbourne', kangaroos: 'northmelbourne', northmelbournekangaroos: 'northmelbourne',
  portadelaide: 'portadelaide', portadelaidepower: 'portadelaide', port: 'portadelaide',
  richmond: 'richmond', richmondtigers: 'richmond', stkilda: 'stkilda', stkildasaints: 'stkilda',
  sydney: 'sydney', sydneyswans: 'sydney', westcoast: 'westcoast', westcoasteagles: 'westcoast',
  westernbulldogs: 'bulldogs', footscray: 'bulldogs', bulldogs: 'bulldogs',
};
const unmappedTeams = new Set();
function tkey(name) {
  const k = String(name || '').toLowerCase().replace(/[^a-z]/g, '');
  if (TEAM_ALIASES[k]) return TEAM_ALIASES[k];
  unmappedTeams.add(name);
  return k;
}
const nameKey = (n) => String(n || '').toLowerCase().replace(/[^a-z]/g, '');
const dayNum = (d) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d || '')); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000 : NaN; };
const parseUnix = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(s || '')); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) / 1000 : NaN; };
const cmpGame = (a, b) => a.round - b.round || (a.date < b.date ? -1 : a.date > b.date ? 1 : 0) || a.id - b.id;
function km(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180, dLat = (lat2 - lat1) * r, dLon = (lon2 - lon1) * r;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(x));
}
// Where each club is based, in Squiggle team id order (id 1 first). Keep this in step with TEAM_BASE in site/index.html.
const TEAM_BASE = [
  [-34.9285, 138.6007], [-27.4698, 153.0251], [-37.8136, 144.9631], [-37.8136, 144.9631], [-37.8136, 144.9631], [-31.9505, 115.8605],
  [-38.1499, 144.3617], [-28.0167, 153.4], [-33.8688, 151.2093], [-37.8136, 144.9631], [-37.8136, 144.9631], [-37.8136, 144.9631],
  [-34.9285, 138.6007], [-37.8136, 144.9631], [-37.8136, 144.9631], [-33.8688, 151.2093], [-31.9505, 115.8605], [-37.8136, 144.9631],
];

// ---------------------------------------------------------------------------------------------
// LOAD THE INPUTS
if (!existsSync(DATA + '/season.json')) { console.error('No ' + DATA + '/season.json. Run scripts/fetch-data.mjs first.'); process.exit(1); }
const season = JSON.parse(readFileSync(DATA + '/season.json', 'utf8'));
const history = existsSync(DATA + '/history.json') ? JSON.parse(readFileSync(DATA + '/history.json', 'utf8')) : { seasons: [] };
const prow = readTsv(PLAYERS_FILE);
if (!prow || !prow.length) { console.log('No player data at ' + PLAYERS_FILE + ', so v2 is skipped.'); process.exit(1); }
const lineupRows = readTsv(LINEUPS_FILE) || [];
const teamKeyById = new Map((season.teams || []).map((t) => [t.id, tkey(t.name)]));
const currentYear = season.meta && season.meta.year;

// ---------------------------------------------------------------------------------------------
// PASS A: GO THROUGH EVERY PAST MATCH IN DATE ORDER AND RECORD WHAT WE KNEW JUST BEFORE IT
// Player quality: each player's results are turned into a z score (how far above or below the average player that season),
// averaged with more weight on recent games. A player with few games is pulled toward a slightly below average prior.
const FORM_STATS = ['i50', 'clr', 'cp', 'tkl', 'si', 'mg'];
const DECAY = 0.96, PRIOR_W = 3, PRIOR_Z = -0.4, FORM_KEEP = 0.8;
const matches = new Map();
for (const r of prow) {
  let m = matches.get(r.match_id);
  if (!m) { m = { id: r.match_id, date: r.date, year: +r.year, home: tkey(r.home), away: tkey(r.away), rows: [] }; matches.set(r.match_id, m); }
  m.rows.push({ team: tkey(r.team), pid: r.player_id, name: r.name, rating: num(r.rating), sc: num(r.sc), st: FORM_STATS.map((s) => num(r[s])) });
}
// Average and spread of each rating for each season, so the same score means the same thing in different years.
const scale = {};
for (const m of matches.values()) for (const r of m.rows) {
  const y = (scale[m.year] ||= { rating: [], sc: [] });
  if (isFinite(r.rating)) y.rating.push(r.rating);
  if (isFinite(r.sc)) y.sc.push(r.sc);
}
for (const y of Object.keys(scale)) for (const k of ['rating', 'sc']) {
  const a = scale[y][k], mu = a.length ? mean(a) : 0;
  scale[y][k] = { mu, sd: a.length ? Math.sqrt(mean(a.map((v) => (v - mu) ** 2))) || 1 : 1 };
}
function zOf(year, row) {
  const s = scale[year], parts = [];
  if (isFinite(row.rating)) parts.push((row.rating - s.rating.mu) / s.rating.sd);
  if (isFinite(row.sc)) parts.push((row.sc - s.sc.mu) / s.sc.sd);
  return parts.length ? mean(parts) : NaN;
}
const pq = new Map();   // player id -> { w, s, name }
const quality = (pid) => { const p = pq.get(pid); return p ? (p.s + PRIOR_W * PRIOR_Z) / (p.w + PRIOR_W) : PRIOR_Z; };
const formState = new Map();   // team -> running average of (for minus against) for each form stat
const lastLineup = new Map();  // team -> player ids from its latest match
// A club's usual lineup strength (a running average of recent lineups). Comparing a lineup with this shows who is MISSING,
// which the club rating can not know. The rating already knows the club is usually strong; it does not know the star is out.
const usualL = new Map();
const USUAL_KEEP = 0.85;
const relStrength = (team, L) => { const u = usualL.get(team); return u && u.n >= 3 ? L - u.v : 0; };
const matchFeat = new Map();   // match id -> { teamKey: { L: lineup strength, form: [...] } }
const strength = (pids) => pids.map(quality).sort((a, b) => b - a).slice(0, 22).reduce((s, v) => s + v, 0);
const ordered = [...matches.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : String(a.id).localeCompare(String(b.id))));
for (const m of ordered) {
  const side = {};
  for (const t of [m.home, m.away]) {
    const rows = m.rows.filter((r) => r.team === t);
    const L = rows.length >= 15 ? strength(rows.map((r) => r.pid)) : null;
    side[t] = L != null ? { L, rel: relStrength(t, L), form: (formState.get(t) || FORM_STATS.map(() => 0)).slice() } : null;
  }
  matchFeat.set(m.id, side);
  // Now learn from the match.
  for (const t of [m.home, m.away]) {
    const opp = t === m.home ? m.away : m.home;
    const mine = m.rows.filter((r) => r.team === t), theirs = m.rows.filter((r) => r.team === opp);
    for (const r of mine) {
      const z = zOf(m.year, r);
      if (!isFinite(z)) continue;
      const p = pq.get(r.pid) || { w: 0, s: 0 };
      p.s = p.s * DECAY + z; p.w = p.w * DECAY + 1; pq.set(r.pid, p);
    }
    if (mine.length) lastLineup.set(t, mine.map((r) => r.pid));
    if (side[t]) { const u = usualL.get(t); if (u) { u.v = USUAL_KEEP * u.v + (1 - USUAL_KEEP) * side[t].L; u.n++; } else usualL.set(t, { v: side[t].L, n: 1 }); }
    const f = formState.get(t) || FORM_STATS.map(() => 0);
    FORM_STATS.forEach((_, k) => {
      const a = mine.map((r) => r.st[k]).filter(isFinite), b = theirs.map((r) => r.st[k]).filter(isFinite);
      const d = a.length && b.length ? a.reduce((s, v) => s + v, 0) - b.reduce((s, v) => s + v, 0) : 0;
      f[k] = FORM_KEEP * f[k] + (1 - FORM_KEEP) * d;
    });
    formState.set(t, f);
  }
}
// Index to find the player match for a Squiggle game: season + home + away (finals are not in our games, so this is unique enough).
const matchIndex = new Map();
for (const m of ordered) { const k = m.year + '|' + m.home + '|' + m.away; (matchIndex.get(k) || matchIndex.set(k, []).get(k)).push(m); }
function findMatch(year, home, away, date) {
  const list = matchIndex.get(year + '|' + home + '|' + away);
  if (!list) return null;
  const d = dayNum(date);
  let best = null, bd = 1e9;
  for (const m of list) { const dd = Math.abs(dayNum(m.date) - d); if (!isFinite(d) || dd < bd) { bd = dd; best = m; } }
  return best && (!isFinite(d) || bd <= 4) ? best : null;
}
// Players by name, for turning a named team sheet into player ids.
const byName = new Map();
for (const m of ordered) for (const r of m.rows) byName.set(nameKey(r.name), r.pid);
const lineupBy = new Map();
for (const r of lineupRows) { const k = r.year + '|' + r.round + '|' + tkey(r.team); (lineupBy.get(k) || lineupBy.set(k, []).get(k)).push(r.name); }

// ---------------------------------------------------------------------------------------------
// PASS B: GO THROUGH EVERY GAME (Squiggle's list) AND BUILD ITS NUMBERS
const seasonsList = [];
for (const s of (history.seasons || [])) if (s && s.games && s.games.length && s.year < currentYear) seasonsList.push({ y: s.year, games: s.games.slice().sort(cmpGame) });
seasonsList.sort((a, b) => a.y - b.y);
seasonsList.push({ y: currentYear, games: season.games.slice().sort(cmpGame), cur: true });

const FEATURES = ['Club rating gap', 'Rest (days)', 'Travel (1,000 km)', 'Lineup strength', 'Lineup vs usual (who is missing)', 'Inside 50s form', 'Clearances form', 'Contested possessions form', 'Tackles form', 'Score involvements form', 'Metres gained form'];
const BASE_COLS = [0, 1, 2];   // the columns that do not need player data (used to show how much the player data adds)
const rat = new Float64Array(18), lastU = new Float64Array(18).fill(NaN), lastY = new Int32Array(18).fill(-1);
const rows = [];
let curYear = null, matched = 0, lineupUsed = 0, lastLineupUsed = 0;
for (const s of seasonsList) {
  if (curYear !== null && s.y !== curYear) for (let t = 0; t < 18; t++) rat[t] *= 0.7;
  curYear = s.y;
  for (const g of s.games) {
    if (!(g.h >= 1 && g.h <= 18 && g.a >= 1 && g.a <= 18)) continue;
    const h = g.h - 1, a = g.a - 1, hk = teamKeyById.get(g.h), ak = teamKeyById.get(g.a);
    const u = typeof g.u === 'number' && isFinite(g.u) ? g.u : parseUnix(g.date);
    const vl = Array.isArray(g.vl) && g.vl.length === 2 ? g.vl : null;
    const dH = vl ? km(TEAM_BASE[h][0], TEAM_BASE[h][1], vl[0], vl[1]) : 0;
    const dA = vl ? km(TEAM_BASE[a][0], TEAM_BASE[a][1], vl[0], vl[1]) : km(TEAM_BASE[a][0], TEAM_BASE[a][1], TEAM_BASE[h][0], TEAM_BASE[h][1]);
    let rh = 7, ra = 7;
    if (lastY[h] === s.y && isFinite(lastU[h]) && isFinite(u)) rh = clamp((u - lastU[h]) / 86400, 3, 14);
    if (lastY[a] === s.y && isFinite(lastU[a]) && isFinite(u)) ra = clamp((u - lastU[a]) / 86400, 3, 14);
    if (isFinite(u)) { lastU[h] = u; lastU[a] = u; }
    lastY[h] = s.y; lastY[a] = s.y;
    const done = g.done && g.hs != null && g.as != null;
    const res = done ? g.hs - g.as : null;
    const x = [rat[h] - rat[a], clamp(rh - ra, -4, 4), (dA - dH) / 1000];
    // Player features: from the real match if it was played, otherwise from the named team (or the last team each side played).
    let L = null, R = null, F = null;
    if (done) {
      const m = findMatch(s.y, hk, ak, g.date), sd = m && matchFeat.get(m.id);
      if (sd && sd[hk] && sd[ak]) { matched++; L = sd[hk].L - sd[ak].L; R = sd[hk].rel - sd[ak].rel; F = sd[hk].form.map((v, k) => v - sd[ak].form[k]); }
    } else {
      const side = (key) => {
        const names = lineupBy.get(s.y + '|' + g.round + '|' + key);
        if (names) {
          const pids = names.map((n) => byName.get(nameKey(n))).filter(Boolean);
          if (pids.length >= 18) { lineupUsed++; const v = strength(pids); return [v, relStrength(key, v)]; }
        }
        const last = lastLineup.get(key);
        if (last) { lastLineupUsed++; const v = strength(last); return [v, relStrength(key, v)]; }
        return null;
      };
      const lh = side(hk), la = side(ak), fh = formState.get(hk), fa = formState.get(ak);
      if (lh != null && la != null && fh && fa) { L = lh[0] - la[0]; R = lh[1] - la[1]; F = fh.map((v, k) => v - fa[k]); }
    }
    if (L != null) x.push(L, R, ...F); else x.push(...FEATURES.slice(3).map(() => NaN));
    rows.push({ gid: g.id, year: s.y, cur: !!s.cur, done, y: res, x });
    // Learn from the result: move the club ratings toward what happened.
    if (done) {
      const A = clamp(res, -90, 90), E = rat[h] - rat[a] + 6;
      rat[h] += 0.07 * (A - E); rat[a] -= 0.07 * (A - E);
    }
  }
}
console.log(`Games built: ${rows.length}. Player features found for ${matched} played games, ${lineupUsed} named teams and ${lastLineupUsed} last-team fallbacks for upcoming games.`);
if (unmappedTeams.size) console.warn('WARNING: team names not recognised (add them to TEAM_ALIASES):', [...unmappedTeams].join(', '));

// ---------------------------------------------------------------------------------------------
// RIDGE REGRESSION
// Solves A w = b by Gaussian elimination (A is small, about 10 by 10).
function solve(A, b) {
  const n = b.length, m = A.map((r, i) => r.concat([b[i]]));
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
    if (Math.abs(m[p][c]) < 1e-12) return null;
    [m[c], m[p]] = [m[p], m[c]];
    for (let r = 0; r < n; r++) if (r !== c) { const f = m[r][c] / m[c][c]; for (let k = c; k <= n; k++) m[r][k] -= f * m[c][k]; }
  }
  return m.map((r, i) => r[n] / r[i]);
}
// Fits the model on training rows. cols says which numbers to use. Each number is rescaled to average 0 and spread 1 first, so
// one penalty (lambda) treats them all fairly. A bigger lambda means smaller, more cautious weights.
function fit(train, cols, lambda) {
  const p = cols.length, mu = [], sd = [];
  cols.forEach((c) => {
    const v = train.map((r) => r.x[c]), m = mean(v);
    mu.push(m); sd.push(Math.sqrt(mean(v.map((q) => (q - m) ** 2))) || 1);
  });
  const ym = mean(train.map((r) => clamp(r.y, -100, 100)));
  const A = Array.from({ length: p }, () => new Array(p).fill(0)), b = new Array(p).fill(0);
  for (const r of train) {
    const z = cols.map((c, k) => (r.x[c] - mu[k]) / sd[k]), y = clamp(r.y, -100, 100) - ym;
    for (let i = 0; i < p; i++) { b[i] += z[i] * y; for (let j = 0; j < p; j++) A[i][j] += z[i] * z[j]; }
  }
  for (let i = 0; i < p; i++) A[i][i] += lambda;
  const w = solve(A, b);
  return w ? { cols, mu, sd, w, ym } : null;
}
const predict = (mod, x) => mod.ym + mod.cols.reduce((s, c, k) => s + mod.w[k] * (x[c] - mod.mu[k]) / mod.sd[k], 0);
const complete = (r, cols) => cols.every((c) => isFinite(r.x[c]));
const ALL_COLS = FEATURES.map((_, i) => i);
// Walk forward: every season is predicted by a model trained only on earlier seasons.
function walk(cols, lambda) {
  const out = new Map();
  const years = [...new Set(rows.map((r) => r.year))].sort((a, b) => a - b);
  for (const yr of years.slice(1)) {
    const train = rows.filter((r) => r.year < yr && r.y != null && complete(r, cols));
    if (train.length < 300) continue;
    const mod = fit(train, cols, lambda);
    if (!mod) continue;
    for (const r of rows) if (r.year === yr && complete(r, cols)) out.set(r.gid, predict(mod, r.x));
  }
  return out;
}
function score(pred) {
  let n = 0, ok = 0, err = 0;
  for (const r of rows) {
    if (r.y == null || !pred.has(r.gid)) continue;
    const p = pred.get(r.gid); n++; err += Math.abs(p - r.y); if (r.y === 0 || (p >= 0) === (r.y > 0)) ok++;
  }
  return { n, mae: n ? err / n : NaN, acc: n ? (ok / n) * 100 : NaN };
}
// Choose the penalty by walk-forward error. Only one number is being chosen, so this barely flatters the result.
let lambda = 100, bestMae = Infinity;
for (const l of [10, 30, 100, 300, 1000, 3000]) {
  const s = score(walk(ALL_COLS, l));
  if (isFinite(s.mae) && s.mae < bestMae) { bestMae = s.mae; lambda = l; }
}
const walkAll = walk(ALL_COLS, lambda), walkBase = walk(BASE_COLS, lambda);
// Compare on the same games for a fair side by side.
const common = new Map([...walkAll].filter(([g]) => walkBase.has(g)));
const baseCommon = new Map([...walkBase].filter(([g]) => common.has(g)));
const evalAll = score(common), evalBase = score(baseCommon);
console.log(`Penalty chosen: ${lambda}`);
console.log(`Walk-forward on ${evalAll.n} games:  rating, rest and travel only: ${evalBase.acc.toFixed(1)}% right, margin error ${evalBase.mae.toFixed(2)}`);
console.log(`                                     plus lineup and form (v2): ${evalAll.acc.toFixed(1)}% right, margin error ${evalAll.mae.toFixed(2)}`);

// The model for games still to be played is trained on everything completed. Other games keep their walk-forward predictions.
const trainAll = rows.filter((r) => r.y != null && complete(r, ALL_COLS));
if (trainAll.length < 300) { console.log('Not enough complete games to train (' + trainAll.length + '). v2 skipped.'); process.exit(1); }
const live = fit(trainAll, ALL_COLS, lambda);
const liveBase = fit(rows.filter((r) => r.y != null && complete(r, BASE_COLS)), BASE_COLS, lambda);
const pred = {};
let fullCount = 0;
for (const r of rows) {
  // Prefer the full model. Where player data is missing (older seasons, or a season the data source has not published yet),
  // fall back to the rating, rest and travel model so v2 still has a tip for every game.
  let p = walkAll.get(r.gid);
  if (p == null) p = walkBase.get(r.gid);
  if (!r.done && complete(r, ALL_COLS)) p = predict(live, r.x);
  else if (!r.done && p == null && liveBase) p = predict(liveBase, r.x);
  if (walkAll.has(r.gid) || (!r.done && complete(r, ALL_COLS))) fullCount++;
  if (p != null && isFinite(p)) pred[r.gid] = Math.round(p * 10) / 10;
}
const weights = FEATURES.map((name, i) => ({ name, w: Math.round(live.w[i] * 100) / 100 }));
console.log('What v2 learned (points of margin per 1 spread of each number):');
weights.forEach((x) => console.log('  ' + x.name.padEnd(28) + (x.w >= 0 ? '+' : '') + x.w.toFixed(2)));
const meta = { builtAt: new Date().toISOString(), lambda, trainGames: trainAll.length, forYear: currentYear,
  eval: { n: evalAll.n, v2: { acc: +evalAll.acc.toFixed(1), mae: +evalAll.mae.toFixed(2) }, base: { acc: +evalBase.acc.toFixed(1), mae: +evalBase.mae.toFixed(2) } } };
writeFileSync(OUT, JSON.stringify({ meta, weights, pred }));
console.log(`Wrote ${OUT}: predictions for ${Object.keys(pred).length} games (${fullCount} with player data, the rest from the rating, rest and travel model).`);
