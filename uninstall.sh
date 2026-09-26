#!/bin/bash
#
# Удаление Rujarvis с мака.
#
#   bash "$HOME/Library/Application Support/Rujarvis/src/uninstall.sh"
#
# Закрывает работающий Джарвис этой установки (по точному пути его Electron,
# чужие программы не трогает), убирает автозапуск, приложение в
# ~/Applications, ярлык на Рабочем столе и папку установки целиком: модели
# речи, настройки, память, журнал, профиль браузера.
#
# НЕ трогает:
#   - папку результатов на Рабочем столе («Джарвис» / «Jarvis») — это
#     сделанная работа человека;
#   - вход в Claude Code и Codex (~/.claude, ~/.codex) — это чужие программы.
#
# 26.09.2026 владелец удалял Джарвиса руками, и это заняло несколько попыток.

set -euo pipefail

INSTALL_ROOT="$HOME/Library/Application Support/Rujarvis"
SOURCE_DIR="$INSTALL_ROOT/src"
APP_DIR="$HOME/Applications/Rujarvis.app"
AGENT_PLIST="$HOME/Library/LaunchAgents/com.rujarvis.app.plist"

if [ -t 1 ]; then
  C_STEP=$'\033[1;36m'; C_OK=$'\033[0;32m'; C_NOTE=$'\033[0;90m'
  C_ERR=$'\033[1;31m'; C_OFF=$'\033[0m'
else
  C_STEP=""; C_OK=""; C_NOTE=""; C_ERR=""; C_OFF=""
fi

step() { printf '\n%s==> %s%s\n' "$C_STEP" "$1" "$C_OFF"; }
ok()   { printf '    %s%s%s\n' "$C_OK" "$1" "$C_OFF"; }
note() { printf '    %s%s%s\n' "$C_NOTE" "$1" "$C_OFF"; }
die()  { printf '\n%s%s%s\n\n' "$C_ERR" "$1" "$C_OFF" >&2; exit 1; }

# Копия из install.sh: оба скрипта запускаются поодиночке, и общего файла рядом
# может не быть. check-install-sh.sh сверяет, что копии совпадают слово в слово.
own_jarvis_pids() {
  local bin="${1:-$SOURCE_DIR}/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
  ps -axo pid=,comm= | while read -r pid comm; do
    if [ "$comm" = "$bin" ]; then echo "$pid"; fi
  done
}

kill_tree() {
  local child
  for child in $(pgrep -P "$1" 2>/dev/null || true); do kill_tree "$child"; done
  kill -TERM "$1" 2>/dev/null || true
}

stop_running_jarvis() {
  local src="${1:-$SOURCE_DIR}" pids pid parent waited=0
  pids=" $(own_jarvis_pids "$src" | tr '\n' ' ')"
  if [ -z "$(printf '%s' "$pids" | tr -d ' ')" ]; then return 1; fi
  for pid in $pids; do
    # Главные — те, чей родитель не из этого же списка: остальные уйдут с ними.
    parent="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ' || true)"
    case "$pids " in *" $parent "*) continue ;; esac
    note "Закрываю работающий Джарвис (pid $pid): иначе он остаётся на старом коде."
    kill_tree "$pid"
  done
  while [ -n "$(own_jarvis_pids "$src")" ] && [ "$waited" -lt 20 ]; do sleep 1; waited=$((waited + 1)); done
  for pid in $(own_jarvis_pids "$src"); do kill -KILL "$pid" 2>/dev/null || true; done
  sleep 1
  if [ -n "$(own_jarvis_pids "$src")" ]; then
    die 'Джарвис не закрылся. Закройте его из строки меню и запустите установку снова.'
  fi
  return 0
}

# Удаляется только папка, которая правда Джарвис: имя Rujarvis и внутри его
# приложение или данные. Опечатка в пути не должна стоить диска.
is_jarvis_root() {
  [ -d "$1" ] || return 1
  [ "$(basename "$1")" = "Rujarvis" ] || return 1
  [ -f "$1/src/app/main.ts" ] || [ -d "$1/data" ]
}

# Проверке дальше не нужно: она берёт помощников выше и зовёт их сама.
if [ "${RUJARVIS_INSTALL_TEST:-}" = "1" ]; then
  return 0 2>/dev/null || exit 0
fi

main() {
  printf '\n  Rujarvis — удаление\n'
  [ "$(uname -s)" = "Darwin" ] || die 'Этот скрипт для macOS. На Windows: uninstall.ps1'

  # Скрипт мог быть запущен из папки, которую сейчас удалит.
  cd "$HOME"

  step 'Закрываю Джарвиса'
  if [ -d "$SOURCE_DIR" ] && stop_running_jarvis "$SOURCE_DIR"; then
    ok 'Работающий Джарвис закрыт.'
  else
    ok 'Не был запущен.'
  fi

  step 'Убираю автозапуск и ярлыки'
  if [ -f "$AGENT_PLIST" ]; then
    launchctl bootout "gui/$(id -u)" "$AGENT_PLIST" 2>/dev/null || launchctl unload "$AGENT_PLIST" 2>/dev/null || true
    rm -f "$AGENT_PLIST"
    ok "Убран автозапуск: $AGENT_PLIST"
  fi
  if [ -d "$APP_DIR" ]; then
    rm -rf "$APP_DIR"
    ok "Убрано приложение: $APP_DIR"
  fi
  # Ярлык на Рабочем столе — только наш: ссылка на наше приложение или
  # псевдоним Finder с нашим именем. Чужой файл «Rujarvis» не трогаем.
  if [ -L "$HOME/Desktop/Rujarvis.app" ]; then
    rm -f "$HOME/Desktop/Rujarvis.app"
    ok 'Убран ярлык: ~/Desktop/Rujarvis.app'
  fi
  if [ -f "$HOME/Desktop/Rujarvis" ] && [ "$(mdls -raw -name kMDItemKind "$HOME/Desktop/Rujarvis" 2>/dev/null || true)" = "Alias" ]; then
    rm -f "$HOME/Desktop/Rujarvis"
    ok 'Убран ярлык: ~/Desktop/Rujarvis'
  fi

  step 'Удаляю папку Джарвиса'
  if [ ! -e "$INSTALL_ROOT" ]; then
    ok "Папки нет: $INSTALL_ROOT"
  elif ! is_jarvis_root "$INSTALL_ROOT"; then
    die "Не похоже на папку Джарвиса, не трогаю: $INSTALL_ROOT"
  else
    rm -rf "$INSTALL_ROOT"
    [ ! -e "$INSTALL_ROOT" ] || die "Папка удалилась не целиком: $INSTALL_ROOT"
    ok "Удалена: $INSTALL_ROOT"
  fi

  printf '\n  Готово: Rujarvis удалён.\n\n  Не тронуто:\n'
  for name in 'Джарвис' 'Jarvis'; do
    if [ -d "$HOME/Desktop/$name" ]; then note "$HOME/Desktop/$name — ваши результаты"; fi
  done
  note 'Claude Code и Codex и вход в них — это отдельные программы'
  printf '\n'
}

main "$@"
