#!/bin/bash
# Запуск PostgreSQL: поддержка docker compose (V2) и docker-compose (V1)
set -e
cd "$(dirname "$0")/.."

if docker compose version &>/dev/null; then
  docker compose up -d "$@"
elif command -v docker-compose &>/dev/null; then
  docker-compose up -d "$@"
else
  echo "Docker Compose не найден. Установите:"
  echo "  apt install docker-compose-plugin   # V2"
  echo "  apt install docker-compose            # V1"
  exit 1
fi

echo "Готово. Проверка: docker compose ps  (или docker-compose ps)"
