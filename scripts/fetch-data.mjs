// Fetches AFL data and writes the files the website reads, into site/data/:
//   season.json   the current season: games, scores, venues, weather and model tips (rewritten every run)
//   history.json  previous seasons in the same shape but smaller (downloaded once, then reused from a cache)
//
// Sources:
//   Squiggle API (api.squiggle.com.au)   fixtures, scores, teams, prediction models and their tips
//   Open-Meteo (open-meteo.com)          weather at each ground, free, no key needed
//
// Run locally:   SQUIGGLE_CONTACT="you@example.com" node scripts/fetch-data.mjs
// Squiggle asks every client to identify itself with a contact in the User-Agent.
//
// Optional settings (environment variables):
//   SEASON=2026          force a season year
//   HISTORY_SEASONS=10   how many previous seasons go into history.json (0 turns history off)
//   FORCE_HISTORY=1      download history again even if history.json already exists
//   WEATHER=0            skip weather completely
//   SQUIGGLE_BASE, WEATHER_ARCHIVE_BASE, WEATHER_FORECAST_BASE   point at fake servers when testing

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Squiggle's rules: identify yourself with a contact in the User-Agent. The contact comes from the
// SQUIGGLE_CONTACT environment variable (a repository variable on GitHub). Stop early with a clear message if it is missing.
const contact = (process.env.SQUIGGLE_CONTACT || '').trim();
if (!contact) {
  console.error('SQUIGGLE_CONTACT is not set.');
  console.error('Squiggle requires a contact (email or website) in the User-Agent.');
  console.error('In GitHub: Settings > Secrets and variables > Actions > Variables > New repository variable.');
  process.exit(1);
}

// Addresses of the services (they can be overridden so tests can use fake servers).
const SQUIGGLE = process.env.SQUIGGLE_BASE || 'https://api.squiggle.com.au/';
const ARCHIVE = process.env.WEATHER_ARCHIVE_BASE || 'https://archive-api.open-meteo.com/v1/archive';
const FORECAST = process.env.WEATHER_FORECAST_BASE || 'https://api.open-meteo.com/v1/forecast';
const WEATHER_ON = process.env.WEATHER !== '0';
const HISTORY_SEASONS = process.env.HISTORY_SEASONS === undefined ? 10 : Math.max(0, Number(process.env.HISTORY_SEASONS) || 0);
const FORCE_HISTORY = process.env.FORCE_HISTORY === '1';
// UA is the identifying header sent with every request. DATA_DIR is where the files are written.
const UA = `SirenSim/1.0 (${contact})`;
const DATA_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../site/data');

// sleep: pause between requests so we are polite to the services.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// num: the API often sends numbers as text. This turns them into real numbers, or null if missing.
const num = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const round1 = (v) => Math.round(v * 10) / 10;

// Calls the Squiggle API, for example getSquiggle('games;year=2026', 'games'). The key is the name of the list
// inside the response. Tries up to 3 times with growing waits, and throws a clear error if the response is not shaped as expected.
async function getSquiggle(query, key) {
  const url = `${SQUIGGLE}?q=${query}`;
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (!Array.isArray(json[key])) {
        throw new Error(`expected a "${key}" array, got keys: ${Object.keys(json).join(', ')}`);
      }
      return json[key];
    } catch (err) {
      lastErr = err;
      if (attempt < 3) await sleep(2000 * attempt);
    }
  }
  throw new Error(`Request failed for ${url}: ${lastErr.message}`);
}

