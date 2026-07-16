#!/usr/bin/env bash
# Обход docker-compose 1.29 + Docker 24+: KeyError 'ContainerConfig'.
# Удаляет старые контейнеры reporting перед up -d.

purge_containers_by_name() {
  local pattern="$1"
  local ids
  ids="$(docker ps -aq --filter "name=${pattern}" 2>/dev/null || true)"
  if [[ -n "${ids//[[:space:]]/}" ]]; then
    echo "    docker rm -f ${ids//$'\n'/ }"
    # shellcheck disable=SC2086
    docker rm -f $ids 2>/dev/null || true
  fi
}

purge_reporting_containers_v1() {
  echo "==> docker-compose v1: очистка старых контейнеров…"
  purge_containers_by_name "reporting-postgres"
  purge_containers_by_name "reporting-backend"
  purge_containers_by_name "reporting-frontend"
  purge_containers_by_name "reporting-minio"
  purge_containers_by_name "reporting-minio-init"
}
