#!/bin/bash
#
# Забрать разбор CodeRabbit в читаемом виде — и, если надо, попросить его.
#
#   bash scripts/coderabbit.sh              # разбор для PR текущей ветки
#   bash scripts/coderabbit.sh 32           # разбор для PR №32
#   bash scripts/coderabbit.sh 32 --ask     # попросить разбор и дождаться его
#
# Зачем скрипт. Замечания лежат в двух разных местах API — встроенные в код и
# общие к PR, — и в вебе их читать глазами долго. Скрипт складывает оба места
# в один текст: файл, строка, что сказано.
#
# Три правки по замечаниям самого CodeRabbit на первый вариант этого скрипта
# (PR №35) — он нашёл в нём ровно тот класс ошибок, против которого написан
# весь остальной проект:
#
#   1. `gh api --paginate --jq` печатает ответ НА КАЖДУЮ СТРАНИЦУ отдельно.
#      На двух страницах в переменной оказывалось две строки, и числовое
#      сравнение ломалось. Теперь страницы складываются в одно число.
#   2. Отказ `gh` подменялся нулём или текстом, и скрипт выходил с успехом,
#      ничего не запросив и ничего не получив. Теперь каждый вызов проверяется
#      и провал виден по коду возврата.
#   3. Ожидание ловило появление ВСТРОЕННОГО замечания. Но бот часто отвечает
#      только общим комментарием — «замечаний нет» или «лимит исчерпан», — и
#      тогда ждать было нечего, а скрипт ждал все десять минут. Теперь ждём
#      ЛЮБОГО ответа бота, а по истечении срока честно говорим, что ответа не
#      было.

set -uo pipefail

# Код возврата по умолчанию. Отказ бота и его молчание не должны выглядеть
# успехом: скрипт зовут из расписания, и там смотрят на код.
exit_code=0

pr="${1:-}"
ask="${2:-}"

if [ "$pr" = '--ask' ]; then
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

repo=$(gh repo view --json nameWithOwner --jq .nameWithOwner) || {
  echo 'Не удалось определить репозиторий.' >&2
  exit 1
}
echo "Разбор CodeRabbit: $repo, PR №$pr"

# Число со ВСЕХ страниц, а не с каждой по отдельности.
count_bot() {
  local where="$1" out
  out=$(gh api "repos/$repo/$where/$pr/comments" --paginate \
    --jq '[.[] | select(.user.login | test("coderabbit";"i"))] | length') || return 1
  # Каждая страница дала своё число — складываем.
  echo "$out" | awk '{sum += $1} END {print sum + 0}'
}

if [ "$ask" = '--ask' ]; then
  inline_before=$(count_bot pulls) || { echo 'Не удалось прочитать встроенные замечания.' >&2; exit 1; }
  issue_before=$(count_bot issues) || { echo 'Не удалось прочитать комментарии к PR.' >&2; exit 1; }
  echo "Прошу разбор (встроенных сейчас: $inline_before, общих: $issue_before)…"

  gh pr comment "$pr" --body '@coderabbitai review' >/dev/null || {
    echo 'Не удалось попросить разбор: gh pr comment вернул ошибку.' >&2
    exit 1
  }

  # Ждём ЛЮБОГО ответа бота: встроенного замечания или общего комментария.
  # Молчаливое ожидание неотличимо от поломки, поэтому ход виден.
  answered=''
  for i in $(seq 1 40); do
    sleep 15
    inline_now=$(count_bot pulls) || { echo 'Опрос не удался.' >&2; exit 1; }
    issue_now=$(count_bot issues) || { echo 'Опрос не удался.' >&2; exit 1; }
    printf '\r  жду %sс: встроенных %s, общих %s   ' "$((i * 15))" "$inline_now" "$issue_now"
    if [ "$inline_now" -gt "$inline_before" ] || [ "$issue_now" -gt "$issue_before" ]; then
      answered='да'
      break
    fi
  done
  echo ''

  if [ -z "$answered" ]; then
    echo 'Бот не ответил за десять минут. Ниже — то, что было до запроса.' >&2
    exit_code=1
  else
    # Ответ бота — ещё не разбор.
    #
    # На «лимит исчерпан» счётчик тоже растёт, ожидание кончается, и скрипт
    # печатал ПРЕЖНИЕ замечания с кодом 0 — как будто новый разбор выполнен.
    last=$(gh api "repos/$repo/issues/$pr/comments" --paginate       --jq '[.[] | select(.user.login | test("coderabbit";"i"))] | last | .body' || true)
    if printf '%s' "$last" | grep -qiE 'limit reached|rate limit|try again|quota'; then
      echo 'ОТКАЗ: бот ответил про лимит, а не разбором. Ниже — то, что было раньше.' >&2
      exit_code=1
    fi
  fi
fi

echo ''
echo '=== Замечания по строкам ==='
gh api "repos/$repo/pulls/$pr/comments" --paginate \
  --jq '.[] | select(.user.login | test("coderabbit";"i"))
        | "\n--- \(.path):\(.line // .original_line // "?")\n\(.body)"' \
  || { echo 'Не удалось получить встроенные замечания.' >&2; exit 1; }

echo ''
echo '=== Итоги review ==='
# Итог бот часто кладёт в тело review, а не в комментарий. Без этого раздела
# человек получал пустой «разбор», хотя итог опубликован.
gh api "repos/$repo/pulls/$pr/reviews" --paginate   --jq '.[] | select(.user.login | test("coderabbit";"i")) | select((.body // "") != "") | .body'   | sed -e 's/<!--.*-->//g' -e '/^[[:space:]]*$/d'   || { echo 'Не удалось получить review.' >&2; exit 1; }

echo ''
echo '=== Общее к PR ==='
# `pipefail` оставлен нарочно: провал `gh` не должен теряться за `sed`.
gh api "repos/$repo/issues/$pr/comments" --paginate \
  --jq '.[] | select(.user.login | test("coderabbit";"i")) | .body' \
  | sed -e 's/<!--.*-->//g' -e '/^[[:space:]]*$/d' \
  || { echo 'Не удалось получить общие комментарии.' >&2; exit 1; }

exit "$exit_code"
