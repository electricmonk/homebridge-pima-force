#!/usr/bin/env bash
# Run the E2E test suite against Homebridge 1.x and 2.x in sequence,
# then restore the devDependency version (1.x).
set -euo pipefail

run_e2e() {
  local label="$1"
  echo ""
  echo "========================================="
  echo " E2E: Homebridge $label"
  echo "========================================="
  npm run test:e2e
}

# 1.x (already installed as devDependency)
echo "Installing Homebridge 1.x..."
npm install homebridge@'^1.8.0' --no-save --legacy-peer-deps
run_e2e "1.x"

# 2.x
echo "Installing Homebridge 2.x..."
npm install homebridge@'^2.0.0' --no-save --legacy-peer-deps
run_e2e "2.x"

# Restore 1.x (keeps devDependency version in node_modules)
echo "Restoring Homebridge 1.x..."
npm install homebridge@'^1.8.0' --no-save --legacy-peer-deps

echo ""
echo "E2E tests passed on both Homebridge versions."
