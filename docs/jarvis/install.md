# Установка

## Windows 11 — одной командой

```powershell
irm https://raw.githubusercontent.com/aisarus/Rujarvis/main/install.ps1 | iex
```

Скрипт ставится в профиль пользователя, права администратора не нужны. Он
проверяет и доустанавливает Git, Node.js 22, Rust и Bun через winget, включает
pnpm через corepack, клонирует репозиторий в `%LOCALAPPDATA%\Rujarvis\src`,
собирает приложение, скачивает русские модели речи и создаёт ярлык в меню
«Пуск». Повторный запуск обновляет уже установленное.

Параметры:

```powershell
# Своя модель распознавания вместо выбранной по объёму памяти
irm .../install.ps1 | iex -Args @{ WhisperModel = 'small' }

# Только зависимости и модели, без сборки
./install.ps1 -SkipBuild

# Другая ветка или каталог
./install.ps1 -Branch dev -InstallRoot D:\Rujarvis
```

## Сборка из исходников

Требуется Node.js 22, pnpm 9, Bun, Rust stable и Git с поддержкой подмодулей.

```bash
git clone --recurse-submodules https://github.com/aisarus/Rujarvis.git
cd Rujarvis
pnpm install
pnpm run download:oix -- --current-platform
pnpm run download:pdfcpu -- --current-platform
pnpm run build
pnpm run jarvis:setup
pnpm start
```

`pnpm run jarvis:setup` — единственный шаг, которого нет у upstream. Он смотрит
на машину, говорит, что собирается скачать и сколько это весит, ставит модель
распознавания речи и сообщает, какие coding-backend'ы доступны. Посмотреть план
без скачивания:

```bash
pnpm run jarvis:setup:dry-run
```

## Подписочные backend'ы

Необязательны — без них Jarvis работает через встроенный runtime Interpreter,
просто с меньшим выбором для задач по коду.

```bash
claude        # вход в Claude Code штатным способом
codex login   # вход в Codex через ChatGPT
```

Jarvis не хранит ключи, не читает OAuth-токены и не просит вставить секрет.
Он проверяет только: установлен ли CLI, выполнен ли вход, запускается ли он.

## Первый запуск

1. Зажмите **Ctrl + Space** и говорите. Отпустите — задача уйдёт в работу.
2. Или скажите «Джарвис», а после этого — что нужно сделать.
3. «Стоп», «отмена», «пауза», «продолжай» срабатывают мгновенно.

Специальных команд учить не нужно. Говорите обычными словами:

> «закрой это окно»
> «посмотри что на экране и объясни»
> «почини билд в аегисе через Клод Код»
> «а пока открой Телеграм»

## Проверка установщика

```powershell
pwsh -NoProfile -File scripts/check-install-script.ps1
```

Разбирает `install.ps1` и прогоняет тесты его чистых функций. Путь установки при
этом не выполняется, поэтому проверку можно гонять на любой платформе, где есть
`pwsh`.
