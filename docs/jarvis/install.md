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
проверяет и доустанавливает Git, Node.js 22, Rust и Bun через winget, включает
pnpm через corepack, клонирует репозиторий в `%LOCALAPPDATA%\Rujarvis\src`,
собирает приложение, скачивает русские модели речи и создаёт ярлык в меню
«Пуск». Повторный запуск обновляет уже установленное.

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

Требуется Node.js 22, pnpm 9, Bun, Rust stable и Git с поддержкой подмодулей.

```bash
git clone --recurse-submodules -b claude/jarvis-workstation-vk6nx1 https://github.com/aisarus/Rujarvis.git
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

### Чего ещё нет

Голоса. Ни push-to-talk, ни слова «Джарвис», ни трея, ни оверлея — это
следующая работа. Распознавание и синтез речи установлены и проверены
отдельно, но с микрофоном приложения пока не соединены.

## Проверка установщика

```powershell
pwsh -NoProfile -File scripts/check-install-script.ps1
```

Разбирает `install.ps1` и прогоняет тесты его чистых функций. Путь установки при
этом не выполняется, поэтому проверку можно гонять на любой платформе, где есть
`pwsh`.
