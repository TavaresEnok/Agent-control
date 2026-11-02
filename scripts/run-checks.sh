#!/bin/sh
set -eu
cd /workspace
npm run typecheck
npm test
