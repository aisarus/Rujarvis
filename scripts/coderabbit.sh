#!/bin/bash
#
# Забрать разбор CodeRabbit в читаемом виде — и, если надо, попросить его.
#
#   bash scripts/coderabbit.sh              # разбор для PR текущей ветки
#   bash scripts/coderabbit.sh 32           # разбор для PR №32
#   bash scripts/coderabbit.sh 32 --ask     # попросить разбор и дождаться его
#
# Зачем скрипт. На бесплатном плане для открытых проектов CodeRabbit не
# ревьюит репозитории младше десяти звёзд: во всех прогонах висело «Review
# skipped… fewer than 10 stars». Разбор при этом можно попросить вручную —
# комментарием в PR, — но потом его замечания надо ещё и достать: они лежат в
# двух разных местах API (встроенные в код и общие к PR), и в вебе их читать
# глазами долго.
#
# Скрипт складывает оба места в один текст: файл, строка, что сказано.

set -uo pipefail

pr="${1:-}"
ask="${2:-}"

if [ "$pr" = "--ask" ]; then
  ask='--ask'
  pr=''
fi

if [ -z "$pr" ]; then
  pr=$(gh pr view --json number --jq .number 2>/dev/null)
fi
if [ -z "$pr" ]; then
  echo 'Не понял, какой PR: укажи номер или перейди на ветку с открытым PR.' >&2
  exit 1
fi

repo=$(gh repo view --json nameWithOwner --jq .nameWithOwner)
echo "Разбор CodeRabbit: $repo, PR №$pr"

count_inline() {
  gh api "repos/$repo/pulls/$pr/comments" --paginate \
    --jq '[.[] | select(.user.login | test("coderabbit";"i"))] | length' 2>/dev/null || echo 0
}

if [ "$ask" = '--ask' ]; then
  before=$(count_inline)
  echo "Прошу разбор (встроенных замечаний сейчас: $before)…"
  gh pr comment "$pr" --body '@coderabbitai review' >/dev/null

  # Ждём до десяти минут: бот отвечает не сразу, а молчаливое ожидание
  # неотличимо от поломки.
  for i in $(seq 1 40); do
    sleep 15
    now=$(count_inline)
    printf '\r  жду %sс, встроенных замечаний: %s   ' "$((i * 15))" "$now"
    if [ "${now:-0}" -gt "${before:-0}" ]; then
      echo ''
      break
    fi
  done
  echo ''
fi

echo ''
echo '=== Замечания по строкам ==='
gh api "repos/$repo/pulls/$pr/comments" --paginate \
  --jq '.[] | select(.user.login | test("coderabbit";"i"))
        | "\n--- \(.path):\(.line // .original_line // "?")\n\(.body)"' 2>/dev/null \
  || echo '(не удалось получить)'

echo ''
echo '=== Общее к PR ==='
gh api "repos/$repo/issues/$pr/comments" --paginate \
  --jq '.[] | select(.user.login | test("coderabbit";"i")) | .body' 2>/dev/null \
  | sed -e 's/<!--.*-->//g' -e '/^[[:space:]]*$/d' \
  || echo '(не удалось получить)'
