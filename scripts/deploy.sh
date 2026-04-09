#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Insider Tracker — Deployment Script (shared Hetzner server)
#
# Safe to run on a server already running StreamOptima or any other app.
# Does NOT run apt-get upgrade (avoids breaking existing services).
# Only installs packages that are missing.
#
# Usage (run as root on your Hetzner server):
#   curl -fsSL https://raw.githubusercontent.com/JCDB90/Insider-Tracker/main/scripts/deploy.sh | bash
#
# Or manually:
#   scp scripts/deploy.sh root@YOUR_SERVER_IP:/root/
#   ssh root@YOUR_SERVER_IP bash /root/deploy.sh
#
# What this does:
#   1. Checks for StreamOptima and reads its cron schedule (no changes made)
#   2. Installs missing packages only (Node 20, Chromium, git)
#   3. Creates /opt/insider-tracker with a dedicated 'insider' system user
#   4. Clones the GitHub repo and installs npm dependencies
#   5. Prompts for Supabase credentials → writes .env (chmod 600)
#   6. Installs /etc/cron.d/insider-tracker at a safe non-overlapping time
#   7. Shows combined crontab (StreamOptima + Insider Tracker side by side)
#   8. Runs Germany scraper as smoke test
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

# ── Config ────────────────────────────────────────────────────────────────────

GITHUB_REPO="https://github.com/JCDB90/Insider-Tracker.git"
APP_DIR="/opt/insider-tracker"
APP_USER="insider"

# 23:00 UTC = midnight CET (gives a comfortable gap from StreamOptima)
# Adjust here if you know StreamOptima runs at or near 23:00 UTC.
CRON_SCHEDULE="0 23 * * *"

# Known StreamOptima location — we check this, never touch it
STREAMOPTIMA_DIR="/opt/streamoptima"

# ─────────────────────────────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log()  { echo -e "${GREEN}[deploy]${NC} $*"; }
warn() { echo -e "${YELLOW}[warn]${NC}   $*"; }
info() { echo -e "${BLUE}[info]${NC}   $*"; }
err()  { echo -e "${RED}[error]${NC}  $*" >&2; exit 1; }

[ "$(id -u)" -ne 0 ] && err "Run this script as root (ssh root@your-server)"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Insider Tracker — Deployment"
echo "  Host: $(hostname) | $(date -u '+%Y-%m-%d %H:%M UTC')"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ── 1. StreamOptima safety check ──────────────────────────────────────────────
#
# Read-only. We detect what's running so we can schedule around it.
# We never touch, restart, or modify StreamOptima in any way.

echo ""
log "Checking for existing services on this server…"

STREAMOPTIMA_FOUND=false
STREAMOPTIMA_CRON=""

if [ -d "$STREAMOPTIMA_DIR" ]; then
  STREAMOPTIMA_FOUND=true
  info "StreamOptima detected at $STREAMOPTIMA_DIR"
fi

# Read its cron entry if it exists
for cron_file in /etc/cron.d/streamoptima /etc/cron.d/stream-optima /etc/cron.d/streamoptima-*; do
  if [ -f "$cron_file" ]; then
    STREAMOPTIMA_CRON="$(grep -v '^#' "$cron_file" | grep -v '^$' | grep -v '^[A-Z]' | head -1 || true)"
    info "StreamOptima cron found in $cron_file: $STREAMOPTIMA_CRON"
    break
  fi
done

# Also check root's crontab
ROOT_CRON="$(crontab -l 2>/dev/null || true)"
if echo "$ROOT_CRON" | grep -qi "streamoptima" 2>/dev/null; then
  info "StreamOptima cron also found in root crontab"
fi

# Memory check — warn if server is already under pressure
TOTAL_MEM_MB=$(free -m | awk '/^Mem:/ {print $2}')
USED_MEM_MB=$(free -m  | awk '/^Mem:/ {print $3}')
FREE_MEM_MB=$(free -m  | awk '/^Mem:/ {print $4}')
info "Memory: ${USED_MEM_MB} MB used / ${TOTAL_MEM_MB} MB total (${FREE_MEM_MB} MB free)"

if [ "$FREE_MEM_MB" -lt 800 ]; then
  warn "Less than 800 MB free RAM. Puppeteer scrapers use ~400 MB when running."
  warn "HTTP-only scrapers (Germany, France, etc.) will work fine regardless."
  warn "Consider upgrading to CX32 (8 GB) before enabling Puppeteer markets."
