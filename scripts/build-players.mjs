// BUILDS THE FANTASY TAB'S DATA: site/data/players.json
// Reads the player-per-game table downloaded by scripts/fetch-players.R (build/players.tsv) and writes one game log per
// player for the last two seasons. The website works out averages, form and so on itself, so this file only has to hold
// the games. Each game is a short list of numbers:
//   [round, date, opponent team id, home (1) or away (0), SuperCoach score, AFL Fantasy score, rating points,
//    disposals, marks, goals, tackles, time on ground %, estimated SuperCoach-style score]
// The last number is OUR estimate built from Champion Data stats using SuperCoach's published points table (see fetch-players.R).
// It is never the official score.
// Team ids are the same ones Squiggle uses (1 to 18), so the website can look up club names and colours.
// Settings (environment variables): DATA_DIR (default site/data), PLAYERS_FILE (build/players.tsv), FANTASY_SEASONS (default 2).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

const DATA = process.env.DATA_DIR || 'site/data';
const PLAYERS_FILE = process.env.PLAYERS_FILE || 'build/players.tsv';
const KEEP = Number(process.env.FANTASY_SEASONS || 2);
const OUT = DATA + '/players.json';

const num = (v) => { const n = Number(v); return v === undefined || v === '' || v === 'NA' || !isFinite(n) ? null : n; };
// Same club-name tidy up as build-v2.mjs: any spelling becomes one short key.
const ALIASES = {
  adelaide: 'adelaide', adelaidecrows: 'adelaide', brisbane: 'brisbane', brisbanelions: 'brisbane', carlton: 'carlton', carltonblues: 'carlton',
  collingwood: 'collingwood', collingwoodmagpies: 'collingwood', essendon: 'essendon', essendonbombers: 'essendon', fremantle: 'fremantle',
  fremantledockers: 'fremantle', geelong: 'geelong', geelongcats: 'geelong', goldcoast: 'goldcoast', goldcoastsuns: 'goldcoast',
  gws: 'gws', greaterwesternsydney: 'gws', gwsgiants: 'gws', giants: 'gws', hawthorn: 'hawthorn', hawthornhawks: 'hawthorn',
  melbourne: 'melbourne', melbournedemons: 'melbourne', northmelbourne: 'northmelbourne', kangaroos: 'northmelbourne',
  portadelaide: 'portadelaide', portadelaidepower: 'portadelaide', richmond: 'richmond', richmondtigers: 'richmond',
  stkilda: 'stkilda', stkildasaints: 'stkilda', sydney: 'sydney', sydneyswans: 'sydney', westcoast: 'westcoast', westcoasteagles: 'westcoast',
  westernbulldogs: 'bulldogs', footscray: 'bulldogs', bulldogs: 'bulldogs',
};
const unknownTeams = new Set(), unknownPos = new Map();
const tkey = (n) => { const k = String(n || '').toLowerCase().replace(/[^a-z]/g, ''); return ALIASES[k] || (unknownTeams.add(n), k); };

// Turns Fryzigg's position code or word into one of four groups.
function posGroup(raw) {
  const s = String(raw || '').toUpperCase().trim();
  if (!s || s === 'NA') return null;
  if (['RK'].includes(s) || /RUCK/.test(s) && !/ROVER/.test(s)) return 'RUC';
  if (['R', 'RR', 'C', 'WL', 'WR', 'W'].includes(s) || /MID|CENTRE|WING|ROVER/.test(s)) return 'MID';
  if (['BPL', 'BPR', 'CHB', 'FB', 'HBFL', 'HBFR', 'BP', 'HB'].includes(s) || /DEF|BACK/.test(s)) return 'DEF';
  if (['FPL', 'FPR', 'CHF', 'FF', 'HFFL', 'HFFR', 'FP', 'HF'].includes(s) || /FORW|FWD/.test(s)) return 'FWD';
  if (['INT', 'SUB', 'S', 'I'].includes(s)) return null;   // interchange or substitute: no fixed position
  unknownPos.set(s, (unknownPos.get(s) || 0) + 1);
  return null;
}
// Turns "Round 5" or "5" into 5, and finals into short labels.
function roundLabel(r) {
  const s = String(r || '');
  const n = parseInt(s.replace(/[^0-9]/g, ''), 10);
  if (isFinite(n) && !/final/i.test(s)) return n;
  if (/grand/i.test(s)) return 'GF';
  if (/prelim/i.test(s)) return 'PF';
  if (/semi/i.test(s)) return 'SF';
  if (/elim/i.test(s)) return 'EF';
  if (/qual/i.test(s)) return 'QF';
  return s || '?';
}

