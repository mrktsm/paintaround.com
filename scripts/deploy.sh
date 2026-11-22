#!/usr/bin/env bash
# Build the site and deploy it to the Oracle ARM server (Caddy serves /var/www/streetview).
# Usage: scripts/deploy.sh            (builds, then deploys)
#        SKIP_BUILD=1 scripts/deploy.sh (deploy an existing dist/ — CI builds first)
#        DEPLOY_KEY=path               (SSH key; default the local deploy key)
set -euo pipefail
HOST="ubuntu@server.example"
KEY="${DEPLOY_KEY:-$HOME/.ssh/deploy}"
DEST="/var/www/streetview"

cd "$(dirname "$0")/.."
[ "${SKIP_BUILD:-}" = "1" ] || npm run build
# dist/ already contains public/ (incl. deep-layers/ if present locally)
rsync -az --delete --exclude panorama-pool -e "ssh -i $KEY" dist/ "$HOST:$DEST.new/"
# Batch-built depth + lighting layers (too big for the laptop) live on the server itself:
# copy them into the new site before the swap (depth file + paint material per panorama).
LAYERS="/home/ubuntu/streetview-processing/batch-20261120/layers"
ssh -i "$KEY" "$HOST" "set -e; [ -d $LAYERS ] && rsync -a --exclude meta.json $LAYERS/ $DEST.new/deep-layers/ && echo \"layers: \$(ls $LAYERS | wc -l) panoramas\" || echo 'no batch layers on server'"
# The panorama photos (public/panorama-pool, ~500 MB) aren't in git, so builds made elsewhere
# (CI) don't have them: the server keeps its own copy and every deploy gets it. A local build
# that has them refreshes that copy first.
POOL="/home/ubuntu/streetview-assets/panorama-pool"
if [ -d dist/panorama-pool ]; then
  rsync -az -e "ssh -i $KEY" dist/panorama-pool/ "$HOST:$POOL/"
fi
ssh -i "$KEY" "$HOST" "set -e; [ -d $POOL ] || { echo 'no panorama photos on server' >&2; exit 1; }; rsync -a $POOL/ $DEST.new/panorama-pool/; echo \"photos: \$(ls $POOL | grep -c -- '-card.jpg') panoramas\""
ssh -i "$KEY" "$HOST" "set -e; rm -rf $DEST.old; [ -d $DEST ] && mv $DEST $DEST.old || true; mv $DEST.new $DEST; rm -rf $DEST.old"
echo "deployed -> https://paintaround.com"