fi

echo ""

# ── 2. Install missing packages only (NO apt-get upgrade) ────────────────────
#
# We deliberately skip "apt-get upgrade" to avoid touching packages that
# StreamOptima depends on. We only install what's genuinely missing.

log "Installing missing system packages (no upgrade, safe for shared server)…"
apt-get update -qq

# Node.js 20 — skip if already installed at the right version
if ! command -v node &>/dev/null; then
  log "Installing Node.js 20…"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1
  apt-get install -y -qq nodejs
elif [[ "$(node --version)" != v20* ]]; then
  warn "Node.js $(node --version) is installed but scrapers require v20."
  warn "Upgrading Node.js (this should not affect StreamOptima if it uses nvm or its own binary)."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1
  apt-get install -y -qq nodejs
else
  log "Node.js $(node --version) already installed — skipping"
fi

# git
if ! command -v git &>/dev/null; then
  apt-get install -y -qq git
else
  log "git $(git --version | cut -d' ' -f3) already installed — skipping"
fi

# Chromium for Puppeteer (future scrapers)
if ! command -v chromium-browser &>/dev/null && ! command -v chromium &>/dev/null; then
  log "Installing Chromium and dependencies…"
  apt-get install -y -qq \
    chromium-browser \
    fonts-liberation \
    libappindicator3-1 \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    xdg-utils 2>/dev/null || warn "Some Chromium deps skipped"
else
  log "Chromium already installed — skipping"
fi

CHROMIUM_PATH="$(which chromium-browser 2>/dev/null || which chromium 2>/dev/null || echo '/usr/bin/chromium-browser')"
log "Node: $(node --version) | npm: $(npm --version) | Chromium: $CHROMIUM_PATH"

# ── 3. Create dedicated system user ──────────────────────────────────────────
#
# 'insider' user owns /opt/insider-tracker only.
# It cannot access /opt/streamoptima (different owner, no sudo).

if ! id "$APP_USER" &>/dev/null; then
  log "Creating system user '$APP_USER'…"
  useradd --system --shell /bin/bash --home-dir "$APP_DIR" --no-create-home "$APP_USER"
else
  log "User '$APP_USER' already exists — skipping"
fi

# ── 4. Clone or update repository ────────────────────────────────────────────

if [ -d "$APP_DIR/.git" ]; then
  log "Repo already cloned — pulling latest…"
  git -C "$APP_DIR" pull --ff-only
else
  log "Cloning repo into $APP_DIR…"
  git clone "$GITHUB_REPO" "$APP_DIR"
fi

chown -R "$APP_USER":"$APP_USER" "$APP_DIR"

# ── 5. Install npm dependencies ───────────────────────────────────────────────

log "Installing npm dependencies…"
cd "$APP_DIR"
sudo -u "$APP_USER" npm ci --omit=dev --silent

# ── 6. Create .env ────────────────────────────────────────────────────────────

if [ -f "$APP_DIR/.env" ]; then
  warn ".env already exists — skipping credential setup"
  warn "To reconfigure: rm $APP_DIR/.env && bash $APP_DIR/scripts/deploy.sh"
else
  log "Configuring Supabase credentials…"
  echo ""
  echo "  Find these in: Supabase dashboard → Settings → API"
  echo ""
  read -rp "  SUPABASE_URL (https://xxxx.supabase.co): " SUPABASE_URL
  read -rp "  SUPABASE_KEY (service_role key):         " SUPABASE_KEY
  echo ""

  cat > "$APP_DIR/.env" <<ENVEOF
# Insider Tracker — Environment Variables
# Generated by deploy.sh on $(date -u '+%Y-%m-%d %H:%M UTC')
# chmod 600 — readable by 'insider' user only

SUPABASE_URL=${SUPABASE_URL}
SUPABASE_KEY=${SUPABASE_KEY}
NODE_ENV=production

# Puppeteer — use system Chromium (no extra 300 MB download)
PUPPETEER_EXECUTABLE_PATH=${CHROMIUM_PATH}
PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENVEOF

  chmod 600 "$APP_DIR/.env"
  chown "$APP_USER":"$APP_USER" "$APP_DIR/.env"
  log ".env created (chmod 600, owner: $APP_USER)"
