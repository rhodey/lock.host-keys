#!/bin/sh
set -e

cd /app && node /app/helper-key-server.js "$@"
