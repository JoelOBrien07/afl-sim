// Fetches AFL fixtures, results and model tips from the Squiggle API and
// writes them to site/data/season.json, which the website loads.
//
// Run locally:   SQUIGGLE_CONTACT="you@example.com" node scripts/fetch-data.mjs
// Squiggle asks every client to identify itself with a contact in the User-Agent.
// Optional: SEASON=2026 to force a year, SQUIGGLE_BASE to point at a mock server.

// Built-in Node helpers for writing files and working out file paths. No npm install needed.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
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

// BASE is the API address (it can be overridden so tests can use a fake server).
// UA is the identifying header sent with every request.
// OUT is where the JSON file is written: site/data/season.json.
const BASE = process.env.SQUIGGLE_BASE || 'https://api.squiggle.com.au/';
const UA = `SirenSim/1.0 (${contact})`;
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../site/data/season.json');
// sleep: pause between requests so we are polite to Squiggle.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// num: the API often sends numbers as text. This turns them into real numbers, or null if missing.
const num = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

// Calls the API, for example get('games;year=2026', 'games'). The key is the name of the list inside the
// response. Tries up to 3 times with growing waits, and throws a clear error if the response is not shaped as expected.
async function get(query, key) {
  const url = `${BASE}?q=${query}`;
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

// Squiggle asks clients not to fire requests at the same time, so go one by one.
const teams = await get('teams', 'teams');
await sleep(1000);
const sources = await get('sources', 'sources');
await sleep(1000);

// Which season? The SEASON environment variable wins, otherwise the current calendar year.
let year = Number(process.env.SEASON) || new Date().getUTCFullYear();
let games = await get(`games;year=${year}`, 'games');
if (games.length === 0 && !process.env.SEASON) {
  year -= 1; // early in the new year the fixture may not be published yet
  await sleep(1000);
  games = await get(`games;year=${year}`, 'games');
}
if (games.length === 0) throw new Error(`No games returned for ${year}`);
await sleep(1000);
const tips = await get(`tips;year=${year}`, 'tips');

// Keep home and away games only, and check the fields we depend on exist.
const regular = games.filter((g) => !num(g.is_final));
const sample = regular[0] || {};
for (const field of ['id', 'round', 'hteamid', 'ateamid']) {
  if (sample[field] === undefined) {
    console.error('Unexpected game format. First game was:', JSON.stringify(sample));
    throw new Error(`Game objects are missing "${field}"`);
  }
}

// Slim each game down to what the website needs (short names keep the file small):
// id, round, h / a = home and away team id, hs / as = home and away score,
// done = 1 once the game has finished (Squiggle marks that as complete = 100), plus date and venue.
const outGames = regular.map((g) => {
  const done = num(g.complete) === 100 && num(g.hscore) !== null && num(g.ascore) !== null;
  return {
    id: g.id,
    round: num(g.round),
    h: num(g.hteamid),
    a: num(g.ateamid),
    hs: done ? num(g.hscore) : null,
    as: done ? num(g.ascore) : null,
    done: done ? 1 : 0,
    date: g.date || '',
    venue: g.venue || '',
  };
});

// Tips: keep one record per model per game. We store the home team's win chance (p) and the predicted
// home margin (m), so the website does not need to care which team a model picked.
const gameById = new Map(outGames.map((g) => [g.id, g]));
const outTips = [];
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
  outTips.push({ g: g.id, s: num(t.sourceid), t: tipTeam, p, m });
}

// The file the website reads: season info, team and model names, games and tips.
const out = {
  meta: {
    year,
    updatedAt: new Date().toISOString(),
    source: 'Squiggle (api.squiggle.com.au)',
  },
  teams: teams.map((t) => ({ id: t.id, name: t.name, abbrev: t.abbrev })),
  sources: sources.map((s) => ({ id: s.id, name: s.name })),
  games: outGames,
  tips: outTips,
};

// Write the file (creates the site/data folder if needed).
await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify(out));

const doneCount = outGames.filter((g) => g.done).length;
console.log(`Season ${year}: ${outGames.length} games (${doneCount} complete), ${outTips.length} tips from ${new Set(outTips.map((t) => t.s)).size} models.`);
if (outTips.length === 0) console.warn('Warning: no tips found. Check the tips field names in Squiggle’s response.');
