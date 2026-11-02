#!/bin/sh
set -eu
cd /workspace
mkdir -p .state/happier .state/home
umask 077
export HOME=/workspace/.state/home CI=1 EXPO_NO_TELEMETRY=1 DO_NOT_TRACK=1
export PORT=18401 METRICS_ENABLED=false AUTH_ANONYMOUS_SIGNUP_ENABLED=true
export HAPPIER_FILES_BACKEND=local HAPPIER_DB_PROVIDER=sqlite HAPPY_DB_PROVIDER=sqlite
export HAPPIER_SERVER_LIGHT_DATA_DIR=/workspace/.state/happier HAPPIER_SERVER_HOST=127.0.0.1 HAPPY_SERVER_HOST=127.0.0.1
export DATABASE_URL='file:/workspace/.state/happier/server.sqlite?socket_timeout=30&connection_limit=1'
export HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY=required_e2ee
cd upstream/happier/apps/server
yarn -s migrate:sqlite:deploy
exec yarn -s start:light
