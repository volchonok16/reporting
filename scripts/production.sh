#!/usr/bin/env bash
# Единый запуск production: Docker + nginx + certbot (taskatestovaya.ru)
set -euo pipefail
cd "$(dirname "$0")/.."
exec bash deploy/apply-production.sh
