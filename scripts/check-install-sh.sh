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

# Драйвер окон — на Windows API. Обещать его на macOS нельзя.
check 'честно сказано, что окна пока только на Windows' \
  "$(grep -q 'только на Windows' "$SCRIPT" && printf 'да')"

# Команда из README должна работать. Через конвейер ключи достаются скрипту
# только после `-s --`: иначе их забирает себе сам bash.
for readme in "$ROOT/README.md" "$ROOT/README.en.md"; do
  check "в $(basename "$readme") ключи доходят до скрипта, а не до bash"     "$(grep -q 'install.sh | bash --' "$readme" || printf 'да')"
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
shell_files=$(find "$ROOT/scripts" -name '*.sh' 2>/dev/null; find "$ROOT/.github/workflows" -name '*.yml' 2>/dev/null; echo "$ROOT/install.sh")
cyrillic_names=''
for file in $shell_files; do
  [ -f "$file" ] || continue
  # Строки-комментарии пропускаем: в них кириллица и должна быть.
  hits=$(grep -nE '(^|[^#[:alnum:]_])[А-Яа-яЁё][А-Яа-яЁё_0-9]*=' "$file" 2>/dev/null | grep -vE '^[0-9]+:[[:space:]]*#' || true)
  if [ -n "$hits" ]; then
    cyrillic_names="$cyrillic_names$(basename "$file"): $(echo "$hits" | head -2 | tr '
' ' ')
"
  fi
done
check 'в оболочке нет имён кириллицей: bash отвечает на них 127'   "$([ -z "$cyrillic_names" ] && printf 'да')"
[ -z "$cyrillic_names" ] || printf '%s' "$cyrillic_names"

if [ "$failures" -gt 0 ]; then
  printf 'Провалено проверок: %s\n' "$failures" >&2
  exit 1
fi
printf 'install.sh: проверки функций пройдены\n'
