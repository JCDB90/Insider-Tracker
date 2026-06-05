#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Insider Tracker — Daily Cron Script
#
# Cron entry (run as root or deploy user):
#   0 22 * * * /opt/insider-tracker/scripts/run-daily.sh
#   (22:00 UTC = 23:00 CET winter / 00:00 CEST summer)
#
# Logs written to: /opt/insider-tracker/logs/scrape-YYYY-MM-DD.log
# Logs kept for:   30 days
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

# ── Paths ────────────────────────────────────────────────────────────────────

APP_DIR="/opt/insider-tracker"
LOG_DIR="${APP_DIR}/logs"
LOG_FILE="${LOG_DIR}/scrape-$(date +%Y-%m-%d).log"
ENV_FILE="${APP_DIR}/.env"
NODE_BIN="$(which node)"

# ── Sanity checks ────────────────────────────────────────────────────────────

# ── Lock (prevent concurrent runs) ───────────────────────────────────────────
LOCK_FILE="/tmp/insider-tracker-daily.lock"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "$(date -u '+%Y-%m-%d %H:%M UTC') — Already running, skipping." >&2
  exit 0
fi

if [ ! -d "$APP_DIR" ]; then
  echo "ERROR: $APP_DIR does not exist. Run deploy.sh first." >&2
  exit 1
fi

if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: $ENV_FILE not found. Copy .env.example and fill in credentials." >&2
  exit 1
fi

if [ ! -f "$APP_DIR/run-all.js" ]; then
  echo "ERROR: run-all.js not found in $APP_DIR." >&2
  exit 1
fi

# ── Environment ──────────────────────────────────────────────────────────────

# Load .env (skip blank lines and comments)
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

# ── Logging setup ────────────────────────────────────────────────────────────

mkdir -p "$LOG_DIR"

# Tee all output to both the log file and stdout (for systemd/journald capture)
exec > >(tee -a "$LOG_FILE") 2>&1

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Insider Tracker — Cron triggered"
echo "  Date:    $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
echo "  Log:     $LOG_FILE"
echo "  Node:    $($NODE_BIN --version)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ── Run orchestrator ─────────────────────────────────────────────────────────

cd "$APP_DIR"

# Allow orchestrator to fail without stopping the log/cleanup below
set +e
"$NODE_BIN" run-all.js
EXIT_CODE=$?

echo ""
echo "── Scoring & Performance ──────────────────────────────"
"$NODE_BIN" scrapers/score-insiders.js       || true  # non-fatal
"$NODE_BIN" scrapers/track-performance.js    || true  # non-fatal
"$NODE_BIN" scrapers/flag-signals.js         || true  # non-fatal
"$NODE_BIN" scrapers/daily-health-check.js   || true  # non-fatal
"$NODE_BIN" scrapers/enrich-sectors.js       || true  # non-fatal

echo ""
echo "── Watchlist Notifications ────────────────────────────"
"$NODE_BIN" scrapers/notify-watchlist.js     || true  # non-fatal

echo ""
echo "── Lifecycle Emails ───────────────────────────────────"
"$NODE_BIN" scrapers/emails/welcome-flow.js  || true  # non-fatal

# ── Post-run ─────────────────────────────────────────────────────────────────

echo ""
echo "  Scraper exit code: $EXIT_CODE  (individual failures logged above)"
echo "  Finished:  $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ── Log rotation: delete logs older than 30 days ─────────────────────────────

find "$LOG_DIR" -name "scrape-*.log" -mtime +30 -delete 2>/dev/null || true

# Always exit 0 — individual scraper failures are logged and reported via
# daily-health-check.js email alerts. A non-zero cron exit causes unnecessary
# system noise without adding actionable information.
exit 0
