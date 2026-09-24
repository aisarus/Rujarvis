# Установка

## Windows 11 — одной командой

Пока эта работа живёт в ветке `claude/jarvis-workstation-vk6nx1`, а не в `main`, поэтому и ссылка, и
ветка указываются явно:

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/aisarus/Rujarvis/claude/jarvis-workstation-vk6nx1/install.ps1))) -Branch claude/jarvis-workstation-vk6nx1
```

После слияния в `main` команда станет короче:

```powershell
irm https://raw.githubusercontent.com/aisarus/Rujarvis/main/install.ps1 | iex
```

Скрипт ставится в профиль пользователя, права администратора не нужны. Он
проверяет и доустанавливает Git, Node.js, Rust, Bun и Visual Studio Build
Tools через winget, включает pnpm через corepack, клонирует репозиторий в
`%LOCALAPPDATA%\Rujarvis\src`, собирает приложение, скачивает русские модели
речи и создаёт ярлык в меню «Пуск». Повторный запуск продолжает с того места,
где остановился.

### Что нужно машине

- **Node.js ровно 22.x** — версия закреплена в `.nvmrc`. Под другой мажорной
  версией нативные модули не собираются. Если стоит другая, установщик скажет
  об этом и подскажет, как переключиться через `fnm`.
- **Visual Studio Build Tools с нагрузкой C++** — проект компилирует нативные
  аддоны (`interpreter-window-pin`, `node-pty`, `uiohook-napi`). Это самый
  долгий шаг установки, несколько гигабайт.

Обе проверки делаются до тяжёлых шагов, чтобы не выяснять это через двадцать
минут сборки.

После клонирования он проверяет, что в ветке действительно есть каталог
`jarvis/`, и останавливается с понятной ошибкой, если её там нет — иначе
установилась бы обычная Workstation, которая выглядела бы как сломанный Jarvis.

### Параметры

`irm ... | iex` параметры принимать не умеет — их можно передать только через
scriptblock:

```powershell
$installer = [scriptblock]::Create((irm https://raw.githubusercontent.com/aisarus/Rujarvis/claude/jarvis-workstation-vk6nx1/install.ps1))

# Своя модель распознавания вместо выбранной по объёму памяти
& $installer -Branch claude/jarvis-workstation-vk6nx1 -WhisperModel small

# Только зависимости и модели, без сборки
& $installer -Branch claude/jarvis-workstation-vk6nx1 -SkipBuild

# Другой каталог установки
& $installer -Branch claude/jarvis-workstation-vk6nx1 -InstallRoot D:\Rujarvis
```

Либо скачать файл и запустить обычным способом:

```powershell
irm https://raw.githubusercontent.com/aisarus/Rujarvis/claude/jarvis-workstation-vk6nx1/install.ps1 -OutFile install.ps1
./install.ps1 -Branch claude/jarvis-workstation-vk6nx1 -WhisperModel small
```

## Сборка из исходников

Требуется Node.js 22, pnpm 9, **Bun линии 1.2**, Rust stable и Git с поддержкой
подмодулей.

```bash
git clone --recurse-submodules -b claude/jarvis-workstation-vk6nx1 https://github.com/aisarus/Rujarvis.git
cd Rujarvis
pnpm install
pnpm run download:oix -- --current-platform
pnpm run download:pdfcpu -- --current-platform
pnpm run build
pnpm run jarvis:setup
INTERPRETER_USE_BUILT_RENDERER=true pnpm start
```

Две вещи, на которых спотыкается сборка под Windows — обе проверены живым
прогоном, и установщик их обходит сам:

- **Bun должен быть линии 1.2** (CI закрепляет 1.2.20). Начиная с 1.3 Bun
  отказывается запускать `pnpm.cmd` без `shell: true`, и сборка подмодуля
  `interpreter-extension` падает с `EINVAL`. `winget install Oven-sh.Bun` без
  указания версии приносит последнюю — то есть заведомо неподходящую.
- **`C:\Program Files\Git\usr\bin` должен быть в PATH.** Скрипты сборки того же
  подмодуля написаны под Unix и зовут `rm`, а pnpm на Windows запускает их через
  `cmd.exe`. На образах GitHub Actions этот каталог в PATH лежит, поэтому CI
  собирается, а чистая машина — нет. Добавлять его надо в конец PATH: в начале
  он перекроет системный `tar.exe` версией из MSYS, которая принимает `C:\...`
  за имя удалённого хоста.

`INTERPRETER_USE_BUILT_RENDERER=true` обязательна при запуске из исходников без
dev-сервера: без неё распакованный Electron идёт за интерфейсом на
`localhost:5173` и закрывается с `ERR_CONNECTION_REFUSED`. В PowerShell это
`$env:INTERPRETER_USE_BUILT_RENDERER='true'` отдельной командой перед `pnpm start`.

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

## Что уже можно попробовать

Голосовой ввод в приложении пока **не подключён** — горячей клавиши, трея и
оверлея ещё нет. Но весь слой под ними готов, и его можно гонять с клавиатуры:

```bash
pnpm run jarvis:try
```

Открывается диалог, куда пишешь обычной русской речью. Работает всё, кроме
самого микрофона: маршрутизация, разбор ограничений, политика риска, память,
задачи, backend-ы и короткий «устный» ответ.

```
> Закрой это окно
> Посмотри что сейчас на экране и объясни
> Скажи что делает файл jarvis/risk/policy.ts. Ничего не меняй.
> Почини билд через Клод Код
```

Только разобрать реплику, ничего не выполняя:

```bash
pnpm run jarvis:try -- --dry "посмотри в аегисе почему билд отъебнулся, только не ломай ничего"
```

Покажет, какие capabilities распознаны, какой backend выбран, какой класс
риска и какие права выведены из фразы.

Одна реплика без диалога:

```bash
pnpm run jarvis:try -- "открой хром"
pnpm run jarvis:try -- --workspace D:\Projects\aegis "почему не собирается"
```

### Раздел AI-аккаунтов

В собранном приложении: **Settings → Models → AI-аккаунты**. Показывает,
установлены ли Claude Code и Codex, выполнен ли вход и готовы ли они к работе.

## Настройка через переменные окружения

| Переменная | Что делает |
| --- | --- |
| `JARVIS_VOICE` | `on` — включить голосовой слой вне Windows (там он экспериментальный: драйвер рабочего стола работает только на Windows); `off` — выключить везде. По умолчанию голос включён только на Windows. |
| `JARVIS_DATA_ROOT` | Папка данных: журнал, план, ящик правок, лог. По умолчанию `%LOCALAPPDATA%\Rujarvis\data`. |
| `JARVIS_OUTPUT_DIR` | Куда агент кладёт результаты. По умолчанию папка «Джарвис» на рабочем столе. |
| `JARVIS_DESKTOP_MCP` | Свой пусковой файл MCP-сервера рабочего стола вместо собранного `dist-electron/jarvis/desktop/mcp.cjs`. |

Хук красных линий запускается через `node` из `PATH` — тот же Node, на
котором собрано приложение. Если `node` не найден, в логе будет строка
«красные линии только на фразах», и агент работает без оболочки.

## Что остаётся на диске

В `%LOCALAPPDATA%\Rujarvis\data`: журнал действий (`journal.json`), план
текущей работы, ящик правок, разбор прогонов (`runs/`), «характер» — ваши
постоянные указания агенту (`характер.md`) — и лог `jarvis.log`. В лог
попадают команды, обращённые к Джарвису, и пути файлов, которые трогал
агент. Диктовка и речь, обращённая не к нему, в лог не пишутся — только их
длина. Прежде чем приложить лог к issue, прочитайте его.

## Проверка установщика

```powershell
pwsh -NoProfile -File scripts/check-install-script.ps1
```

Разбирает `install.ps1` и прогоняет тесты его чистых функций. Путь установки при
этом не выполняется, поэтому проверку можно гонять на любой платформе, где есть
`pwsh`.
