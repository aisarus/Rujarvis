#!/bin/bash
#
# Проверка install.sh: разбор синтаксиса и тесты чистых функций.
#
#   bash scripts/check-install-sh.sh
#
# Сам путь установки не выполняется: install.sh подключается с
# RUJARVIS_INSTALL_TEST=1 и отдаёт управление сразу после определения
# помощников. Поэтому проверку можно гонять на любой платформе с bash — и
# нужно: macOS у автора под рукой нет, а отправлять туда непроверенный
# установщик нечестно.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$ROOT/install.sh"

failures=0
check() {
  # $1 — что проверяем, $2 — «да» или пусто.
  if [ -n "${2:-}" ]; then
    printf '  ok   %s\n' "$1"
  else
    printf '  FAIL %s\n' "$1"
    failures=$((failures + 1))
  fi
}

# --- синтаксис ---------------------------------------------------------------

if bash -n "$SCRIPT"; then
  printf 'install.sh: синтаксис в порядке\n'
else
  printf 'install.sh: синтаксические ошибки\n' >&2
  exit 1
fi

# --- помощники ---------------------------------------------------------------
# Подключаем без запуска установки.

RUJARVIS_INSTALL_TEST=1
export RUJARVIS_INSTALL_TEST
# shellcheck source=/dev/null
. "$SCRIPT"
set +e  # install.sh включает set -e для себя; проверке он мешает

check 'мажор из версии с v' "$([ "$(major_of 'v22.22.1')" = '22' ] && printf 'да')"
check 'мажор из версии без v' "$([ "$(major_of '9.15.9')" = '9' ] && printf 'да')"
check 'мажор из одного числа' "$([ "$(major_of '24')" = '24' ] && printf 'да')"

# --- разбор ключей -----------------------------------------------------------

check 'по умолчанию русский' "$([ "$LANGUAGE" = 'ru' ] && printf 'да')"
check 'по умолчанию ветка main' "$([ "$BRANCH" = 'main' ] && printf 'да')"
check 'по умолчанию без автозапуска' "$([ "$AUTOSTART" = '0' ] && printf 'да')"
check 'по умолчанию запускает после установки' "$([ "$LAUNCH" = '1' ] && printf 'да')"

(
  parse_args --language en --branch проба --whisper-model whisper-base --autostart --no-launch
  [ "$LANGUAGE" = 'en' ] && [ "$BRANCH" = 'проба' ] && [ "$WHISPER_MODEL" = 'whisper-base' ] \
    && [ "$AUTOSTART" = '1' ] && [ "$LAUNCH" = '0' ]
) >/dev/null 2>&1
check 'ключи разбираются все сразу' "$([ $? -eq 0 ] && printf 'да')"

( parse_args --language de ) >/dev/null 2>&1
check 'чужой язык отклоняется' "$([ $? -ne 0 ] && printf 'да')"

( parse_args --выдумка ) >/dev/null 2>&1
check 'неизвестный ключ отклоняется' "$([ $? -ne 0 ] && printf 'да')"

check 'подсказка перечисляет ключи' \
  "$(usage 2>/dev/null | grep -q -- '--autostart' && printf 'да')"

# --- правила, которые стоили живых прогонов ----------------------------------
#
# Их не вызвать функцией: они живут в порядке шагов установки. Но забыть их
# дороже, чем проверить текстом.

npm_line="$(grep -n 'npm install -g "pnpm@' "$SCRIPT" | head -1 | cut -d: -f1)"
corepack_line="$(grep -n 'corepack prepare' "$SCRIPT" | head -1 | cut -d: -f1)"
check 'npm пробуют раньше corepack: corepack просит прав' \
  "$([ -n "$npm_line" ] && [ -n "$corepack_line" ] && [ "$npm_line" -lt "$corepack_line" ] && printf 'да')"

check 'версию pnpm спрашивают в папке проекта' \
  "$(grep -q 'cd "$SOURCE_DIR" && pnpm --version' "$SCRIPT" && printf 'да')"

check 'есть запасная установка pnpm в свою папку' \
  "$(grep -q 'npm_config_prefix=' "$SCRIPT" && printf 'да')"

# sudo зовёт только установщик Homebrew — свой и в своём разговоре с человеком.
check 'установщик сам не зовёт sudo' \
  "$(! grep -qE '^[^#]*\bsudo\b' "$SCRIPT" && printf 'да')"

check 'ставит в папку macOS, а не в домашнюю россыпь' \
  "$(grep -q 'Library/Application Support/Rujarvis' "$SCRIPT" && printf 'да')"

