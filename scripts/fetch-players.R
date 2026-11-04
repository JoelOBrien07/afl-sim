# DOWNLOADS PLAYER DATA FOR SIRENSIM v2 (runs in the GitHub Action, after fetch-data.mjs).
# It uses the fitzRoy R package, which knows how to read:
#   - Fryzigg: one row per player per game (kicks, clearances, inside 50s, ratings and so on)
#   - AFL.com.au: the named team for upcoming matches
# It writes two plain text files into the build/ folder. They are INPUTS for scripts/build-v2.mjs and are never published:
#   build/players.tsv   one row per player per game
#   build/lineups.tsv   the named players for the next round (empty if none are announced)
# To be polite to the data providers, past seasons are kept in build/players.tsv between runs (the workflow caches it),
# so only the seasons we do not have yet, and the current season, are downloaded.
# Settings (environment variables): V2_SEASONS = how many seasons to keep, counting the current one (default 10).

suppressMessages(library(fitzRoy))

year <- as.integer(format(Sys.Date(), "%Y"))
n_seasons <- as.integer(Sys.getenv("V2_SEASONS", "10"))
seasons <- (year - n_seasons + 1):year
dir.create("build", showWarnings = FALSE)
players_file <- "build/players.tsv"
lineups_file <- "build/lineups.tsv"

# Reads a column if the data has it, otherwise fills with NA (so a missing stat in an old season does not stop everything).
col <- function(d, name) if (name %in% names(d)) d[[name]] else rep(NA, nrow(d))

# Keeps only the columns we use and gives them short names.
tidy <- function(d) {
  dt <- as.Date(col(d, "match_date"))
  data.frame(
    match_id = col(d, "match_id"),
    date = as.character(dt),
    year = as.integer(format(dt, "%Y")),
    round = col(d, "match_round"),
    home = col(d, "match_home_team"),
    away = col(d, "match_away_team"),
    team = col(d, "player_team"),
    player_id = col(d, "player_id"),
    name = paste(col(d, "player_first_name"), col(d, "player_last_name")),
    rating = col(d, "rating_points"),
    sc = col(d, "supercoach_score"),
    i50 = col(d, "inside_fifties"),
    clr = col(d, "clearances"),
    cp = col(d, "contested_possessions"),
    tkl = col(d, "tackles"),
    si = col(d, "score_involvements"),
    mg = col(d, "metres_gained"),
    # Extra columns for the Fantasy tab: position, AFL Fantasy score, and simple counting stats.
    pos = col(d, "player_position"),
    af = col(d, "afl_fantasy_score"),
    disp = col(d, "disposals"),
    mk = col(d, "marks"),
    gl = col(d, "goals"),
    tog = col(d, "time_on_ground_percentage"),
    # Ingredients for the SuperCoach-style estimate (see the bottom of this script).
    ek = col(d, "effective_kicks"),
    clg = col(d, "clangers"),
    ehb = suppressWarnings(as.numeric(col(d, "effective_disposals")) - as.numeric(col(d, "effective_kicks"))),
    bh = col(d, "behinds"),
    ga = col(d, "goal_assists"),
    cm = col(d, "contested_marks"),
    um = suppressWarnings(as.numeric(col(d, "marks")) - as.numeric(col(d, "contested_marks"))),
    lm = col(d, "marks_on_lead"),
    spl = col(d, "spoils"),
    ffor = col(d, "free_kicks_for"),
    fag = col(d, "free_kicks_against"),
    hta = col(d, "hitouts_to_advantage"),
    gbg = col(d, "ground_ball_gets"),
    upos = col(d, "uncontested_possessions"),
    stringsAsFactors = FALSE
  )
}

# Writes a table as tab separated text with no quotes. Tabs and line breaks inside values are replaced with spaces.
write_tsv <- function(d, file) {
  d[] <- lapply(d, function(x) if (is.character(x)) gsub("[\t\r\n]", " ", x) else x)
  write.table(d, file, sep = "\t", quote = FALSE, row.names = FALSE, na = "NA")
}

# 1. Keep the past seasons we already have. The current season is always downloaded again.
old <- NULL
if (file.exists(players_file)) {
  old <- tryCatch(read.delim(players_file, stringsAsFactors = FALSE, quote = ""), error = function(e) NULL)
}
# A saved file from an older version of this script will not have the newer columns, so it is thrown away and downloaded again.
if (!is.null(old) && !all(c("pos", "af", "disp", "mk", "gl", "tog", "ek", "gbg", "upos") %in% names(old))) old <- NULL
have <- if (!is.null(old)) setdiff(unique(old$year), year) else integer()
if (!is.null(old)) old <- old[old$year %in% have & old$year %in% seasons, ]
need <- setdiff(seasons, have)
cat("Seasons already saved:", paste(sort(have), collapse = ", "), "\n")
cat("Seasons to download:  ", paste(sort(need), collapse = ", "), "\n")

