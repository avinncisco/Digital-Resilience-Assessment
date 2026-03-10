#!/bin/bash
# bootstrap.sh — One-shot setup for DRA on a fresh Ubuntu server
# Run as your deploy user (not root), after copying this repo to the server.
# Usage: bash scripts/bootstrap.sh <github-repo-url> <your-linux-username>
# Example: bash scripts/bootstrap.sh https://github.com/your-org/dra-app avinash

set -e

REPO_URL="${1:-https://github.com/YOUR_ORG/dra-app}"
DEPLOY_USER="${2:-$(whoami)}"
PROD_DIR="/opt/dra/prod"
DEV_DIR="/opt/dra/dev"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║   Digital Resilience Assessment — Bootstrap Setup   ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""
echo "  Repo:   $REPO_URL"
echo "  User:   $DEPLOY_USER"
echo "  Prod:   $PROD_DIR (port 3000)"
echo "  Dev:    $DEV_DIR  (port 3001)"
echo ""

# 1. Create directories
echo "==> Creating deploy directories..."
sudo mkdir -p "$PROD_DIR" "$DEV_DIR"
sudo chown -R "$DEPLOY_USER":"$DEPLOY_USER" /opt/dra

# 2. Clone repo into both environments
echo "==> Cloning production (main branch)..."
git clone -b main "$REPO_URL" "$PROD_DIR" 2>/dev/null || (cd "$PROD_DIR" && git pull origin main)

echo "==> Cloning dev (dev branch)..."
git clone -b dev "$REPO_URL" "$DEV_DIR" 2>/dev/null || (cd "$DEV_DIR" && git pull origin dev)

# 3. Install dependencies
echo "==> Installing production dependencies..."
cd "$PROD_DIR/server" && npm install --omit=dev

echo "==> Installing dev dependencies..."
cd "$DEV_DIR/server" && npm install --omit=dev

# 4. Create .env files from examples if they don't exist
if [ ! -f "$PROD_DIR/server/.env" ]; then
  cp "$PROD_DIR/server/.env.example" "$PROD_DIR/server/.env"
  echo "==> Created $PROD_DIR/server/.env — EDIT THIS FILE with your API keys!"
fi
if [ ! -f "$DEV_DIR/server/.env" ]; then
  cp "$DEV_DIR/server/.env.example" "$DEV_DIR/server/.env"
  # Adjust dev port
  sed -i 's/PORT=3000/PORT=3001/' "$DEV_DIR/server/.env"
  echo "==> Created $DEV_DIR/server/.env (port 3001)"
fi

# 5. Install systemd services
echo "==> Installing systemd services..."
sed "s/YOUR_USER/$DEPLOY_USER/g" "$SCRIPT_DIR/dra-prod.service" | sudo tee /etc/systemd/system/dra-prod.service > /dev/null
sed "s/YOUR_USER/$DEPLOY_USER/g" "$SCRIPT_DIR/dra-dev.service"  | sudo tee /etc/systemd/system/dra-dev.service  > /dev/null
sudo systemctl daemon-reload
sudo systemctl enable dra-prod dra-dev

# 6. Set up sudoers for deploy scripts
echo "==> Adding sudoers entry for service restarts..."
SUDOERS_LINE="$DEPLOY_USER ALL=(ALL) NOPASSWD: /bin/systemctl restart dra-prod, /bin/systemctl restart dra-dev, /bin/systemctl status dra-prod, /bin/systemctl status dra-dev"
echo "$SUDOERS_LINE" | sudo tee /etc/sudoers.d/dra-deploy > /dev/null
sudo chmod 440 /etc/sudoers.d/dra-deploy

# 7. Make deploy scripts executable
chmod +x "$SCRIPT_DIR/deploy-prod.sh" "$SCRIPT_DIR/deploy-dev.sh"

echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║   Bootstrap complete!                                ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""
echo "  NEXT STEPS:"
echo "  1. Edit $PROD_DIR/server/.env with your API key and settings"
echo "  2. Edit $DEV_DIR/server/.env  with your API key and settings"
echo "  3. Start services:"
echo "       sudo systemctl start dra-prod"
echo "       sudo systemctl start dra-dev"
echo "  4. Check status:"
echo "       sudo systemctl status dra-prod"
echo "       curl http://localhost:3000/api/health"
echo "       curl http://localhost:3001/api/health"
echo ""
echo "  ADMIN USER:"
echo "  After registering your first user at http://localhost:3000,"
echo "  promote them to admin by editing:"
echo "    $PROD_DIR/server/data/_users.json"
echo "  and setting:  \"role\": \"admin\""
echo ""
