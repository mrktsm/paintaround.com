#!/usr/bin/env bash
# Build the site and deploy it over SSH (Caddy on the server serves /var/www/streetview).
# Usage: DEPLOY_HOST=user@server scripts/deploy.sh   (builds, then deploys)
#        SKIP_BUILD=1                                (deploy an existing dist/ — CI builds first)
#        DEPLOY_KEY=path                             (SSH key)
set -euo pipefail
HOST="${DEPLOY_HOST:?the server, as user@address}"
KEY="${DEPLOY_KEY:-$HOME/.ssh/id_ed25519}"
DEST="/var/www/streetview"

cd "$(dirname "$0")/.."
[ "${SKIP_BUILD:-}" = "1" ] || npm run build
# dist/ already contains client/public/ (incl. deep-layers/ if present locally)
rsync -az --delete --exclude panorama-pool -e "ssh -i $KEY" dist/ "$HOST:$DEST.new/"
# Batch-built depth + lighting layers (too big for the laptop) live on the server itself:
# copy them into the new site before the swap (depth file + paint material per panorama).
LAYERS="${DEPLOY_LAYERS:-/home/ubuntu/streetview-processing/batch-20261120/layers}"
ssh -i "$KEY" "$HOST" "set -e; [ -d $LAYERS ] && rsync -a --exclude meta.json $LAYERS/ $DEST.new/deep-layers/ && echo \"layers: \$(ls $LAYERS | wc -l) panoramas\" || echo 'no batch layers on server'"
# The panorama photos (client/public/panorama-pool, ~500 MB) aren't in git, so builds made elsewhere
# (CI) don't have them: the server keeps its own copy and every deploy gets it. A local build
# that has them refreshes that copy first.
POOL="${DEPLOY_PHOTOS:-/home/ubuntu/streetview-assets/panorama-pool}"
if [ -d dist/panorama-pool ]; then
  rsync -az -e "ssh -i $KEY" dist/panorama-pool/ "$HOST:$POOL/"
fi
ssh -i "$KEY" "$HOST" "set -e; [ -d $POOL ] || { echo 'no panorama photos on server' >&2; exit 1; }; rsync -a $POOL/ $DEST.new/panorama-pool/; echo \"photos: \$(ls $POOL | grep -c -- '-card.jpg') panoramas\""
ssh -i "$KEY" "$HOST" "set -e; rm -rf $DEST.old; [ -d $DEST ] && mv $DEST $DEST.old || true; mv $DEST.new $DEST; rm -rf $DEST.old"
echo "deployed to $HOST"
