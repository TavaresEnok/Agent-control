#!/bin/sh
set -eu
cd /workspace/upstream/cezar
npm run typecheck
VITE_AGENT_CONTROL_MANAGED=1 npm run build
cd packages/cezar
export npm_execpath=${npm_execpath:-/usr/local/lib/node_modules/npm/bin/npm-cli.js}
env -u CEZ_TELEMETRY -u DO_NOT_TRACK -u CEZ_AUTONAME -u CEZ_NO_BANNER -u CEZ_SKILLS_AUTO_UPDATE -u CEZ_AUTOMATIONS -u CI node --import tsx --test --test-concurrency=2 test/e2e/*.test.ts
