#!/bin/sh
set -eu

cd "$(dirname "$0")"

if ! command -v docker >/dev/null 2>&1; then
  printf '%s\n' "Docker не найден."
  exit 1
fi

docker compose down
printf '%s\n' "Локальный сервис остановлен."
