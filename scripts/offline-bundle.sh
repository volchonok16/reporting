#!/usr/bin/env bash
# Сборка offline-bundle для закрытого сервера (без доступа к Docker Hub).
#
# На Mac/CI с интернетом:
#   bash scripts/offline-bundle.sh
#   bash scripts/offline-bundle.sh dist/reporting-offline.tar linux/amd64
#
# Frontend на taskatestovaya.ru ходит в /api/ same-origin — VITE_API_URL не обязателен.
# На сервере (образы + HTTP nginx одной командой):
#   sudo bash scripts/offline-deploy.sh /tmp/reporting-offline.tar --with-nginx
#
# Архив копируют на сервер (scp), в git не кладут — см. dist/.gitkeep
set -euo pipefail
cd "$(dirname "$0")/.."

OUTPUT="${1:-dist/reporting-offline.tar}"
PLATFORM="${2:-linux/amd64}"

POSTGRES_UPSTREAM="postgres:16-alpine"
MINIO_UPSTREAM="minio/minio:RELEASE.2025-04-22T22-12-26Z"
MC_UPSTREAM="minio/mc:RELEASE.2025-04-08T15-39-49Z"

POSTGRES_IMAGE="reporting/postgres:16-alpine"
MINIO_IMAGE="reporting/minio:2025-04-22"
MC_IMAGE="reporting/minio-mc:2025-04-08"
BACKEND_IMAGE="reporting/backend:offline"
FRONTEND_IMAGE="reporting/frontend:offline"
VOICE_WEB_IMAGE="reporting/voice-web:offline"
CANVAS_IMAGE="reporting/canvas-studio:offline"
DOGTAGS_IMAGE="reporting/dogtags-manager:reporting-v2"
DOGTAGS_POSTGRES_IMAGE="reporting/dogtags-postgres:17"
DOGTAGS_RABBITMQ_IMAGE="reporting/dogtags-rabbitmq:4.2"
DOGTAGS_POSTGRES_UPSTREAM="postgres:17-bookworm@sha256:3645570cccdfa447589da9f57dd740faa29b30938e861289a5574b6ca6b03826"
DOGTAGS_RABBITMQ_UPSTREAM="rabbitmq:4.2-management@sha256:9e9fd21d60f060acc9ecbd847cd1dcb87e6550bdb0297c27e79a40bfe1766ce4"

mkdir -p dist

if ! docker info >/dev/null 2>&1; then
  echo "Ошибка: Docker не запущен." >&2
  exit 1
fi

flatten_image() {
  local upstream="$1"
  local target="$2"
  echo "    flatten ${upstream} → ${target}"
  # Без attestations — иначе docker-compose 1.29 падает с KeyError ContainerConfig.
  docker buildx build \
    --platform "$PLATFORM" \
    --provenance=false \
    --sbom=false \
    -t "$target" \
    --load \
    -f- . <<EOF
FROM ${upstream}
EOF
}

# shellcheck source=resolve-compose.sh
source "$(dirname "$0")/resolve-compose.sh" offline
BUILD_SERVICES=(backend frontend voice-web canvas-studio)
APP_IMAGES=("$BACKEND_IMAGE" "$FRONTEND_IMAGE" "$VOICE_WEB_IMAGE" "$CANVAS_IMAGE")
DATA_IMAGES=("$POSTGRES_IMAGE" "$MINIO_IMAGE" "$MC_IMAGE")
if [[ "$reporting_dogtags_enabled" == "1" ]]; then
  BUILD_SERVICES+=(dogtags-api)
  APP_IMAGES+=("$DOGTAGS_IMAGE")
  DATA_IMAGES+=("$DOGTAGS_POSTGRES_IMAGE" "$DOGTAGS_RABBITMQ_IMAGE")
fi
ALL_IMAGES=("${DATA_IMAGES[@]}" "${APP_IMAGES[@]}")

# Compose/buildx на новых Docker иначе клеит attestation-манифесты.
export BUILDX_NO_DEFAULT_ATTESTATIONS=1

