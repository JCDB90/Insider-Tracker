#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Insider Tracker — Weekly Buyback Scraper
#
# Cron entry (Hetzner, run as insider user or root):
#   0 7 * * 6 root /opt/insider-tracker/scripts/run-buybacks.sh
#   (07:00 UTC every Saturday)
#
# Buyback reports are filed weekly by companies; daily scraping is overkill.
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

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

"$NODE_BIN" scrapers/buybacks/norway-buybacks.js
"$NODE_BIN" scrapers/buybacks/uk-buybacks.js
"$NODE_BIN" scrapers/buybacks/watchlist-buybacks.js

echo ""
echo "  Finished: $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Rotate logs older than 60 days
find "$LOG_DIR" -name "buybacks-*.log" -mtime +60 -delete 2>/dev/null || true
