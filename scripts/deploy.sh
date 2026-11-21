#!/usr/bin/env bash
# Build the site and deploy it to the Oracle ARM server (Caddy serves /var/www/streetview).
# Usage: scripts/deploy.sh
set -euo pipefail
HOST="ubuntu@server.example"
KEY="$HOME/.ssh/deploy"
DEST="/var/www/streetview"

cd "$(dirname "$0")/.."
npm run build
# dist/ already contains public/ (incl. deep-layers/ if present locally)
rsync -az --delete -e "ssh -i $KEY" dist/ "$HOST:$DEST.new/"
# Batch-built depth + lighting layers (too big for the laptop) live on the server itself:
# copy them into the new site before the swap (depth file + paint material per panorama).
LAYERS="/home/ubuntu/streetview-processing/batch-20261120/layers"
ssh -i "$KEY" "$HOST" "set -e; [ -d $LAYERS ] && rsync -a --exclude meta.json $LAYERS/ $DEST.new/deep-layers/ && echo \"layers: \$(ls $LAYERS | wc -l) panoramas\" || echo 'no batch layers on server'"
ssh -i "$KEY" "$HOST" "set -e; rm -rf $DEST.old; [ -d $DEST ] && mv $DEST $DEST.old || true; mv $DEST.new $DEST; rm -rf $DEST.old"
echo "deployed -> https://draw.markotsymbaluk.com"
