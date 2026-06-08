#!/bin/bash
# Локальный запуск (алиас scripts/dev.sh)
set -e
cd "$(dirname "$0")"
exec bash dev.sh "$@"
