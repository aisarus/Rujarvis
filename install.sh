#!/bin/bash
#
# Установка Rujarvis на macOS одной командой.
#
#   curl -fsSL https://raw.githubusercontent.com/aisarus/Rujarvis/main/install.sh | bash
#
# Правило то же, что и у install.ps1: скрипт ставит сам, а не советует. Что бы
# у человека ни стояло — нет Homebrew, старый Node, чужая версия pnpm — он
# доводит дело до конца и останавливается только тогда, когда сделать
# действительно нечего.
#
# Ключи:
#   --language ru|en        язык голоса и интерфейса (по умолчанию ru)
#   --branch <ветка>        какую ветку ставить (по умолчанию main)
#   --whisper-model <имя>   модель распознавания
#   --autostart             запускать при входе в систему
#   --no-launch             не запускать после установки
#
# Bash на macOS — версии 3.2 (Apple не обновляет его из-за лицензии GPLv3),
# поэтому здесь нет ассоциативных массивов и прочего из bash 4.

set -euo pipefail

REPO_URL="https://github.com/aisarus/Rujarvis.git"
INSTALL_ROOT="$HOME/Library/Application Support/Rujarvis"
SOURCE_DIR="$INSTALL_ROOT/src"
APP_DIR="$HOME/Applications/Rujarvis.app"
AGENT_PLIST="$HOME/Library/LaunchAgents/com.rujarvis.app.plist"

LANGUAGE="ru"
BRANCH="main"
WHISPER_MODEL=""
AUTOSTART=0
LAUNCH=1

# --- разговор с человеком ----------------------------------------------------

if [ -t 1 ]; then
  C_STEP=$'\033[1;36m'; C_OK=$'\033[0;32m'; C_NOTE=$'\033[0;90m'
  C_WARN=$'\033[0;33m'; C_ERR=$'\033[1;31m'; C_OFF=$'\033[0m'
else
  C_STEP=""; C_OK=""; C_NOTE=""; C_WARN=""; C_ERR=""; C_OFF=""
fi

step() { printf '\n%s==> %s%s\n' "$C_STEP" "$1" "$C_OFF"; }
ok()   { printf '    %s%s%s\n' "$C_OK" "$1" "$C_OFF"; }
note() { printf '    %s%s%s\n' "$C_NOTE" "$1" "$C_OFF"; }
warn() { printf '    %s%s%s\n' "$C_WARN" "$1" "$C_OFF"; }
die()  { printf '\n%s%s%s\n\n' "$C_ERR" "$1" "$C_OFF" >&2; exit 1; }

have() { command -v "$1" >/dev/null 2>&1; }

# Мажор версии: из «v22.22.1», «22.22.1» и «9.15.9» одинаково получаем число.
major_of() { printf '%s' "${1#v}" | cut -d. -f1; }

usage() {
  cat <<'HELP'
Установка Rujarvis на macOS.

  --language ru|en        язык голоса и интерфейса (по умолчанию ru)
  --branch <ветка>        какую ветку ставить (по умолчанию main)
  --whisper-model <имя>   модель распознавания
  --autostart             запускать при входе в систему
  --no-launch             не запускать после установки
HELP
}

# --- разбор ключей -----------------------------------------------------------

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --language)      LANGUAGE="${2:-ru}"; shift 2 ;;
      --branch)        BRANCH="${2:-main}"; shift 2 ;;
      --whisper-model) WHISPER_MODEL="${2:-}"; shift 2 ;;
      --autostart)     AUTOSTART=1; shift ;;
      --no-launch)     LAUNCH=0; shift ;;
      -h|--help)       usage; exit 0 ;;
      *)               die "Неизвестный ключ: $1" ;;
    esac
  done

  case "$LANGUAGE" in
    ru|en) ;;
    *) die "Язык должен быть ru или en, а не «$LANGUAGE»." ;;
  esac
}

# Отсюда начинается сама установка. Проверке дальше не нужно: она берёт
# помощников выше и зовёт их сама. Без этой двери тест запустил бы установку.
if [ "${RUJARVIS_INSTALL_TEST:-}" = "1" ]; then
  return 0 2>/dev/null || exit 0
fi

