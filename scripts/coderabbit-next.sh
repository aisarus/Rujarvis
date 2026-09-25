#!/bin/bash
#
# Попросить разбор у следующего куска, который его ещё не получил.
#
#   bash scripts/coderabbit-next.sh
#
# Зачем. У бесплатного плана CodeRabbit лимит — примерно один разбор в час:
# «Review limit reached. Next included review available in 59 minutes». Поэтому
# полный обход кодовой базы (см. `coderabbit-full-review.mjs`) растягивается на
# часы, и кто-то должен дёргать следующий кусок, когда лимит отпускает.
#
# Скрипт делает ровно один шаг: находит первый открытый PR с пометкой «разбор»
# без встроенных замечаний и просит разбор у него. Если таких нет — молчит и
# выходит с нулём, поэтому его безопасно ставить в расписание: закончились
# куски — расписание перестаёт что-либо делать.

set -uo pipefail

repo=$(gh repo view --json nameWithOwner --jq .nameWithOwner) || {
  echo 'Не удалось определить репозиторий.' >&2
  exit 1
}

# Куски помечены в заголовке: «НЕ СЛИВАТЬ: разбор N/M — …».
list=$(gh pr list --repo "$repo" --state open --limit 50 \
  --json number,title --jq '.[] | select(.title | test("разбор [0-9]+/")) | .number') || {
  echo 'Не удалось получить список PR.' >&2
  exit 1
}

if [ -z "$list" ]; then
  echo 'Кусков на разбор нет.'
  exit 0
fi

for pr in $list; do
  # Складываем страницы: `--paginate --jq` печатает число на каждую отдельно.
  inline=$(gh api "repos/$repo/pulls/$pr/comments" --paginate \
    --jq '[.[] | select(.user.login | test("coderabbit";"i"))] | length' \
    | awk '{sum += $1} END {print sum + 0}') || {
    echo "Не удалось прочитать замечания PR №$pr." >&2
    exit 1
  }

  if [ "$inline" -gt 0 ]; then
    echo "PR №$pr уже разобран ($inline замечаний) — пропускаю."
    continue
  fi

  echo "Прошу разбор у PR №$pr…"
  gh pr comment "$pr" --repo "$repo" --body '@coderabbitai review' >/dev/null || {
    echo "Не удалось попросить разбор у PR №$pr." >&2
    exit 1
  }
  echo "Запрошено. Следующий кусок — в следующий раз, когда отпустит лимит."
  exit 0
done

echo 'Все куски уже разобраны.'
