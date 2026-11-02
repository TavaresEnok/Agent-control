#!/bin/sh
# Single consolidated gate for the current increment; no providers or production services.
set -eu
cd /workspace
node scripts/record-check.mjs increment-core-types npm run typecheck
node scripts/record-check.mjs increment-core-build npm run build
node scripts/record-check.mjs increment-cezar-types npm --prefix upstream/cezar run typecheck
VITE_AGENT_CONTROL_MANAGED=1 node scripts/record-check.mjs increment-cezar-web npm --prefix upstream/cezar run build:web
node scripts/record-check.mjs increment-integration npm test