// ---------------------------------------------------------------------------------------------
// GROUNDS
// Squiggle gives each game a venue name. This table turns names into coordinates, which we need for
// weather and for how far each team travels. Each row is: a pattern that matches the venue name,
// then latitude and longitude. A venue that matches nothing is reported in the log and left without
// coordinates (the site then treats the game as played in the home team's city).
const VENUES = [
  [/m\.?c\.?g|melbourne cricket/i, -37.8199, 144.9834],
  [/docklands|marvel|etihad|telstra dome|colonial/i, -37.8165, 144.9475],
  [/adelaide oval/i, -34.9156, 138.5958],
  [/football park|aami/i, -34.8797, 138.4897],
  [/optus|perth stadium/i, -31.9512, 115.889],
  [/subiaco/i, -31.9444, 115.825],
  [/gabba/i, -27.4858, 153.0381],
  [/s\.?c\.?g|sydney cricket/i, -33.8914, 151.2246],
  [/gmhba|kardinia|simonds|skilled/i, -38.158, 144.3544],
  [/metricon|carrara|people first|heritage bank/i, -28.0066, 153.368],
  [/showground|engie|spotless|giants stadium/i, -33.8442, 151.0692],
  [/manuka/i, -35.3181, 149.1346],
  [/york park|utas|launceston|aurora/i, -41.426, 147.1385],
  [/bellerive|blundstone/i, -42.8767, 147.3714],
  [/mars stadium|eureka|ballarat/i, -37.5527, 143.8431],
  [/marrara|tio |darwin/i, -12.4004, 130.8841],
  [/traeger|alice springs/i, -23.7108, 133.875],
  [/cazaly|cairns/i, -16.928, 145.751],
  [/riverway|townsville/i, -19.2897, 146.754],
  [/norwood/i, -34.9226, 138.633],
  [/westpac|wellington/i, -41.273, 174.786],
  [/jiangwan|shanghai/i, 31.3, 121.51],
  [/princes park|ikon/i, -37.7842, 144.9587],
  [/whitten|western oval/i, -37.792, 144.883],
  [/moorabbin/i, -37.939, 145.042],
];
const unknownVenues = new Set();
// Returns [latitude, longitude] for a venue name, or null if we do not know it.
function venueLoc(name) {
  if (!name) return null;
  for (const [re, lat, lon] of VENUES) if (re.test(name)) return [lat, lon];
  unknownVenues.add(name);
  return null;
}

// ---------------------------------------------------------------------------------------------
// GAMES
// Turns a date like "2026-03-14 19:30:00" into unix seconds. The site only uses DIFFERENCES between these
// (days of rest), so it does not matter that the clock time is local rather than UTC.
function parseUnix(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(s || ''));
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) / 1000 : null;
}
// Slims one Squiggle game down to what the website needs (short names keep the files small):
//   id, round, h / a = home and away team id, hs / as = home and away score,
//   done = 1 once the game has finished (Squiggle marks that as complete = 100), date, venue text,
//   u = kickoff in unix seconds, vl = [lat, lon] of the ground, wx = weather (filled in later).
function toGame(g) {
  const hs = num(g.hscore);
  const as = num(g.ascore);
  const done = num(g.complete) === 100 && hs !== null && as !== null;
  const u = num(g.unixtime);
  return {
    id: g.id,
    round: num(g.round),
    h: num(g.hteamid),
    a: num(g.ateamid),
    hs: done ? hs : null,
    as: done ? as : null,
    done: done ? 1 : 0,
    date: g.date || '',
    venue: g.venue || '',
    u: u !== null ? u : parseUnix(g.localtime || g.date),
    vl: venueLoc(g.venue),
    wx: null,
  };
}
// Keeps home and away games only (no finals), converts them, and checks the fields we depend on exist.
function convertGames(rawGames) {
  const regular = rawGames.filter((g) => !num(g.is_final));
  const sample = regular[0] || {};
  for (const field of ['id', 'round', 'hteamid', 'ateamid']) {
    if (sample[field] === undefined) {
      console.error('Unexpected game format. First game was:', JSON.stringify(sample));
      throw new Error(`Game objects are missing "${field}"`);
    }
  }
  return { raw: regular, games: regular.map(toGame) };
}

