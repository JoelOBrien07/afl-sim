// PROBE: checks which extra AFL data sources can be reached from GitHub, and what comes back.
// It does NOT change the website or any data. It makes one small request per source, one at a time with a pause,
// and writes a short report to the workflow run page (the "Summary" at the top of the run).
// Run it from the Actions tab: "Probe data sources" > "Run workflow".
import { appendFileSync } from 'node:fs';

const contact = process.env.SQUIGGLE_CONTACT;
if (!contact) { console.error('Set SQUIGGLE_CONTACT (your email or website) first.'); process.exit(1); }
const UA = `SirenSim data check (${contact})`;
const year = new Date().getFullYear() - 1; // last full season

// Each test: a name, a URL, and what we hope to find in it.
const tests = [
  { name: 'Squiggle ladder by round', url: `https://api.squiggle.com.au/?q=standings;year=${year};round=10`, hope: 'ladder rows with percentage, points for/against' },
  { name: 'AFL Tables season page', url: `https://afltables.com/afl/seas/${year}.html`, hope: 'every match of the season with scores and venue' },
  { name: 'AFL Tables player stats page', url: `https://afltables.com/afl/stats/${year}.html`, hope: 'player totals for the season' },
  { name: 'Footywire match list', url: `https://www.footywire.com/afl/footy/ft_match_list?year=${year}`, hope: 'matches with links to player stats' },
];

const lines = ['## Which sources can GitHub reach?', '', '| Source | Result | Size | Starts with |', '|---|---|---|---|'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (const t of tests) {
  let result, size = '-', start = '';
  try {
    const res = await fetch(t.url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30000) });
    const text = await res.text();
    result = `${res.status} ${res.statusText}`.trim();
    size = `${Math.round(text.length / 1024)} KB`;
    start = text.replace(/\s+/g, ' ').slice(0, 120).replace(/\|/g, '/');
  } catch (e) {
    result = 'FAILED: ' + (e.cause && e.cause.code ? e.cause.code : e.message);
  }
  console.log(`${t.name}: ${result} ${size}`);
  lines.push(`| ${t.name} | ${result} | ${size} | ${start} |`);
  await sleep(3000);
}
const report = lines.join('\n') + '\n';
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report + '\n');
console.log('\n' + report);
