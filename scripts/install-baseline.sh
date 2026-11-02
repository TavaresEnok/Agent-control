#!/bin/sh
set -eu
cd /workspace
npm ci --ignore-scripts --no-audit --no-fund
cd upstream/cezar
npm ci --ignore-scripts --no-audit --no-fund
