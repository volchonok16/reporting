#!/usr/bin/env bash
# Build outside the closed contour; transfer the archive together with this checkout.
set -euo pipefail
cd "$(dirname "$0")/.."
output="${1:-dist/reporting-dogtags.tar}"
platform="${2:-linux/amd64}"
postgres="postgres:17-bookworm@sha256:3645570cccdfa447589da9f57dd740faa29b30938e861289a5574b6ca6b03826"
rabbitmq="rabbitmq:4.2-management@sha256:9e9fd21d60f060acc9ecbd847cd1dcb87e6550bdb0297c27e79a40bfe1766ce4"
manager_image="reporting/dogtags-manager:534b82f"
postgres_image="reporting/dogtags-postgres:17"
rabbitmq_image="reporting/dogtags-rabbitmq:4.2"
mkdir -p "$(dirname "$output")"
docker buildx build --platform "$platform" --provenance=false --sbom=false \
  --load -t "$manager_image" dogtags-manager
docker pull --platform "$platform" "$postgres"
docker pull --platform "$platform" "$rabbitmq"
docker tag "$postgres" "$postgres_image"
docker tag "$rabbitmq" "$rabbitmq_image"
docker save -o "$output" "$manager_image" "$postgres_image" "$rabbitmq_image"
printf 'Dogtags bundle: %s (%s)\n' "$output" "$platform"
