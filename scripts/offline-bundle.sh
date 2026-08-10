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
VOICE_API_IMAGE="reporting/voice-api:offline"
VOICE_WEB_IMAGE="reporting/voice-web:offline"

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

# Compose/buildx на новых Docker иначе клеит attestation-манифесты.
export BUILDX_NO_DEFAULT_ATTESTATIONS=1

echo "==> Платформа: ${PLATFORM}"
echo "==> Pull upstream-образов…"
docker pull --platform "$PLATFORM" "$POSTGRES_UPSTREAM"
docker pull --platform "$PLATFORM" "$MINIO_UPSTREAM"
docker pull --platform "$PLATFORM" "$MC_UPSTREAM"

echo "==> Flatten → reporting/* (обход бага docker save на multi-arch)…"
flatten_image "$POSTGRES_UPSTREAM" "$POSTGRES_IMAGE"
flatten_image "$MINIO_UPSTREAM" "$MINIO_IMAGE"
flatten_image "$MC_UPSTREAM" "$MC_IMAGE"

echo "==> Сборка backend, frontend, voice (${PLATFORM})…"
DOCKER_DEFAULT_PLATFORM="$PLATFORM" "${COMPOSE[@]}" build backend frontend voice-api voice-web

echo "==> Flatten app-образов (docker-compose 1.29 / ContainerConfig)…"
for img in "$BACKEND_IMAGE" "$FRONTEND_IMAGE" "$VOICE_API_IMAGE" "$VOICE_WEB_IMAGE"; do
  flat_tmp="${img}-flat"
  flatten_image "$img" "$flat_tmp"
  docker tag "$flat_tmp" "$img"
  docker rmi "$flat_tmp" >/dev/null 2>&1 || true
done

echo "==> Проверка тегов…"
for img in "$POSTGRES_IMAGE" "$MINIO_IMAGE" "$MC_IMAGE" "$BACKEND_IMAGE" "$FRONTEND_IMAGE" "$VOICE_API_IMAGE" "$VOICE_WEB_IMAGE"; do
  if ! docker image inspect "$img" >/dev/null 2>&1; then
    echo "Ошибка: образ не найден: $img" >&2
    exit 1
  fi
done

echo "==> docker save → ${OUTPUT}"
docker save \
  "$POSTGRES_IMAGE" \
  "$MINIO_IMAGE" \
  "$MC_IMAGE" \
  "$BACKEND_IMAGE" \
  "$FRONTEND_IMAGE" \
  "$VOICE_API_IMAGE" \
  "$VOICE_WEB_IMAGE" \
  -o "$OUTPUT"

MANIFEST="${OUTPUT%.tar}.manifest.txt"
{
  echo "platform=${PLATFORM}"
  echo "created=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "images:"
  echo "  ${POSTGRES_IMAGE}"
  echo "  ${MINIO_IMAGE}"
  echo "  ${MC_IMAGE}"
  echo "  ${BACKEND_IMAGE}"
  echo "  ${FRONTEND_IMAGE}"
  echo "  ${VOICE_API_IMAGE}"
  echo "  ${VOICE_WEB_IMAGE}"
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
echo "  # pallink.fun (HTTP, без SSL):"
echo "  sudo bash scripts/offline-deploy.sh /tmp/$(basename "$OUTPUT") --with-nginx --pallink"
echo "  # corp taskatestovaya.ru:"
echo "  sudo bash scripts/offline-deploy.sh /tmp/$(basename "$OUTPUT") --with-nginx"
echo "  # открывать: http://pallink.fun/  или  http://taskatestovaya.ru/"