fi

# ── 7. Directories and permissions ────────────────────────────────────────────

mkdir -p "$APP_DIR/logs"
chmod +x "$APP_DIR/scripts/run-daily.sh"
chmod +x "$APP_DIR/scripts/deploy.sh"
chown -R "$APP_USER":"$APP_USER" "$APP_DIR"

# ── 8. Install cron job ───────────────────────────────────────────────────────
#
# Written to /etc/cron.d/insider-tracker — a separate file from any
# StreamOptima cron. The two files are completely independent.

CRONTAB_FILE="/etc/cron.d/insider-tracker"

log "Installing cron job at $CRON_SCHEDULE UTC…"
cat > "$CRONTAB_FILE" <<CRONEOF
# Insider Tracker — Daily scrape
# Schedule: ${CRON_SCHEDULE} UTC (midnight CET / 01:00 CEST)
# Managed by deploy.sh — safe to edit the schedule line below
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/sbin:/bin:/usr/sbin:/usr/bin

${CRON_SCHEDULE} ${APP_USER} ${APP_DIR}/scripts/run-daily.sh
CRONEOF

chmod 644 "$CRONTAB_FILE"

# ── 9. Show combined crontab ──────────────────────────────────────────────────

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  All active cron jobs on this server"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "  /etc/cron.d/ files:"
for f in /etc/cron.d/*; do
  [ -f "$f" ] || continue
  # Print non-comment, non-blank, non-env-var lines with the filename
  while IFS= read -r line; do
    [[ "$line" =~ ^#     ]] && continue
    [[ "$line" =~ ^$     ]] && continue
    [[ "$line" =~ ^[A-Z] ]] && continue
    printf "    %-28s %s\n" "$(basename "$f"):" "$line"
  done < "$f"
done
echo ""

# Root crontab (if any)
ROOT_CRON="$(crontab -l 2>/dev/null || true)"
if [ -n "$ROOT_CRON" ]; then
  echo "  root crontab:"
  echo "$ROOT_CRON" | grep -v '^#' | grep -v '^$' | while IFS= read -r line; do
    echo "    $line"
  done
  echo ""
fi

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Overlap warning
if [ -n "$STREAMOPTIMA_CRON" ]; then
  SO_HOUR=$(echo "$STREAMOPTIMA_CRON" | awk '{print $2}')
  IT_HOUR=$(echo "$CRON_SCHEDULE"     | awk '{print $2}')
  if [ "$SO_HOUR" = "$IT_HOUR" ]; then
    warn "StreamOptima and Insider Tracker are scheduled in the same hour!"
    warn "Edit CRON_SCHEDULE in this script and re-run, or edit $CRONTAB_FILE directly."
  else
    log "No schedule overlap detected."
  fi
fi

# ── 10. Smoke test ────────────────────────────────────────────────────────────

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
log "Running Germany scraper as smoke test…"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

cd "$APP_DIR"
set -a
# shellcheck disable=SC1090,SC1091
source "$APP_DIR/.env"
set +a

sudo -E -u "$APP_USER" node run-all.js DE

# ── Done ──────────────────────────────────────────────────────────────────────

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
log "Deployment complete!"
echo ""
echo "  Insider Tracker"
echo "    Directory: $APP_DIR"
echo "    User:      $APP_USER (cannot access /opt/streamoptima)"
echo "    Cron:      $CRON_SCHEDULE UTC  →  /etc/cron.d/insider-tracker"
echo "    Logs:      $APP_DIR/logs/scrape-YYYY-MM-DD.log (30-day retention)"
echo ""
if $STREAMOPTIMA_FOUND; then
echo "  StreamOptima"
echo "    Directory: $STREAMOPTIMA_DIR  (untouched)"
echo "    Status:    No changes made"
echo ""
fi
echo "  Useful commands:"
echo "    Run now:         sudo -u $APP_USER $APP_DIR/scripts/run-daily.sh"
echo "    Single market:   cd $APP_DIR && node run-all.js DE"
echo "    View today's log: tail -f $APP_DIR/logs/scrape-\$(date +%Y-%m-%d).log"
echo "    Check cron jobs: ls /etc/cron.d/ && crontab -l"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
