#!/usr/bin/env bash
# Run E2E tests against both Homebridge 1.x and 2.x in sequence.
#
# Usage:
#   npm run test:e2e:all-hb
#   bash scripts/e2e-hb-versions.sh
#
# This script installs each Homebridge major version into node_modules
# (without updating package.json) and runs the full E2E suite against each.
# --legacy-peer-deps is required because homebridge-config-ui-x may declare
# a peer dep pinned to a specific major; the underlying hb-service API used
# by the E2E tests is stable across both versions.
#
# After running, the script restores the original Homebridge 1.x devDependency
# so the working tree stays clean for the next `npm ci`.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

HB1_VERSION=$(node -e "console.log(require('./package.json').devDependencies.homebridge)")

echo ""
echo "======================================================"
echo " E2E: Homebridge 1.x (devDependency: $HB1_VERSION)"
echo "======================================================"
npm run test:e2e

echo ""
echo "======================================================"
echo " E2E: Homebridge 2.x"
echo "======================================================"
npm install "homebridge@^2.0.0" --no-save --legacy-peer-deps
npm run test:e2e

echo ""
echo "======================================================"
echo " Restoring Homebridge $HB1_VERSION"
echo "======================================================"
npm install "homebridge@$HB1_VERSION" --no-save --legacy-peer-deps

echo ""
echo "All E2E runs passed."
