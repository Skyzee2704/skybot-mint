#!/usr/bin/env bash
# Read the current trycloudflare URL from pm2 logs and restart API/web with PUBLIC_URL/WEB_ORIGIN = that URL.
# Run again whenever the tunnel restarts (quick-tunnel URLs change each time).
set -euo pipefail
URL=$(pm2 logs skybot-tunnel --lines 200 --nostream 2>&1 | grep -oE "https://[a-z0-9-]+\.trycloudflare\.com" | tail -1)
[ -z "$URL" ] && { echo "tunnel URL not found"; exit 1; }
echo "$URL" > /workspace/nft-mint-bot-data/public_url
cd "$(dirname "$0")/.."
PUBLIC_URL="$URL" WEB_ORIGIN="$URL" DASHBOARD_URL="$URL" pm2 restart nft-mint-api nft-mint-web --update-env >/dev/null
pm2 save >/dev/null
echo "PUBLIC_URL=$URL"
