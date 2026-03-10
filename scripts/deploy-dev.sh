#!/bin/bash
# deploy-dev.sh — Pull latest dev branch and restart dev/test service
set -e

DEPLOY_DIR="/opt/dra/dev"
SERVICE="dra-dev"

echo "==> Deploying DEV from branch: dev"
cd "$DEPLOY_DIR"
git pull origin dev
cd server
npm install --omit=dev
cd ..
sudo systemctl restart "$SERVICE"
echo "==> Dev deployed and restarted ✓"
systemctl status "$SERVICE" --no-pager