// Tips: keep one record per model per game. We store the home team's win chance (p) and the predicted
// home margin (m), so the website does not need to care which team a model picked.
function convertTips(tips, gameById) {
  const out = [];
  for (const t of tips) {
    const g = gameById.get(t.gameid);
    if (!g) continue; // skip finals and unknown games
    const tipTeam = num(t.tipteamid);
    if (tipTeam === null) continue;
    // Probability that the HOME team wins, 0 to 100.
    let p = num(t.hconfidence);
    if (p === null && num(t.confidence) !== null) p = tipTeam === g.h ? num(t.confidence) : 100 - num(t.confidence);
    // Predicted margin from the HOME team's point of view.
    let m = num(t.hmargin);
    if (m === null && num(t.margin) !== null) m = tipTeam === g.h ? num(t.margin) : -num(t.margin);
    out.push({ g: g.id, s: num(t.sourceid), t: tipTeam, p, m });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// WEATHER (Open-Meteo)
// One request per ground and time span. Past games come from the archive of real weather (it lags a few
// days behind), games in the next two weeks come from the forecast. Weather is a bonus: if any request
// fails we log it and carry on without weather for those games.
async function weatherRequest(base, params) {
  const url = `${base}?${params}&hourly=temperature_2m,precipitation,wind_speed_10m&timezone=auto`;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      if (!j.hourly || !Array.isArray(j.hourly.time)) throw new Error('no hourly data in response');
      return j.hourly;
    } catch (e) {
      if (attempt === 2) {
        console.warn(`Weather request failed (${e.message}): ${url}`);
        return null;
      }
      await sleep(1500);
    }
  }
  return null;
}
// Averages the first three hours of a game (about when most of the play happens). Returns
// [temperature C, rain mm over those hours, wind km/h] or null when the hour is missing.
// "local" is the kickoff in local time, which matches Open-Meteo's local-time hours.
function pickWeather(h, local) {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2})/.exec(local);
  if (!m) return null;
  const i = h.time.indexOf(`${m[1]}T${m[2]}:00`);
  if (i < 0) return null;
  let t = 0, r = 0, w = 0, n = 0;
  for (let k = i; k < Math.min(i + 3, h.time.length); k++) {
    if (h.temperature_2m[k] == null || h.precipitation[k] == null || h.wind_speed_10m[k] == null) continue;
    t += h.temperature_2m[k];
    r += h.precipitation[k];
    w += h.wind_speed_10m[k];
    n++;
  }
  return n ? [round1(t / n), round1(r), round1(w / n)] : null;
}
// Fills game.wx for every game it can. rawById holds Squiggle's original game objects (for the local kickoff time).
async function addWeather(games, rawById) {
  if (!WEATHER_ON) return 0;
  const DAY = 86400000;
  const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
  const archiveCut = iso(Date.now() - 6 * DAY); // the archive is complete up to about 5 days ago
  const horizon = iso(Date.now() + 15 * DAY); // forecasts reach about 16 days ahead
  const groups = new Map();
  for (const g of games) {
    if (!g.vl) continue;
    const raw = rawById.get(g.id) || {};
    const local = String(raw.localtime || raw.date || '');
    const day = local.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    const kind = day <= archiveCut ? 'archive' : day <= horizon ? 'forecast' : null;
    if (!kind) continue;
    const key = `${kind}|${g.vl[0]}|${g.vl[1]}`;
    let grp = groups.get(key);
    if (!grp) { grp = { kind, lat: g.vl[0], lon: g.vl[1], items: [] }; groups.set(key, grp); }
    grp.items.push({ g, local, day });
  }
  let filled = 0;
  for (const grp of groups.values()) {
    const days = grp.items.map((x) => x.day).sort();
    const loc = `latitude=${grp.lat}&longitude=${grp.lon}`;
    const hourly = grp.kind === 'archive'
      ? await weatherRequest(ARCHIVE, `${loc}&start_date=${days[0]}&end_date=${days[days.length - 1]}`)
      : await weatherRequest(FORECAST, `${loc}&past_days=7&forecast_days=16`);
    await sleep(300);
    if (!hourly) continue;
    for (const x of grp.items) {
      const w = pickWeather(hourly, x.local);
      if (w) { x.g.wx = w; filled++; }
    }
  }
  return filled;
}