# 2. Download what is missing, one season at a time with a pause between.
fresh <- list()
for (s in sort(need)) {
  d <- tryCatch(fetch_player_stats_fryzigg(s), error = function(e) { cat("Could not get", s, ":", conditionMessage(e), "\n"); NULL })
  if (!is.null(d) && nrow(d) > 0) {
    fresh[[as.character(s)]] <- tidy(d)
    cat("Got", s, ":", nrow(d), "player rows\n")
  }
  Sys.sleep(3)
}
all_rows <- do.call(rbind, c(list(old), fresh))
if (is.null(all_rows) || nrow(all_rows) == 0) {
  cat("No player data available, so v2 will be skipped this run.\n")
  quit(status = 1)
}
all_rows <- all_rows[order(all_rows$date, all_rows$match_id), ]

# SUPERCOACH-STYLE ESTIMATE
# SuperCoach publishes an "indicative" points table built on Champion Data stats. Fryzigg gives us most, but not all, of
# those stats (for example no handball receives, knock ons or smothers). So we add up what we have using the published
# points, which gives "prior". The official scores, where the data has them, are then used to correct for the missing
# pieces: scx = a + b * prior + c * uncontested possessions, fitted by least squares. Where the data has no official
# scores at all, the published points are used as they are (a = 0, b = 1, c = 0), which will run low.
# It is always shown as an ESTIMATE and never as the official score.
n <- function(x) suppressWarnings(as.numeric(x))
points <- c(ek = 4, clg = -4, ehb = 1.5, gl = 8, bh = 1, ga = 3.5, cm = 7, um = 3, lm = 5,
            spl = 2, tkl = 4, ffor = 4, fag = -4, hta = 5, gbg = 4.5)   # contested marks 6 to 8 and uncontested 2 to 4 use the middle
prior <- rep(0, nrow(all_rows))
for (k in names(points)) { v <- n(all_rows[[k]]); prior <- prior + points[[k]] * ifelse(is.na(v), 0, v) }
prior[is.na(n(all_rows$ek)) & is.na(n(all_rows$gbg))] <- NA   # no ingredients at all: no estimate
fit_df <- data.frame(sc = n(all_rows$sc), prior = prior, upos = ifelse(is.na(n(all_rows$upos)), 0, n(all_rows$upos)))
ok <- !is.na(fit_df$sc) & !is.na(fit_df$prior)
fit_note <- "uncalibrated: no official SuperCoach scores in the data, so the published points were used as they are and will run low"
a <- 0; b <- 1; cc <- 0
if (sum(ok) >= 1000) {
  m <- lm(sc ~ prior + upos, data = fit_df[ok, ])
  a <- unname(coef(m)[1]); b <- unname(coef(m)[2]); cc <- unname(coef(m)[3])
  r2 <- summary(m)$r.squared
  mae <- mean(abs(residuals(m)))
  fit_note <- sprintf("calibrated on %d official scores: R squared %.2f, average miss %.1f points", sum(ok), r2, mae)
}
all_rows$scx <- round(a + b * fit_df$prior + cc * fit_df$upos, 1)
cat("SuperCoach-style estimate:", fit_note, "\n")
writeLines(fit_note, "build/scx-fit.txt")

write_tsv(all_rows, players_file)
cat("Saved", nrow(all_rows), "player rows for", length(unique(all_rows$year)), "seasons to", players_file, "\n")

# 3. The named team for the next round (AFL.com.au). This is only useful during a season, so any failure is fine.
lineups <- data.frame(year = integer(), round = integer(), team = character(), name = character(), stringsAsFactors = FALSE)
tryCatch({
  cur <- all_rows[all_rows$year == year, ]
  played <- suppressWarnings(as.integer(gsub("[^0-9]", "", cur$round)))
  next_round <- if (length(played) && any(!is.na(played))) max(played, na.rm = TRUE) + 1 else 1
  lu <- fetch_lineup(year, round_number = next_round)
  if (!is.null(lu) && nrow(lu) > 0) {
    pos <- col(lu, "position")
    keep <- is.na(pos) | !(pos %in% c("EMG", "EMERG"))
    lu <- lu[keep, ]
    lineups <- data.frame(
      year = year, round = next_round, team = col(lu, "teamName"),
      name = paste(col(lu, "player.playerName.givenName"), col(lu, "player.playerName.surname")),
      stringsAsFactors = FALSE)
    cat("Lineups for round", next_round, ":", nrow(lineups), "named players\n")
  }
}, error = function(e) cat("No lineups available:", conditionMessage(e), "\n"))
write_tsv(lineups, lineups_file)
