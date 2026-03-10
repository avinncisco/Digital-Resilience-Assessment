#!/bin/bash
# deploy-prod.sh — Pull latest main branch and restart production service
set -e

DEPLOY_DIR="/opt/dra/prod"
SERVICE="dra-prod"

echo "==> Deploying PRODUCTION from branch: main"
cd "$DEPLOY_DIR"
git pull origin main
cd server
npm install --omit=dev
cd ..
sudo systemctl restart "$SERVICE"
echo "==> Production deployed and restarted ✓"
systemctl status "$SERVICE" --no-pager
