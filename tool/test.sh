#!/usr/bin/env bash
# Runs tests/index.html in headless Chrome and fails if any test fails.
set -euo pipefail
cd "$(dirname "$0")/.."

CHROME="${CHROME:-}"
for c in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" google-chrome chromium chromium-browser; do
  [ -z "$CHROME" ] && command -v "$c" >/dev/null 2>&1 && CHROME="$c"
  [ -z "$CHROME" ] && [ -x "$c" ] && CHROME="$c"
done
[ -z "$CHROME" ] && { echo "Chrome not found (set CHROME=...)"; exit 2; }

PORT="${PORT:-8765}"
python3 -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1 &
SERVER=$!
trap 'kill $SERVER' EXIT
for _ in $(seq 1 50); do
  curl -sf -o /dev/null "http://127.0.0.1:$PORT/tests/index.html" && break
  sleep 0.2
done

# Headless Chrome sometimes dumps before the modules have run; retry until the
# page reports a real result.
for _ in 1 2 3 4 5; do
  DOM="$("$CHROME" --headless=new --disable-gpu --virtual-time-budget=10000 --dump-dom "http://127.0.0.1:$PORT/tests/index.html" 2>/dev/null)"
  echo "$DOM" | grep -q 'data-status="running"' || break
done
echo "$DOM" | sed -n 's/.*<h1 id="summary">\(.*\)<\/h1>.*/\1/p'
echo "$DOM" | sed -n '/<pre id="out">/,/<\/pre>/p' | sed 's/<[^>]*>//g' | grep -E "FAIL" || true
echo "$DOM" | grep -q 'data-status="pass"'
