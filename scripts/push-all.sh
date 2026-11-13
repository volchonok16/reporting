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

stash_sha=""
restore_local() {
  if [[ "$(git branch --show-current 2>/dev/null || true)" != "main" ]]; then
    git checkout main
  fi
  if [[ -n "$stash_sha" ]]; then
    local sha="$stash_sha"
    stash_sha=""
    # Git 2.50 не принимает сырой хеш в stash pop: нужна запись stash@{n}.
    local entry
    entry="$(git stash list --format='%gd %H' | awk -v sha="$sha" '$2 == sha { print $1; exit }')"
    if [[ -z "$entry" ]]; then
      echo "Не нашёл stash ${sha}. Список: git stash list" >&2
      return 1
    fi
    git stash pop "$entry"
  fi
}
trap 'code=$?; restore_local || true; exit "$code"' EXIT

echo "==> GitHub (main)"
git push origin main

echo "==> TFS (main → master)"
# Локальные правки (Доска и прочее) не коммитим, но checkout master их затирает.
if ! git diff --quiet || ! git diff --cached --quiet; then
  git stash push -m "push-all: local changes"
  stash_sha="$(git rev-parse 'stash@{0}')"
fi
git fetch tfs
git checkout master
# Иначе git merge вызывает «stash create» по ещё не устаревшим mtime и падает: fatal: stash failed.
git update-index -q --refresh || true
git merge main -m "Sync main into master (TFS)"
git push tfs master
git checkout main
restore_local
trap - EXIT

echo ""
echo "Готово: GitHub main, TFS master."
