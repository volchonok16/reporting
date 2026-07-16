#!/usr/bin/env bash
# Push: GitHub main + TFS master (default branch в Azure DevOps).
#
#   bash scripts/push-all.sh
set -euo pipefail
cd "$(dirname "$0")/.."

branch="$(git branch --show-current)"
if [[ "$branch" != "main" ]]; then
  echo "Ошибка: работайте на ветке main (сейчас: $branch)" >&2
  exit 1
fi

echo "==> GitHub (main)"
git push origin main

echo "==> TFS (main → master)"
git fetch tfs
git checkout master
git merge main -m "Sync main into master (TFS)"
git push tfs master
git checkout main

echo ""
echo "Готово: GitHub main, TFS master."
