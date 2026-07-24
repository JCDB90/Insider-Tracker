#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Insider Tracker — Weekly Buyback Scraper
#
# Cron entry (Hetzner, run as insider user or root):
#   0 7 * * 6 root /opt/insider-tracker/scripts/run-buybacks.sh
#   (07:00 UTC every Saturday)
#
# Buyback reports are filed weekly by companies; daily scraping is overkill.
#
# Markets covered: NO (Oslo Newsweb), GB (FCA NSM), SE/DK/FI/IS (Nasdaq
# Nordic), BE (FSMA STORI), FR/NL/BE (GlobeNewswire press releases — AMF/AFM/
# BaFin confirmed to have no buyback-program category for these markets, do
# not re-add them here). DE/ES/IT are not covered by any current source.
#
# Each scraper call below is fault-isolated (`|| true`) so one broken source
# doesn't take down the rest of the run — this script used to run under
# `set -e`, which meant when the FCA NSM scraper broke silently for ~10 days
# in July 2026 it also aborted every scraper listed after it that week.
#
# Double-conviction research review: Jan 2027 — check whether Tier 1
# (price-dip BUY + insider + active buyback) has grown to n>=100 before
# treating that comparison as meaningful. As of 2026-07-24, n=82 (pooled
# across NO/DK/SE/FI/GB/FR/NL/BE) and directionally UNDERPERFORMED the
# dip-without-buyback tier on every metric — see project memory
# project_buyback_programs.md for the full breakdown before re-running this.
# ─────────────────────────────────────────────────────────────────────────────

set -uo pipefail

APP_DIR="/opt/insider-tracker"
LOG_DIR="${APP_DIR}/logs"
LOG_FILE="${LOG_DIR}/buybacks-$(date +%Y-%m-%d).log"
ENV_FILE="${APP_DIR}/.env"
NODE_BIN="$(which node)"

if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: $ENV_FILE not found." >&2; exit 1
fi

set -a; source "$ENV_FILE"; set +a

mkdir -p "$LOG_DIR"
exec > >(tee -a "$LOG_FILE") 2>&1

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Insider Tracker — Weekly Buyback Scraper"
echo "  Date: $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

cd "$APP_DIR"

"$NODE_BIN" scrapers/buybacks/norway-buybacks.js         || echo "  ⚠ norway-buybacks.js failed"
"$NODE_BIN" scrapers/buybacks/uk-buybacks.js              || echo "  ⚠ uk-buybacks.js failed"
"$NODE_BIN" scrapers/buybacks/nordic-buybacks.js          || echo "  ⚠ nordic-buybacks.js failed"
"$NODE_BIN" scrapers/buybacks/belgium-buybacks.js         || echo "  ⚠ belgium-buybacks.js failed"
"$NODE_BIN" scrapers/buybacks/globenewswire-buybacks.js   || echo "  ⚠ globenewswire-buybacks.js failed"
"$NODE_BIN" scrapers/buybacks/watchlist-buybacks.js       || echo "  ⚠ watchlist-buybacks.js failed"

echo ""
echo "  Finished: $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Rotate logs older than 60 days
find "$LOG_DIR" -name "buybacks-*.log" -mtime +60 -delete 2>/dev/null || true
