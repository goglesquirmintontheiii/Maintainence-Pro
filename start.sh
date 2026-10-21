#!/usr/bin/env bash
# Maintenance Pro launcher.
#   ./start.sh          install what's needed, then run MPro on http://localhost:8080
#   ./start.sh --dev    developer mode: demo data, API on :8080 and the web app with hot reload on :5173
#   ./start.sh --demo   run with the demo organization loaded
#   ./start.sh --help
# The full first-run setup wizard (plain-English questions, service install, backups) arrives in 1.0.0.
set -euo pipefail
cd "$(dirname "$0")"

PORT="${MPRO_PORT:-8080}"
MODE="run"
DEMO=0
for arg in "$@"; do
  case "$arg" in
    --dev) MODE="dev"; DEMO=1 ;;
    --demo) DEMO=1 ;;
    --port=*) PORT="${arg#*=}" ;;
    -h|--help) sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $arg (try --help)"; exit 2 ;;
  esac
done

say()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31mxx\033[0m %s\n' "$*"; exit 1; }

# 1. uv (installs its own Python, so the system Python is never touched)
if ! command -v uv >/dev/null 2>&1; then
  [ -x "$HOME/.local/bin/uv" ] && export PATH="$HOME/.local/bin:$PATH"
fi
if ! command -v uv >/dev/null 2>&1; then
  say "Installing uv (Python package manager)…"
  command -v curl >/dev/null 2>&1 || die "curl is needed to install uv. Install curl and run this again."
  curl -LsSf https://astral.sh/uv/install.sh | sh
  export PATH="$HOME/.local/bin:$PATH"
fi

# 2. Python 3.12 + dependencies from the lockfile
say "Installing Python 3.12 and MPro's packages (first run takes a minute)…"
uv sync --frozen --python 3.12 $([ "$MODE" = dev ] && echo "--all-groups" || echo "--no-dev") >/dev/null

# 3. Web app
if [ "$MODE" = dev ] || [ ! -f mpro/static/app/index.html ]; then
  if command -v npm >/dev/null 2>&1; then
    say "Installing web app packages…"
    (cd frontend && npm ci --no-audit --no-fund --loglevel=error)
    if [ "$MODE" != dev ]; then say "Building the web app…"; (cd frontend && npm run build >/dev/null); fi
  elif [ ! -f mpro/static/app/index.html ]; then
    die "Node.js 20+ is needed to build the web app the first time. Install it from https://nodejs.org and run this again."
  fi
fi

# 4. Data folder and database (SQLite by default; set DATABASE_URL for PostgreSQL)
export MPRO_DATA_DIR="${MPRO_DATA_DIR:-$PWD/.data}"
export MPRO_BASE_URL="${MPRO_BASE_URL:-http://localhost:$PORT}"
mkdir -p "$MPRO_DATA_DIR"
[ -z "${DATABASE_URL:-}" ] && warn "Using a local SQLite database in $MPRO_DATA_DIR (fine for trying MPro). Set DATABASE_URL to use PostgreSQL."
say "Preparing the database…"
uv run --frozen mpro migrate >/dev/null
if [ "$DEMO" = 1 ]; then uv run --frozen mpro seed-demo | tail -1; fi

# 5. Run
if [ "$MODE" = dev ]; then
  say "Starting the API on http://localhost:$PORT and the web app on http://localhost:5173 (Ctrl+C stops both)"
  uv run --frozen mpro serve --host 127.0.0.1 --port "$PORT" &
  API_PID=$!
  trap 'kill $API_PID 2>/dev/null' EXIT INT TERM
  (cd frontend && npm run dev -- --host 127.0.0.1)
else
  say "Maintenance Pro is starting on http://localhost:$PORT (Ctrl+C to stop)"
  exec uv run --frozen mpro serve --host 0.0.0.0 --port "$PORT"
fi
