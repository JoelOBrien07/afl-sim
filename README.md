# SirenSim

An AFL season simulator. It plays the rest of the season thousands of times in your browser and shows each club's chance of the top four, the finals and the flag. It also lists predictions from public Squiggle models and scores how accurate each one has been.

Everything runs in the browser. A scheduled GitHub Action downloads fresh data from the [Squiggle API](https://api.squiggle.com.au/) and publishes the site, so hosting is free.

## Working on it in VS Code

1. Install [Node.js](https://nodejs.org) 20 or newer. Check with `node -v` in the VS Code terminal.
2. In VS Code choose **File > Open Folder** and pick the `siren-sim-repo` folder.
3. Install the **Live Server** extension (by Ritwick Dey). You can double-click `site/index.html`, but browsers block the page from loading `data/season.json` that way, so you would only see the example season. Right-click `site/index.html` and choose **Open with Live Server** instead.
4. To pull real data, open a terminal (**Terminal > New Terminal**) and run one of these. Use your own email or website as the contact, because Squiggle asks every user to identify themselves.
   - Mac or Linux: `SQUIGGLE_CONTACT="you@example.com" node scripts/fetch-data.mjs`
   - Windows PowerShell: `$env:SQUIGGLE_CONTACT="you@example.com"; node scripts/fetch-data.mjs`
5. That creates `site/data/season.json`. Refresh the page and the badge near the top changes from "Example season" to "Live data".

Use the **Source Control** panel in the left sidebar to commit and push. `site/data/season.json` is in `.gitignore` on purpose, because the GitHub Action makes a fresh one every time it deploys.

## Put it on GitHub Pages (about 5 minutes)

1. Create a new GitHub repository and push this folder to it (keep the folder structure, including the hidden `.github` folder).
2. Squiggle asks every client to identify itself. In your repo go to **Settings > Secrets and variables > Actions > Variables tab > New repository variable**.
   - Name: `SQUIGGLE_CONTACT`
   - Value: your email address or website
3. Go to **Settings > Pages** and set **Source** to **GitHub Actions**.
4. Open the **Actions** tab, pick **Update data and deploy**, and click **Run workflow**.
5. When it finishes (about a minute), your site is live at `https://<your-username>.github.io/<repo-name>/`.

After that it refreshes itself every 6 hours. GitHub pauses scheduled workflows on repos with no activity for 60 days, so click **Run workflow** once if the data ever stops updating.

## What is in here

| Path | What it does |
|---|---|
| `site/index.html` | The whole website in one file (styles, page and script, no build step) |
| `scripts/fetch-data.mjs` | Downloads games, results and model tips from Squiggle, plus weather from Open-Meteo, and writes `site/data/season.json` (this season) and `site/data/history.json` (past seasons) |
| `scripts/fetch-players.R` | Downloads player level stats and the named teams (R, using the fitzRoy package) into `build/` for SirenSim v2 |
| `scripts/build-players.mjs` | Turns the player table into game logs for the Fantasy tab (`site/data/players.json`) |
| `scripts/build-v2.mjs` | Builds lineup and form numbers, trains SirenSim v2 and writes `site/data/v2.json` |
| `scripts/probe-sources.mjs`, `scripts/probe-fitzroy.R`, `.github/workflows/probe-sources.yml` | A manual check of which extra data sources GitHub can reach. Not part of the site |
| `.github/workflows/update-data.yml` | Runs the scripts on a schedule and publishes the site |
| `.gitignore` | Keeps the generated data files and the raw player data (`build/`) out of git |

If `site/data/season.json` is missing, the site falls back to a clearly labelled example season so you can still try it.

## Finding your way around `site/index.html`

Every section has a comment banner, so searching for the words in the table below (Ctrl+F or Ctrl+Shift+F in VS Code) jumps to it.

| Part | Search for | What it does |
|---|---|---|
| Styles | `STYLES` | All colours are variables at the top. Change them there and the whole site follows |
| Page layout | `TAB 1` to `TAB 8` | One HTML section per tab. Most are filled in by the script |
| How the script is organised | `HOW THIS SCRIPT IS ORGANISED` | Overview of the engine, UI and boot sections, plus a glossary of terms |
| Season data | `SEASON DATA`, `EXAMPLE SEASON`, `REAL SEASON` | How games are stored, the made-up example season, and the loader for real data |
| Ratings | `RATINGS FROM RESULTS` | Works out how strong each club is from results |
| Simulation maths | `THE SIMULATION` | Plays seasons and finals. Does not touch the page |
| Model scoring | `MODEL TIPS` | Accuracy, bits and margin error for each Squiggle model |
| What predicts each game | `PREDICTION SOURCES`, `YOUR OWN MODEL` | Turns the chosen source into an expected margin per game, and where a custom model goes |
| Running simulations | `RUNNING SIMULATIONS` | Runs thousands of seasons in chunks so the page stays responsive |
| Drawing the page | `RENDER FUNCTIONS`, `MODELS TAB` | Functions named `renderLadder`, `renderClub`, `renderModels` and so on |
| Tabs, buttons and sliders | `TABS`, `CONTROLS` | What happens when you move a slider, click something or change tab |
| Our model, backtest, weather | `OUR OWN MODEL`, `TIMELINE`, `SCORING PREDICTORS`, `WEATHER EFFECTS`, `BACKTEST TAB` | SirenSim v1 (rating + rest + travel), scoring every predictor on past games, and the rain/wind fit |
| Fantasy tab | `FANTASY TAB`, `renderFantasy`, `#view-fantasy` | Player scores, form and game logs. The green look is in the `FANTASY TAB` block at the end of the styles |
| SirenSim v2 on the site | `renderV2Box`, `loadV2`, `siren2` | Loads `data/v2.json`, scores it on the Backtest tab, shows what it learned |
| Start-up | `BOOT` | Loads the data and runs the first simulation |

Searching in VS Code is not case sensitive by default, so Ctrl+Shift+F finds these from any file.

## Common changes

- **Colours:** the `:root` block at the top of the `<style>` section.
- **Default home ground advantage or volatility:** the `hga` and `sd` values in the `state` object, and the matching `value` on the two sliders.
- **How many seasons by default:** the `selected` option in the `Seasons per run` dropdown.
- **How often the data refreshes:** the `cron` line in `.github/workflows/update-data.yml`.
- **Add a new tab:** add a link in the `<nav class="tabs">`, add a `<section class="view" id="view-NAME" hidden>`, add `'NAME'` to the `TABS` list in the script, and write a `renderNAME` function that is called from `renderAll`.

## How the data is used

- **Fixtures and results:** the real games and scores for the season. The rounds-played slider rewinds the season to any round.
- **Model tips:** every Squiggle model's pick, win chance and predicted margin for each game. They are scored on completed games for accuracy, bits and margin error (Models tab) and they drive the simulation (below).
- **Prediction source (Simulator tab):** decides where the sim gets the expected margin for every game still to be played. The default is all Squiggle models averaged. You can also pick the top 6 models by accuracy, any single model, or club ratings only. "Use model tips for" limits models to the next 1, 2 or 4 rounds, which keeps a rewound season realistic, because live the models only tip a round or two ahead.
- **Club ratings:** fitted from the season's results (average margin, adjusted for opponent strength and home advantage). They are the fallback for games no model has tipped, and they decide the finals. They are noisy early in the season. Edit them in the Simulator tab.

## SirenSim v1, the Backtest tab and weather

- **SirenSim v1** is our own model: Elo-style club ratings plus days of rest plus travel distance. It only ever uses results from before the game it is tipping, so its scores are honest. Its settings are sliders on the Backtest tab. It is also in the Prediction source dropdown on the Simulator tab.
- **Backtest tab** replays past seasons (from `history.json`) and marks every Squiggle model, the consensus, SirenSim v1 and an "always tip the home side" baseline. The oldest season is only used to warm the model up. Accuracy shows a 95% margin of error: gaps smaller than it are noise. Do not tune the sliders on the same seasons you judge the model on.
- **Weather** comes from [Open-Meteo.com](https://open-meteo.com/) (CC BY 4.0, keep the credit in the page). Rain and wind are fitted against total points from history, and upcoming games with a forecast get a different expected total and more randomness when wet. Untick "Use weather" on the Simulator tab to turn that off.
- **History is cached.** Past seasons never change, so the workflow saves `history.json` between runs. To force a fresh download, change `history-v2` to `history-v3` in `.github/workflows/update-data.yml`. Locally, set `FORCE_HISTORY=1`. `HISTORY_SEASONS` (default 10) sets how many past seasons, and `WEATHER=0` skips weather.
- Unknown grounds are listed in the data script's log. Add them to the `VENUES` table in `scripts/fetch-data.mjs`.

## SirenSim v2 (learns from player data)

v2 looks for patterns instead of using hand-made rules. For every game it builds these numbers using only what was known beforehand: club rating gap, rest, travel, **lineup strength** (how good the 22 players on the team sheet are, from their recent form in Fryzigg's ratings) and **team form** (inside 50s, clearances, contested possessions, tackles, score involvements and metres gained compared with opponents). A ridge regression then learns how many points of margin each is worth.

- **Honest testing:** each season is only predicted by a model trained on earlier seasons. Upcoming games use a model trained on everything played so far. The Backtest tab shows v2 next to v1 and the Squiggle models, and a table of what v2 learned, plus how it compares with the same model using only rating, rest and travel.
- **Where it runs:** in the Action, in the block of steps marked SirenSim v2. These steps are allowed to fail without stopping the deploy. If v2 is missing from the site, open the run in the Actions tab and look at **Download player data** and **Build SirenSim v2**.
- **Data used by v2:** player stats come from [Fryzigg](https://cran.r-project.org/web/packages/fitzRoy/vignettes/using-fryzigg-stats.html) and named teams from AFL.com.au, both through the [fitzRoy](https://cran.r-project.org/web/packages/fitzRoy/vignettes/fitzRoy.html) R package. Please read their terms of use before sharing the site outside your team. The raw player data lives only in `build/` on the build machine and is **never published**. Only our own predictions and the learned weights go into `site/data/v2.json`.
- **Caching:** the player data is saved between runs and only new seasons and the current season are downloaded. To force a full re-download, change `players-v1` to `players-v2` in the workflow.
- **Running it locally** needs R with the fitzRoy package: `SQUIGGLE_CONTACT="you@example.com" node scripts/fetch-data.mjs`, then `Rscript scripts/fetch-players.R`, then `node scripts/build-v2.mjs`.
- **Known limits:** for past games the lineup is the team that actually played (including late changes), while upcoming games use the named team or, before one is named, each side's last team. Footywire blocks automated downloads, so it is not used. Season average ratings are used to put scores on one scale, which very slightly looks ahead within a season.

## Fantasy tab

A green, player-focused section: season and scoring picker (SuperCoach score, AFL Fantasy score or rating points), spotlight cards (best average, hottest and coldest form, most reliable), a sortable and filterable table with a last-10 sparkline, a player page with a bar chart and game log, and round leaders.

- **Data:** `site/data/players.json`, built by `scripts/build-players.mjs` from the same player table v2 uses. It holds the last two seasons. The Action step is called "Build Fantasy player data" and is allowed to fail without stopping the deploy.
- **Unlike the rest of the player data, this file IS published**, because it contains each player's game scores. Please read the Fryzigg and AFL.com.au terms before sharing the site beyond your team. If you would rather not publish it, delete the `Build Fantasy player data` step in the workflow and the tab will show a "no player data" message.
- **SuperCoach-style estimate:** if the data source has no official SuperCoach scores, the tab shows our own estimate instead. `scripts/fetch-players.R` adds up the Champion Data stats we have using the points table SuperCoach publishes, then corrects it against official scores where the data has any (the fit is printed in the Actions log and shown on the tab). Stats the data does not have (handball receives, knock ons, smothers) are missing, so it is an approximation, always labelled as an estimate.
- **Not SuperCoach:** the tab uses the scores as supplied by Fryzigg and shows no prices, break-evens or logos. Keep it that way so it is not mistaken for an official product. The tab is called Fantasy for that reason.
- **Positions** are grouped as DEF, MID, RUC and FWD from Fryzigg's position codes. Any code the script does not recognise is printed in the Actions log; add it to `posGroup` in `scripts/build-players.mjs`.
- **Cache:** the Action's saved player data key is now `players-v3`, because the Fantasy tab needs extra columns. The old saved file is ignored automatically. It is now `players-v3`.

## Adding your own model later

The sim is built so your team's own model can sit alongside the Squiggle ones. Search `YOUR OWN MODEL` in `site/index.html`. A custom model is one object added to the `CUSTOM_MODELS` list:

```js
CUSTOM_MODELS.push({
  id: 'siren1',                 // short unique word
  name: 'SirenSim v1',          // shown in the Prediction source dropdown
  predict: g => {               // g is the game number
    // return the expected margin (home score minus away score, in points),
    // or null if the model has no opinion about this game
    return 5;
  }
});
```

It then appears in the Prediction source dropdown on the Simulator tab, and the sim uses its margins for every game it returns a number for. Inside `predict` you can use `GH[g]` and `GA[g]` (home and away team), `GR[g]` (round), `GDATE[g]` (date), `HAS[g]` and `AM[g]` (results for games already played), and the other models' tips through `M.byGame.get(g)`. Model margins should already include home ground advantage.

SirenSim v1 is added this way (search `siren1`). It is scored separately through the timeline, so a new model that needs scoring should be added in `backtestRows` and `extraRows`.

## If the data refresh fails

Open the failed run in the **Actions** tab. The script prints what it received and which field was missing. The field names it reads are in the game and tip mapping in `scripts/fetch-data.mjs`, so any fix is a one-line change.

Data from [Squiggle](https://squiggle.com.au/). Please keep the contact variable set and avoid running the refresh more often than every few hours.