# Установка целиком лежит в функции, а зовётся последней строкой файла.
#
# Скрипт запускают через `curl … | bash`, а bash читает stdin по мере
# выполнения. Два следствия, оба тихие:
#
#   - оборвись загрузка на середине, bash выполнит начало — например,
#     `rm -rf "$APP_DIR"` — и остановится, не собрав ничего взамен;
#   - любой дочерний процесс, читающий stdin (вопрос corepack о скачивании,
#     brew, `pnpm jarvis:setup`), съест остаток текста скрипта, и установка
#     кончится посередине без единого слова об этом.
#
# С функцией bash обязан дочитать файл до последней строки, прежде чем
# выполнить хоть что-то из неё.
main() {
parse_args "$@"

printf '\n  %sRujarvis%s\n' "$C_STEP" "$C_OFF"
printf '  Голосовой ассистент для macOS · Voice assistant for macOS\n\n'

[ "$(uname -s)" = "Darwin" ] || die "Этот установщик для macOS. Для Windows возьмите install.ps1."

# --- Homebrew ----------------------------------------------------------------
#
# На macOS нет своего менеджера пакетов, а Node и git откуда-то взять надо.
# Homebrew — то, чем это делают все, и он ставится в папку пользователя на
# Apple Silicon. Если его нет, ставим: человек просил одну команду.

brew_shellenv() {
  # brew не в PATH сразу после установки: на Apple Silicon он живёт в
  # /opt/homebrew, которого в PATH по умолчанию нет вовсе.
  for candidate in /opt/homebrew/bin/brew /usr/local/bin/brew; do
    if [ -x "$candidate" ]; then
      eval "$("$candidate" shellenv)"
      return 0
    fi
  done
  return 1
}

ensure_brew() {
  have brew && return 0
  brew_shellenv && have brew && return 0

  note 'Homebrew не найден — ставлю.'
  # NONINTERACTIVE=1 убирает «нажмите Enter», но пароль sudo Homebrew всё
  # равно спросит сам: он создаёт папки вне домашней. Это его разговор с
  # человеком, не наш.
  NONINTERACTIVE=1 /bin/bash -c \
    "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" || true

  brew_shellenv || true
  have brew
}

# --- зависимости -------------------------------------------------------------

step 'Проверяю зависимости'

if have brew || brew_shellenv; then :; fi

if have git; then
  ok "git $(git --version | awk '{print $3}')"
else
  note 'git не найден — ставлю.'
  if ensure_brew; then
    brew install git >/dev/null 2>&1 || true
  fi
  have git || die "Не удалось поставить git. Поставьте Command Line Tools: xcode-select --install"
  ok "git $(git --version | awk '{print $3}')"
fi

install_node() {
  if ensure_brew; then
    note 'Ставлю Node через Homebrew…'
    brew install node >/dev/null 2>&1 || brew upgrade node >/dev/null 2>&1 || true
    brew_shellenv || true
  fi
  have node
}

if have node; then
  ok "Node.js $(node --version)"
else
  install_node || die "Не удалось поставить Node.js. Поставьте его с https://nodejs.org и запустите установщик снова."
  ok "Node.js $(node --version)"
fi

# --- исходники ---------------------------------------------------------------
#
# Сначала исходники, потом проверка версий Node и pnpm: нужные версии написаны
# в самом проекте (.nvmrc и packageManager), и до загрузки их неоткуда узнать.

step 'Получаю исходники'
if [ -d "$SOURCE_DIR/.git" ]; then
  note "Обновляю $SOURCE_DIR"
  # Клон делается с `--depth 1 --branch`, а это подразумевает
  # `--single-branch`: обычный `fetch origin <ветка>` не заводит
  # `origin/<ветка>`, и `checkout` падал с «pathspec did not match» — сменить
  # ветку без удаления папки было нельзя. Refspec заводит ссылку явно, а
  # `checkout -B` переводит на неё; отдельный `pull` после этого не нужен.
  git -C "$SOURCE_DIR" fetch origin "+refs/heads/$BRANCH:refs/remotes/origin/$BRANCH"     || die 'Не удалось выполнить: git fetch'
  # Повторный запуск обязан довести до вершины ветки, а не умереть на полпути.
  #
  # `checkout -B` падает с «would be overwritten», если в папке остались чужие
  # правки — а они там появляются сами: сборка, скачанные модели, случайно
  # тронутый файл. Установщик — не место для разбора чужих изменений, но и
  # молчать нельзя: если человек правил код сам, он должен узнать, куда это
  # уехало, а не обнаружить потерю потом.
  if ! git -C "$SOURCE_DIR" diff --quiet || ! git -C "$SOURCE_DIR" diff --cached --quiet; then
    stash_name="rujarvis-install-$(date +%Y%m%d-%H%M%S)"
    warn "В $SOURCE_DIR есть изменения. Убираю их в git stash: $stash_name"
    warn 'Вернуть: git -C "'"$SOURCE_DIR"'" stash list, затем git stash pop.'
    git -C "$SOURCE_DIR" stash push -m "$stash_name" >/dev/null 2>&1 || true
  fi
  git -C "$SOURCE_DIR" checkout -B "$BRANCH" "origin/$BRANCH"     || die 'Не удалось выполнить: git checkout'
  # Вершина ветки, а не «что-то из неё»: между fetch и checkout ничего не
  # пропало, и человек получает ровно то, что лежит в origin сейчас.
  git -C "$SOURCE_DIR" reset --hard "origin/$BRANCH" >/dev/null     || die 'Не удалось выполнить: git reset'
else
  mkdir -p "$INSTALL_ROOT"
  git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$SOURCE_DIR" || die 'Не удалось выполнить: git clone'
fi
[ -f "$SOURCE_DIR/app/main.ts" ] \
  || die "В ветке «$BRANCH» нет приложения Rujarvis (app/main.ts). Укажите нужную ветку через --branch."
ok "Исходники: $SOURCE_DIR"

# --- версия Node -------------------------------------------------------------
#
# Node нужен только для сборки: годится закреплённый мажор и всё, что новее.

if [ -f "$SOURCE_DIR/.nvmrc" ]; then
  wanted_node="$(tr -d ' \t\r\n' < "$SOURCE_DIR/.nvmrc")"
  wanted_major="$(major_of "$wanted_node")"
  current_major="$(major_of "$(node --version)")"
  if [ "$current_major" -lt "$wanted_major" ]; then
    note "Установлен Node $(node --version), нужен $wanted_major или новее — обновляю."
    install_node || true
    current_major="$(major_of "$(node --version)")"
    [ "$current_major" -ge "$wanted_major" ] \
      || die "Нужен Node.js $wanted_major или новее, а установлен $(node --version).

Обновите Node и запустите установщик снова:

    brew upgrade node"
  fi
  ok "Node.js $(node --version)"
fi

# --- версия pnpm -------------------------------------------------------------
#
# Порядок тот же, что и на Windows, и по той же причине: corepack кладёт свою
# заглушку рядом с Node и без прав на эту папку получает отказ. npm ставит
# туда, куда человеку писать можно, и прав не просит — значит он первый.
#
# Версию спрашиваем В ПАПКЕ ПРОЕКТА: pnpm 10 и новее читает packageManager из
# package.json и подменяет себя нужной версией, но только изнутри проекта.

wanted_pnpm="$(node -p "(require('$SOURCE_DIR/package.json').packageManager||'').split('@').pop()" 2>/dev/null || true)"
if [ -n "$wanted_pnpm" ]; then
  wanted_pnpm_major="$(major_of "$wanted_pnpm")"

  pnpm_version_here() {
    have pnpm || return 1
    ( cd "$SOURCE_DIR" && pnpm --version 2>/dev/null ) | tr -d ' \r\n'
  }

  current_pnpm="$(pnpm_version_here || true)"
  if [ -n "$current_pnpm" ] && [ "$(major_of "$current_pnpm")" = "$wanted_pnpm_major" ]; then
    ok "pnpm $current_pnpm"
  else
    if [ -n "$current_pnpm" ]; then
      note "Установлен pnpm $current_pnpm, нужен $wanted_pnpm."
    else
      note "pnpm не найден, нужен $wanted_pnpm."
    fi

    note 'Ставлю pnpm через npm.'
    npm install -g "pnpm@$wanted_pnpm" >/dev/null 2>&1 || true
    current_pnpm="$(pnpm_version_here || true)"

    if [ -z "$current_pnpm" ] || [ "$(major_of "$current_pnpm")" != "$wanted_pnpm_major" ]; then
      note 'npm не справился — пробую corepack.'
      corepack enable >/dev/null 2>&1 || true
      corepack prepare "pnpm@$wanted_pnpm" --activate >/dev/null 2>&1 || true
      current_pnpm="$(pnpm_version_here || true)"
    fi

    if [ -z "$current_pnpm" ] || [ "$(major_of "$current_pnpm")" != "$wanted_pnpm_major" ]; then
      # Последний путь: своя папка, куда писать можно точно. Так установка
      # переживает Node, поставленный из pkg в /usr/local под root.
      note 'Ставлю pnpm в папку Джарвиса — туда писать можно без прав.'
      npm_config_prefix="$INSTALL_ROOT/node" npm install -g "pnpm@$wanted_pnpm" >/dev/null 2>&1 || true
      PATH="$INSTALL_ROOT/node/bin:$PATH"
      export PATH
      current_pnpm="$(pnpm_version_here || true)"
    fi

    [ -n "$current_pnpm" ] && [ "$(major_of "$current_pnpm")" = "$wanted_pnpm_major" ] \
      || die "Нужен pnpm $wanted_pnpm, а pnpm отвечает «${current_pnpm:-ничего}».

Выполните вручную и запустите установщик снова:

    npm install -g pnpm@$wanted_pnpm
    pnpm --version"

    ok "pnpm $current_pnpm"
  fi
fi

# --- сборка ------------------------------------------------------------------

step 'Ставлю зависимости и собираю'
( cd "$SOURCE_DIR" && pnpm install --frozen-lockfile ) || die 'Не удалось выполнить: pnpm install'
( cd "$SOURCE_DIR" && pnpm build ) || die 'Не удалось выполнить: pnpm build'
ok 'Приложение собрано.'

# Запасной браузер, если своего на машине нет.
#
# Вкладками Джарвис водит через Playwright, а тот ведёт Chromium: Edge, Chrome
# или свою сборку. На маке Edge и Chrome есть не всегда — у многих там один
# Safari, а его Playwright так не возьмёт: это WebKit, не Chromium. Без
# запасной сборки вкладки на таком маке не открылись бы вовсе.
#
# Скачивание не обязательное: Edge или Chrome, если они есть, берутся первыми,
# и тогда это просто лежит про запас. Поэтому неудача здесь не валит установку
# — но и молчать о ней нельзя.
step 'Кладу запасной браузер'
if ( cd "$SOURCE_DIR" && pnpm exec playwright install chromium ); then
  ok 'Запасной браузер на месте.'
else
  warn 'Запасной браузер не скачался. Вкладки будут работать, только если есть Chrome или Edge.'
fi

step 'Скачиваю модели речи'
if [ -n "$WHISPER_MODEL" ]; then
  ( cd "$SOURCE_DIR" && pnpm jarvis:setup -- --language "$LANGUAGE" --model "$WHISPER_MODEL" ) \
    || die 'Не удалось выполнить: jarvis:setup'
else
  ( cd "$SOURCE_DIR" && pnpm jarvis:setup -- --language "$LANGUAGE" ) \
    || die 'Не удалось выполнить: jarvis:setup'
fi

# --- ярлык -------------------------------------------------------------------
#
# На macOS ярлык — это папка .app. Внутри скрипт, который зовёт Electron с
# точкой входа: так же, как ярлык в меню «Пуск» на Windows.

step 'Создаю ярлык'

ELECTRON_BIN="$SOURCE_DIR/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
ENTRY="$SOURCE_DIR/dist/app/main.cjs"
[ -x "$ELECTRON_BIN" ] || die "Electron не найден: $ELECTRON_BIN. Запустите установщик снова."

rm -rf "$APP_DIR"
mkdir -p "$APP_DIR/Contents/MacOS" "$APP_DIR/Contents/Resources"

cat > "$APP_DIR/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Rujarvis</string>
  <key>CFBundleDisplayName</key><string>Rujarvis</string>
  <key>CFBundleIdentifier</key><string>com.rujarvis.app</string>
  <key>CFBundleExecutable</key><string>Rujarvis</string>
  <key>CFBundleIconFile</key><string>icon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>LSUIElement</key><true/>
  <key>NSMicrophoneUsageDescription</key>
  <string>Rujarvis слушает голосовые команды.</string>
  <!--
    Apple Events — это весь драйвер рабочего стола на маке.
    Список окон, подъём, нажатия, ввод, чтение элементов и вождение Safari идут
    через osascript, а это Apple Events. Без объяснения в Info.plist macOS
    отказывает и делает это тихо: ни окна, ни ошибки — просто ничего не
    происходит. Строку человек увидит в системном запросе, и она должна
    объяснять, зачем это нужно.
  -->
  <key>NSAppleEventsUsageDescription</key>
  <string>Rujarvis управляет окнами и программами по вашим голосовым командам.</string>
</dict>
</plist>
PLIST

cat > "$APP_DIR/Contents/MacOS/Rujarvis" <<LAUNCHER
#!/bin/bash
# Ярлык Rujarvis. Путь к pnpm сюда не нужен: приложение уже собрано.
exec "$ELECTRON_BIN" "$ENTRY" "\$@"
LAUNCHER
chmod +x "$APP_DIR/Contents/MacOS/Rujarvis"

# Значок: из png делаем icns штатными средствами системы, без лишних программ.
if [ -f "$SOURCE_DIR/resources/icon.png" ] && have sips && have iconutil; then
  iconset="$(mktemp -d)/icon.iconset"
  mkdir -p "$iconset"
  for size in 16 32 128 256 512; do
    sips -z "$size" "$size" "$SOURCE_DIR/resources/icon.png" \
      --out "$iconset/icon_${size}x${size}.png" >/dev/null 2>&1 || true
    sips -z "$((size * 2))" "$((size * 2))" "$SOURCE_DIR/resources/icon.png" \
      --out "$iconset/icon_${size}x${size}@2x.png" >/dev/null 2>&1 || true
  done
  iconutil -c icns "$iconset" -o "$APP_DIR/Contents/Resources/icon.icns" >/dev/null 2>&1 || true
  rm -rf "$(dirname "$iconset")"
fi

ok "Ярлык: $APP_DIR"

if [ "$AUTOSTART" = "1" ]; then
  mkdir -p "$(dirname "$AGENT_PLIST")"
  cat > "$AGENT_PLIST" <<AGENT
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.rujarvis.app</string>
  <key>ProgramArguments</key>
  <array>
    <string>$APP_DIR/Contents/MacOS/Rujarvis</string>
  </array>
  <key>RunAtLoad</key><true/>
</dict>
</plist>
AGENT
  ok 'Запуск при входе включён.'
fi

# --- итог --------------------------------------------------------------------

printf '\n  %sГотово.%s\n\n' "$C_OK" "$C_OFF"
printf '  Rujarvis живёт в строке меню. При первом запуске он проведёт по настройке:\n'
printf '  вход в Claude Code, проверка микрофона — и можно говорить.\n\n'
printf '  Папка Джарвиса: %s\n' "$INSTALL_ROOT"
printf '  Лог:            %s\n' "$INSTALL_ROOT/logs/jarvis.log"
printf '\n'
note 'Управление окнами на маке спросит два разрешения в «Конфиденциальности»:'
note '«Универсальный доступ» — окна, мышь, клавиши; «Запись экрана» — снимки.'
note 'Без первого нажатия не падают, а молча ничего не делают.'
printf '\n'
note 'Микрофон macOS спросит один раз — разрешение будет записано на Electron:'
note 'приложение запускается его двоичным файлом, своей подписи у сборки пока нет.'
printf '\n'

# Ярлык на Рабочий стол.
#
# Папку ~/Applications маковод открывает не каждый день, а первый запуск должен
# быть очевидным: человек только что поставил программу и ищет её глазами.
# Псевдоним (alias) через Finder, а не symlink: symlink на .app Finder
# показывает файлом со сломанным значком, а alias — настоящей программой.
desktop_dir="$HOME/Desktop"
if [ -d "$desktop_dir" ]; then
  if osascript -e 'on run {appPath, deskPath}' \
    -e 'tell application "Finder"' \
    -e 'set src to POSIX file appPath as alias' \
    -e 'set dst to POSIX file deskPath as alias' \
    -e 'if exists (file "Rujarvis" of dst) then delete (file "Rujarvis" of dst)' \
    -e 'make new alias file at dst to src with properties {name:"Rujarvis"}' \
    -e 'end tell' \
    -e 'end run' "$APP_DIR" "$desktop_dir" >/dev/null 2>&1; then
    ok "Ярлык на Рабочем столе: $desktop_dir/Rujarvis"
  else
    # Finder мог быть не запущен или отказать в Apple Events. Тогда symlink:
    # выглядит хуже, но открывает то же самое.
    if ln -sfn "$APP_DIR" "$desktop_dir/Rujarvis.app"; then
      ok "Ярлык на Рабочем столе: $desktop_dir/Rujarvis.app"
    else
      warn "Не вышло положить ярлык на Рабочий стол. Программа здесь: $APP_DIR"
    fi
  fi
fi

if [ "$LAUNCH" = "1" ]; then
  open "$APP_DIR" || true
fi
}

main "$@"
