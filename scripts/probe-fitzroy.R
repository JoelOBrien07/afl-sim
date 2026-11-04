# PROBE: tries the fitzRoy R package's sources (Fryzigg player stats, AFL.com.au lineups, Footywire player stats)
# for one season and reports how many rows and which columns come back. It changes nothing on the website.
suppressMessages(library(fitzRoy))
season <- as.integer(format(Sys.Date(), "%Y")) - 1
out <- character()
add <- function(...) { s <- paste0(...); cat(s, "\n"); out <<- c(out, s) }

probe <- function(label, expr) {
  add("\n### ", label)
  r <- tryCatch(expr, error = function(e) { add("FAILED: ", conditionMessage(e)); NULL })
  if (!is.null(r)) {
    add("rows: ", nrow(r), "   columns: ", ncol(r))
    add("column names: ", paste(names(r), collapse = ", "))
  }
  Sys.sleep(3)
}

probe(paste("Fryzigg player stats", season), fetch_player_stats_fryzigg(season))
probe(paste("Footywire player stats", season, "round 1"), fetch_player_stats_footywire(season, round_number = 1))
probe(paste("AFL.com.au lineups", season, "round 1"), fetch_lineup(season, round_number = 1))

summary_file <- Sys.getenv("GITHUB_STEP_SUMMARY")
if (nzchar(summary_file)) write(c("## fitzRoy sources", out), summary_file, append = TRUE)
