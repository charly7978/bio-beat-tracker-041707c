#!/usr/bin/env bash
# Audit rápido research-first — no modifica código, solo verifica
set -euo pipefail
echo "== bio-beat audit guard — quick =="
npm run lint
npm run typecheck
npm run check:orphans
npm run check:architecture
npm run check:no-sim
npm run test --silent
npm run build --silent
npm run check:no-sim:dist
echo "✅ quick audit verde — ver docs/no-simulation-audit.md para barrido manual"
