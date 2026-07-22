#!/usr/bin/env bash
# Push bundle + код в TFS (Mac → TFS → Ubuntu git pull).
# Запускать в Terminal.app (нужен интерактивный логин TFS):
#
#   bash scripts/push-tfs-bundle.sh
set -euo pipefail
cd "$(dirname "$0")/.."

if ! git lfs version >/dev/null 2>&1; then
  echo "Ошибка: git lfs не установлен. brew install git-lfs && git lfs install" >&2
  exit 1
fi

git lfs install >/dev/null 2>&1 || true
git config lfs.https://tfs.t2.ru/tfs/Main/Tele2/_git/b2bproduct.git/info/lfs.locksverify false 2>/dev/null || true

BRANCH="$(git branch --show-current)"
if [[ "$BRANCH" != "main" ]]; then
  git checkout main
fi

echo "==> fetch tfs"
git fetch tfs

echo "==> merge main → master"
git checkout master
git merge main -m "Sync main into master (TFS)"

echo "==> push tfs master (git + LFS ~321MB, может занять несколько минут)"
git push tfs master
git lfs push tfs master --all

git checkout main

echo ""
echo "Готово. На Ubuntu-сервере:"
echo "  git lfs install"
echo "  cd /var/database/b2bproduct && git checkout master && git pull && git lfs pull"
echo "  bash scripts/offline-deploy.sh"
