#!/usr/bin/env bash

set -euo pipefail

base_ref=${1:-}
head_sha=${2:-HEAD}

if [[ -z "$base_ref" ]]; then
  echo "usage: check-dco.sh <base-ref> [head-sha]" >&2
  exit 2
fi

git fetch --no-tags origin "$base_ref"
merge_base=$(git merge-base "origin/$base_ref" "$head_sha")
# Список коммитов — ОТДЕЛЬНОЙ проверяемой командой.
#
# В `done < <(git rev-list ...)` код возврата git до цикла не доходит: при
# неверном head_sha массив оставался пустым, и проверка отчитывалась успехом,
# не проверив ни одного коммита.
if ! commit_list=$(git rev-list --no-merges "$merge_base..$head_sha"); then
  echo "Failed to list commits for $merge_base..$head_sha" >&2
  exit 1
fi

commits=()
while IFS= read -r commit; do
  [[ -n "$commit" ]] && commits[${#commits[@]}]="$commit"
done <<<"$commit_list"

if [[ ${#commits[@]} -eq 0 ]]; then
  echo "No non-merge commits require DCO verification."
  exit 0
fi

failed=0
for commit in "${commits[@]}"; do
  # Трейлер, а не любая строка сообщения.
  #
  # `grep` по всему тексту принимал `Signed-off-by:`, поставленный в середине
  # рассказа: подписи там нет, а CI сообщал, что DCO проверен. Трейлеры умеет
  # разбирать сам git.
  if ! trailers=$(git show -s --format=%B "$commit" | git interpret-trailers --parse); then
    echo "Failed to parse trailers of $commit" >&2
    exit 1
  fi
  if ! grep -Eiq '^Signed-off-by:[[:space:]]+.+[[:space:]]+<[^>]+>[[:space:]]*$' <<<"$trailers"; then
    echo "Missing valid Signed-off-by trailer: $commit $(git show -s --format=%s "$commit")" >&2
    failed=1
  fi
done

if [[ $failed -ne 0 ]]; then
  echo "Sign every commit with: git commit --signoff" >&2
  exit 1
fi

echo "Verified DCO sign-off on ${#commits[@]} commit(s)."