if (!existsSync(PLAYERS_FILE) || !existsSync(DATA + '/season.json')) { console.log('Missing player data or season.json, so the Fantasy data is skipped.'); process.exit(1); }
const season = JSON.parse(readFileSync(DATA + '/season.json', 'utf8'));
const idByKey = new Map((season.teams || []).map((t) => [tkey(t.name), t.id]));
const lines = readFileSync(PLAYERS_FILE, 'utf8').split(/\r?\n/).filter(Boolean);
const head = lines.shift().split('\t');
const col = Object.fromEntries(head.map((h, i) => [h, i]));
if (!('pos' in col) || !('af' in col)) { console.log('players.tsv has no position or fantasy columns yet. Re-download it (change the players cache key).'); process.exit(1); }

const years = [...new Set(lines.map((l) => l.split('\t')[col.year]))].map(Number).filter(Boolean).sort((a, b) => b - a).slice(0, KEEP);
const out = {};
for (const y of years) out[y] = new Map();
for (const l of lines) {
  const c = l.split('\t'), y = Number(c[col.year]);
  if (!out[y]) continue;
  const team = idByKey.get(tkey(c[col.team])), home = tkey(c[col.home]), away = tkey(c[col.away]), mine = tkey(c[col.team]);
  const oppKey = mine === home ? away : home, opp = idByKey.get(oppKey);
  if (!team || !opp) continue;
  let p = out[y].get(c[col.player_id]);
  if (!p) { p = { id: c[col.player_id], n: c[col.name], t: team, pos: new Map(), g: [] }; out[y].set(c[col.player_id], p); }
  p.t = team;   // latest club wins if a player moved mid season
  const pg = posGroup(c[col.pos]);
  if (pg) p.pos.set(pg, (p.pos.get(pg) || 0) + 1);
  p.g.push([roundLabel(c[col.round]), c[col.date], opp, mine === home ? 1 : 0, num(c[col.sc]), num(c[col.af]), num(c[col.rating]),
    num(c[col.disp]), num(c[col.mk]), num(c[col.gl]), num(c[col.tkl]), num(c[col.tog]), 'scx' in col ? num(c[col.scx]) : null]);
}
const seasons = {};
for (const y of years) {
  const list = [];
  for (const p of out[y].values()) {
    p.g.sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
    const top = [...p.pos.entries()].sort((a, b) => b[1] - a[1])[0];
    list.push({ id: p.id, n: p.n, t: p.t, p: top ? top[0] : '–', g: p.g });
  }
  list.sort((a, b) => (a.n < b.n ? -1 : 1));
  seasons[y] = list;
  // How many games have each score. A zero here means the data source has no values for that scoring system that season.
  const have = [4, 5, 6, 12].map((i) => list.reduce((s, p) => s + p.g.filter((g) => g[i] != null).length, 0));
  console.log(`${y}: ${list.length} players, ${list.reduce((s, p) => s + p.g.length, 0)} games. Games with a SuperCoach score: ${have[0]}, AFL Fantasy: ${have[1]}, rating points: ${have[2]}, SuperCoach-style estimate: ${have[3]}`);
}
if (unknownTeams.size) console.warn('WARNING: unrecognised team names:', [...unknownTeams].join(', '));
if (unknownPos.size) console.warn('NOTE: unrecognised position codes (add them to posGroup):', [...unknownPos.entries()].map(([k, v]) => k + ' x' + v).join(', '));
const fitFile = dirname(PLAYERS_FILE) + '/scx-fit.txt';
const scxFit = existsSync(fitFile) ? readFileSync(fitFile, 'utf8').trim() : null;
writeFileSync(OUT, JSON.stringify({ meta: { builtAt: new Date().toISOString(), seasons: years, scxFit }, seasons }));
console.log('Wrote ' + OUT);