check 'ярлык — это .app, а не голый скрипт' \
  "$(grep -q 'Applications/Rujarvis.app' "$SCRIPT" && printf 'да')"

# Микрофон без этого ключа macOS не даст, а Джарвис без микрофона — картинка.
check 'в Info.plist есть объяснение про микрофон' \
  "$(grep -q 'NSMicrophoneUsageDescription' "$SCRIPT" && printf 'да')"

# Два замка Apple названы поимённо.
#
# Здесь держалась фраза «окна пока только на Windows» — и эта проверка
# держала её ЗА руку, пока драйвер мака уже сутки как работал. Проверка,
# сторожащая устаревшее обещание, хуже отсутствующей: она превращает правку
# документации в красный прогон.
#
# Без «Универсального доступа» CGEvent не падает, а молча ничего не делает —
# худший из отказов, и человек должен узнать о разрешении до первой команды,
# а не после десяти безответных.
check 'названы оба разрешения macOS, без которых окна молчат' \
  "$(grep -q 'Универсальный доступ' "$SCRIPT" && grep -q 'Запись экрана' "$SCRIPT" && printf 'да')"

# Команда из README должна работать. Через конвейер ключи достаются скрипту
# только после `-s --`: иначе их забирает себе сам bash.
#
# Проверяли отсутствие ОДНОЙ неправильной формы — `| bash --`. Мимо проходили
# `| bash --language en` и `| bash -s --language en`: в обеих ключи забирает
# себе bash. Теперь правило прямое: если после `bash` вообще что-то стоит,
# это обязано быть `-s --`.
for readme in "$ROOT/README.md" "$ROOT/README.en.md"; do
  bad=$(grep -nE 'install\.sh[[:space:]]*\|[[:space:]]*bash[[:space:]]+' "$readme"     | grep -vE '\|[[:space:]]*bash[[:space:]]+-s[[:space:]]+--([[:space:]]|$)' || true)
  check "в $(basename "$readme") ключи доходят до скрипта, а не до bash"     "$([ -z "$bad" ] && printf 'да')"
  [ -z "$bad" ] || printf '  %s
' "$bad"
  check "в $(basename "$readme") есть команда установки на macOS"     "$(grep -q 'install.sh' "$readme" && printf 'да')"
done

# --- кириллица в именах оболочки ---------------------------------------------
#
# В bash имя переменной — только латиница. `СКОЛЬКО=...` не присваивание, а
# команда, и оболочка отвечает 127. Поймано трижды за один день: дважды в
# прогоне на macOS и один раз в этих же проверках. Русские СТРОКИ в кавычках
# при этом живут прекрасно — ломаются именно имена.
#
# Ищем присваивания и подстановки с кириллицей в скриптах и в прогонах CI.
#
# Список читается ПО СТРОКАМ, а не делением по пробелам.
#
# `for file in $shell_files` разваливал путь вида «/Users/x/Мои проекты/…» на
# куски, каждый кусок отсеивался как несуществующий файл, и проверка печатала
# «ok», не посмотрев ни одного файла. Ровно тот провал, который она и должна
# ловить. Поэтому же ниже считается, сколько файлов реально просмотрено: ноль
# — это не успех.
shell_files=$(find "$ROOT/scripts" -name '*.sh' 2>/dev/null; find "$ROOT/.github/workflows" -name '*.yml' 2>/dev/null; echo "$ROOT/install.sh")
cyrillic_names=''
looked_at=0
while IFS= read -r file; do
  [ -n "$file" ] || continue
  [ -f "$file" ] || continue
  looked_at=$((looked_at + 1))
  # Строки-комментарии пропускаем: в них кириллица и должна быть.
  hits=$(grep -nE '(^|[^#[:alnum:]_])[А-Яа-яЁё][А-Яа-яЁё_0-9]*=' "$file" 2>/dev/null | grep -vE '^[0-9]+:[[:space:]]*#' || true)
  if [ -n "$hits" ]; then
    cyrillic_names="$cyrillic_names$(basename "$file"): $(echo "$hits" | head -2 | tr '
' ' ')
"
  fi
done <<EOF
$shell_files
EOF
check 'проверке кириллицы досталось что проверять'   "$([ "$looked_at" -gt 0 ] && printf 'да')"
check 'в оболочке нет имён кириллицей: bash отвечает на них 127'   "$([ -z "$cyrillic_names" ] && printf 'да')"
[ -z "$cyrillic_names" ] || printf '%s' "$cyrillic_names"

if [ "$failures" -gt 0 ]; then
  printf 'Провалено проверок: %s\n' "$failures" >&2
  exit 1
fi
printf 'install.sh: проверки функций пройдены\n'