pull_or_local() {
  local image="$1"
  if docker pull --platform "$PLATFORM" "$image"; then
    return 0
  fi
  if docker image inspect "$image" >/dev/null 2>&1; then
    echo "    предупреждение: pull не удался, использую локальный образ ${image}" >&2
    return 0
  fi
  echo "Ошибка: нет образа ${image} (pull не удался и локально не найден)." >&2
  return 1
}

echo "==> Платформа: ${PLATFORM}"
echo "==> Pull upstream-образов…"
pull_or_local "$POSTGRES_UPSTREAM"
pull_or_local "$MINIO_UPSTREAM"
pull_or_local "$MC_UPSTREAM"
if [[ "$reporting_dogtags_enabled" == "1" ]]; then
  pull_or_local "$DOGTAGS_POSTGRES_UPSTREAM"
  pull_or_local "$DOGTAGS_RABBITMQ_UPSTREAM"
fi

echo "==> Flatten → reporting/* (обход бага docker save на multi-arch)…"
flatten_image "$POSTGRES_UPSTREAM" "$POSTGRES_IMAGE"
flatten_image "$MINIO_UPSTREAM" "$MINIO_IMAGE"
flatten_image "$MC_UPSTREAM" "$MC_IMAGE"
if [[ "$reporting_dogtags_enabled" == "1" ]]; then
  flatten_image "$DOGTAGS_POSTGRES_UPSTREAM" "$DOGTAGS_POSTGRES_IMAGE"
  flatten_image "$DOGTAGS_RABBITMQ_UPSTREAM" "$DOGTAGS_RABBITMQ_IMAGE"
fi

echo "==> Сборка backend, frontend, voice-web, canvas-studio (${PLATFORM})…"
DOCKER_DEFAULT_PLATFORM="$PLATFORM" "${COMPOSE[@]}" build "${BUILD_SERVICES[@]}"

echo "==> Flatten app-образов (docker-compose 1.29 / ContainerConfig)…"
for img in "${APP_IMAGES[@]}"; do
  flat_tmp="${img}-flat"
  flatten_image "$img" "$flat_tmp"
  docker tag "$flat_tmp" "$img"
  docker rmi "$flat_tmp" >/dev/null 2>&1 || true
done

echo "==> Проверка тегов…"
for img in "${ALL_IMAGES[@]}"; do
  if ! docker image inspect "$img" >/dev/null 2>&1; then
    echo "Ошибка: образ не найден: $img" >&2
    exit 1
  fi
done

echo "==> docker save → ${OUTPUT}"
docker save "${ALL_IMAGES[@]}" -o "$OUTPUT"

MANIFEST="${OUTPUT%.tar}.manifest.txt"
{
  echo "platform=${PLATFORM}"
  echo "created=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "images:"
  echo "dogtags_enabled=${reporting_dogtags_enabled}"
  for img in "${ALL_IMAGES[@]}"; do
    echo "  ${img}"
  done
  if command -v shasum >/dev/null 2>&1; then
    echo "sha256=$(shasum -a 256 "$OUTPUT" | awk '{print $1}')"
  elif command -v sha256sum >/dev/null 2>&1; then
    echo "sha256=$(sha256sum "$OUTPUT" | awk '{print $1}')"
  fi
  ls -lh "$OUTPUT" | awk '{print "size=" $5}'
} > "$MANIFEST"

echo ""
echo "Готово:"
echo "  ${OUTPUT}"
echo "  ${MANIFEST}"
echo ""
echo "На сервер (образы + HTTP nginx):"
echo "  scp ${OUTPUT} root@SERVER:/tmp/"
echo "  # t2product.ru (HTTP без SSL + tunnel):"
echo "  sudo bash scripts/offline-deploy.sh /tmp/$(basename "$OUTPUT") --with-nginx --t2product --tunnel"
echo "  # corp taskatestovaya.ru:"
echo "  sudo bash scripts/offline-deploy.sh /tmp/$(basename "$OUTPUT") --with-nginx --tunnel"
echo "  # открывать: http://t2product.ru/  или  http://taskatestovaya.ru/"