// ---------------------------------------------------------------------------------------------
// ONE SEASON
// Downloads one season's games and tips, adds weather, and returns both in the slim format.
async function loadSeason(year) {
  const rawGames = await getSquiggle(`games;year=${year}`, 'games');
  if (rawGames.length === 0) return null;
  await sleep(1000);
  const rawTips = await getSquiggle(`tips;year=${year}`, 'tips');
  const { raw, games } = convertGames(rawGames);
  const rawById = new Map(raw.map((g) => [g.id, g]));
  const filled = await addWeather(games, rawById);
  const gameById = new Map(games.map((g) => [g.id, g]));
  return { year, games, tips: convertTips(rawTips, gameById), weatherGames: filled };
}

// ---------------------------------------------------------------------------------------------
// MAIN
// Squiggle asks clients not to fire requests at the same time, so go one by one.
const teams = await getSquiggle('teams', 'teams');
await sleep(1000);
const sources = await getSquiggle('sources', 'sources');
await sleep(1000);

// Which season? The SEASON environment variable wins, otherwise the current calendar year.
// Early in a new year the fixture may not be published yet, so fall back to last year.
let year = Number(process.env.SEASON) || new Date().getUTCFullYear();
let current = await loadSeason(year);
if (!current && !process.env.SEASON) {
  year -= 1;
  await sleep(1000);
  current = await loadSeason(year);
}
if (!current) throw new Error(`No games returned for ${year}`);

await mkdir(DATA_DIR, { recursive: true });
const season = {
  meta: {
    year,
    updatedAt: new Date().toISOString(),
    source: 'Squiggle (api.squiggle.com.au). Weather by Open-Meteo (open-meteo.com).',
  },
  teams: teams.map((t) => ({ id: t.id, name: t.name, abbrev: t.abbrev })),
  sources: sources.map((s) => ({ id: s.id, name: s.name })),
  games: current.games,
  tips: current.tips,
};
await writeFile(join(DATA_DIR, 'season.json'), JSON.stringify(season));
const done = current.games.filter((g) => g.done).length;
console.log(`Season ${year}: ${current.games.length} games (${done} complete), ${current.tips.length} tips from ${new Set(current.tips.map((t) => t.s)).size} models, weather for ${current.weatherGames} games.`);
if (current.tips.length === 0) console.warn('Warning: no tips found. Check the tips field names in Squiggle’s response.');

// HISTORY. Past seasons never change, so we only download them when history.json is missing or was built
// for a different current season. The GitHub workflow keeps history.json in a cache between runs, which is
// how we respect Squiggle's request not to download the same data again and again.
if (HISTORY_SEASONS > 0) {
  let existing = null;
  try { existing = JSON.parse(await readFile(join(DATA_DIR, 'history.json'), 'utf8')); } catch { /* none yet */ }
  if (!FORCE_HISTORY && existing && existing.meta && existing.meta.forYear === year && existing.meta.wanted === HISTORY_SEASONS) {
    console.log(`History: reusing saved history.json (${existing.seasons.length} seasons, built ${existing.meta.updatedAt}).`);
  } else {
    const seasons = [];
    for (let y = year - HISTORY_SEASONS; y < year; y++) {
      await sleep(1000);
      try {
        const s = await loadSeason(y);
        if (!s) { console.warn(`History: no games for ${y}, skipping.`); continue; }
        // Tips are stored as short lists [game id, model id, home win chance, home margin] to save space.
        seasons.push({
          year: y,
          games: s.games,
          tips: s.tips.map((t) => [t.g, t.s, t.p === null ? null : round1(t.p), t.m === null ? null : round1(t.m)]),
        });
        console.log(`History ${y}: ${s.games.length} games, ${s.tips.length} tips, weather for ${s.weatherGames} games.`);
      } catch (e) {
        console.warn(`History: could not load ${y} (${e.message}), skipping.`);
      }
    }
    if (seasons.length) {
      const history = { meta: { forYear: year, wanted: HISTORY_SEASONS, years: seasons.map((s) => s.year), updatedAt: new Date().toISOString() }, seasons };
      await writeFile(join(DATA_DIR, 'history.json'), JSON.stringify(history));
    } else {
      console.warn('History: nothing could be downloaded, the Backtest tab will be empty.');
    }
  }
}

if (unknownVenues.size) console.warn('Venues with no coordinates (add them to the VENUES table in this script):', [...unknownVenues].join(', '));
