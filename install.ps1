<#
.SYNOPSIS
    Установка Rujarvis — голосового ассистента для Windows (русский и английский).

.DESCRIPTION
    Одна команда в PowerShell:

        irm https://raw.githubusercontent.com/aisarus/Rujarvis/main/install.ps1 | iex

    Что делает, по шагам:
      1. ставит недостающее через winget: Git и Node.js 22 (pnpm — через corepack);
      2. скачивает исходники в %LOCALAPPDATA%\Rujarvis\src и собирает приложение;
      3. скачивает модель распознавания речи и голос для выбранного языка,
         а также драйвер окон cua-driver (trycua/cua, MIT; сумма проверяется);
      4. кладёт ярлык «Rujarvis» в меню «Пуск» и запускает приложение.

    Компилятор C++, Rust и прочие инструменты сборки не нужны: распознавание и
    синтез речи работают на WebAssembly, Electron ставится готовым.

    Всё ставится в профиль пользователя — права администратора не нужны.
    Повторный запуск обновляет установленное.

.PARAMETER Language
    Язык по умолчанию: ru или en. Сменить можно в настройках.

.PARAMETER InstallRoot
    Папка Джарвиса. По умолчанию %LOCALAPPDATA%\Rujarvis.

.PARAMETER Branch
    Ветка репозитория. По умолчанию main.

.PARAMETER WhisperModel
    Модель распознавания: tiny, base, small, turbo, medium.
    По умолчанию выбирается по объёму памяти и видеокарте.

.PARAMETER Autostart
    Запускать Rujarvis при входе в Windows.

.PARAMETER NoLaunch
    Не запускать приложение в конце.
#>

[CmdletBinding()]
param(
    [ValidateSet('ru', 'en')]
    [string] $Language = 'ru',
    [string] $InstallRoot = (Join-Path $env:LOCALAPPDATA 'Rujarvis'),
    [string] $Branch = 'main',
    [ValidateSet('tiny', 'base', 'small', 'turbo', 'medium')]
    [string] $WhisperModel,
    [switch] $Autostart,
    [switch] $NoLaunch
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$RepoUrl = 'https://github.com/aisarus/Rujarvis.git'
$SourceDir = Join-Path $InstallRoot 'src'

function Write-Step { param([string] $Message) Write-Host "`n==> $Message" -ForegroundColor Cyan }
function Write-Ok { param([string] $Message) Write-Host "    $Message" -ForegroundColor Green }
function Write-Note { param([string] $Message) Write-Host "    $Message" -ForegroundColor Yellow }

function Test-Command {
    param([string] $Name)
    return [bool] (Get-Command $Name -ErrorAction SilentlyContinue)
}

function Invoke-Checked {
    param(
        [Parameter(Mandatory)] [string] $FilePath,
        [Parameter(Mandatory)] [string[]] $Arguments,
        [string] $WorkingDirectory = $PWD.Path,
        [string] $What = 'команда'
    )
    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Не удалось выполнить: $What (код $LASTEXITCODE)"
    }
}

function Install-WithWinget {
    param(
        [Parameter(Mandatory)] [string] $Id,
        [Parameter(Mandatory)] [string] $Command,
        [Parameter(Mandatory)] [string] $DisplayName
    )

    if (Test-Command $Command) {
        Write-Ok "$DisplayName уже установлен."
        return
    }

    if (-not (Test-Command 'winget')) {
        throw "Нужен $DisplayName, но winget недоступен. Установите $DisplayName вручную и запустите скрипт снова."
    }

    Write-Note "Ставлю $DisplayName…"
    winget install --id $Id --source winget --accept-source-agreements --accept-package-agreements --silent --scope user
    if ($LASTEXITCODE -ne 0) {
        # Пользовательская установка доступна не для всех пакетов.
        winget install --id $Id --source winget --accept-source-agreements --accept-package-agreements --silent
    }

    # winget правит PATH только для новых процессов — обновляем текущий.
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
                [Environment]::GetEnvironmentVariable('Path', 'User')

    if (-not (Test-Command $Command)) {
        throw "$DisplayName установлен, но команда '$Command' не найдена. Перезапустите PowerShell и повторите."
    }
    Write-Ok "$DisplayName готов."
}

<#
    Node version.

    Node нужен только для сборки и скриптов: само приложение работает на
    Node, встроенном в Electron, и нативных модулей не собирает. Поэтому
    достаточно версии не ниже закреплённой в .nvmrc — более новая годится.
    Раньше требовался ровно 22.x ради нативных модулей upstream, и это
    отправляло людей переключать Node через fnm без всякой нужды.
#>
function Assert-NodeVersion {
    param([Parameter(Mandatory)] [string] $SourceDir)

    $nvmrc = Join-Path $SourceDir '.nvmrc'
    if (-not (Test-Path $nvmrc)) { return }

    $wanted = (Get-Content $nvmrc -Raw).Trim()
    $wantedMajor = [int] ($wanted -split '\.')[0]
    $current = (node --version).Trim()
    $currentMajor = [int] (($current -replace '^v', '') -split '\.')[0]

    if ($currentMajor -ge $wantedMajor) {
        Write-Ok "Node.js $current"
        return
    }

    # A version manager can fix this without sending the user away. fnm needs
    # its environment loaded into the current session first — `fnm use` alone
    # changes nothing in a shell that never ran `fnm env`.
    if (Test-Command 'fnm') {
        Write-Note "Установлен Node $current, нужен $wantedMajor или новее — переключаю через fnm."
        try {
            fnm install $wanted 2>&1 | Out-Null
            fnm env --shell power-shell | Out-String | Invoke-Expression
            fnm use $wanted 2>&1 | Out-Null

            $switched = (node --version).Trim()
            if ([int] (($switched -replace '^v', '') -split '\.')[0] -ge $wantedMajor) {
                Write-Ok "Node.js $switched (через fnm)"
                return
            }
        } catch {
            # Fall through to the instructions below.
        }
    }

    throw @"
Нужен Node.js $wantedMajor или новее, а установлен $current.

Проще всего обновить Node:

    winget upgrade OpenJS.NodeJS.LTS

или переключиться через fnm, по одной команде:

    winget install Schniz.fnm
    fnm install $wanted
    fnm env --shell power-shell | Out-String | Invoke-Expression
    fnm use $wanted

Третья строка обязательна: без неё `fnm use` не меняет версию в текущем окне.
Проверьте `node --version` и запустите установщик снова — он продолжит
с этого места.
"@
}

<#
    pnpm version.

    Same trap as Node: checking that pnpm merely exists let a machine with
    pnpm 11 through while package.json pins 9.15.9 and declares ">=9 <10".
    pnpm 11 silently ignores the `pnpm` block in package.json — including
    onlyBuiltDependencies, which lets Electron download its binary — and the
    install diverges from what the lockfile was resolved against.
#>
<#
    Выполнить что-то в другой папке и вернуться, даже если бросило.

    Нужно там, где ответ команды зависит от текущей папки: pnpm 10 и новее
    читает packageManager из package.json проекта и подменяет себя нужной
    версией.
#>
function Invoke-InDirectory {
    param(
        [Parameter(Mandatory)] [string] $Path,
        [Parameter(Mandatory)] [scriptblock] $Script
    )
    Push-Location $Path
    try { & $Script } finally { Pop-Location }
}

function Assert-PnpmVersion {
    param([Parameter(Mandatory)] [string] $SourceDir)

    $packageJson = Join-Path $SourceDir 'package.json'
    if (-not (Test-Path $packageJson)) { return }

    $wanted = (Get-Content $packageJson -Raw | ConvertFrom-Json).packageManager
    if (-not $wanted) { return }

    $wantedVersion = ($wanted -split '@')[-1]
    $wantedMajor = [int] ($wantedVersion -split '\.')[0]

    # Версию спрашиваем В ПАПКЕ ПРОЕКТА, а не в своей.
    #
    # pnpm 10 и новее читает packageManager из package.json и сам запускает
    # нужную версию — но только когда его зовут внутри проекта. Снаружи он
    # отвечает своей. Проверка сравнивала версию проекта с pnpm, запущенным в
    # папке пользователя, и потому не совпадала никогда.
    #
    # Поймано первым живым прогоном на Windows 24.09.2026: один и тот же pnpm
    # отвечает 11.11.0 из домашней папки и 9.15.9 из папки проекта.
    $current = (Invoke-InDirectory -Path $SourceDir -Script { (pnpm --version).Trim() })
    $currentMajor = [int] ($current -split '\.')[0]

    if ($currentMajor -eq $wantedMajor) {
        Write-Ok "pnpm $current"
        return
    }

    Write-Note "Установлен pnpm $current, нужен $wantedVersion — переключаю через corepack."
    corepack enable 2>&1 | Out-Null
    corepack prepare "pnpm@$wantedVersion" --activate 2>&1 | Out-Null

    $switched = (Invoke-InDirectory -Path $SourceDir -Script { (pnpm --version).Trim() })
    if ([int] ($switched -split '\.')[0] -ne $wantedMajor) {
        throw @"
Нужен pnpm $wantedVersion, установлен $switched, и corepack не смог переключить.

Чаще всего corepack упирается в права: свою заглушку он кладёт в папку Node
рядом с системной, и без администратора получает отказ. Тогда проще поставить
нужный pnpm себе, без прав:

    npm install -g pnpm@$wantedVersion
    pnpm --version

Либо, от имени администратора:

    corepack enable
    corepack prepare pnpm@$wantedVersion --activate

Затем запустите установщик снова.
"@
    }
    Write-Ok "pnpm $switched (через corepack)"}


<#
    Перенос данных старой установки.

    До отделения от Interpreter Workstation модели лежали в
    %APPDATA%\Interpreter, а память — в ~\.openinterpreter\jarvis. Скачивать
    гигабайт заново ради смены папки незачем: переносим, если на новом месте
    ещё пусто. Возвращает список перенесённого, чтобы сказать о нём.
#>
function Move-LegacyData {
    param(
        [Parameter(Mandatory)] [string] $InstallRoot,
        [string] $RoamingRoot = (Join-Path $env:APPDATA 'Interpreter'),
        [string] $LegacyHome = (Join-Path $HOME '.openinterpreter\jarvis')
    )

    $moved = @()
    $pairs = @(
        @{ From = (Join-Path $RoamingRoot 'whisper-models'); To = (Join-Path $InstallRoot 'models\whisper') },
        @{ From = (Join-Path $LegacyHome 'memory.json'); To = (Join-Path $InstallRoot 'data\memory.json') },
        @{ From = (Join-Path $LegacyHome 'agent-notes.json'); To = (Join-Path $InstallRoot 'data\agent-notes.json') },
        @{ From = (Join-Path $InstallRoot 'data\jarvis.log'); To = (Join-Path $InstallRoot 'logs\jarvis.log') }
    )
    foreach ($pair in $pairs) {
        if (-not (Test-Path $pair.From) -or (Test-Path $pair.To)) { continue }
        New-Item -ItemType Directory -Path (Split-Path -Parent $pair.To) -Force | Out-Null
        Move-Item -Path $pair.From -Destination $pair.To
        $moved += $pair.To
    }

    # Голоса лежали на уровень глубже: tts-models\<id>\<id>\…
    $legacyVoices = Join-Path $RoamingRoot 'tts-models'
    if (Test-Path $legacyVoices) {
        foreach ($voice in Get-ChildItem -Path $legacyVoices -Directory -Filter 'vits-piper-*') {
            $inner = Join-Path $voice.FullName $voice.Name
            $target = Join-Path $InstallRoot "models\voices\$($voice.Name)"
            if ((Test-Path $inner) -and -not (Test-Path $target)) {
                New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
                Move-Item -Path $inner -Destination $target
                $moved += $target
            }
        }
    }
    return ,$moved
}

<#
    Драйвер окон cua-driver (trycua/cua, MIT) — «глаза и руки» для инструментов
    window_*: дерево доступности Windows и клики по номеру элемента.

    Версия и контрольные суммы закреплены: исполняемый файл из интернета, и
    подменённый архив не должен стать драйвером мыши и клавиатуры. Обновление
    драйвера — это правка здесь, а не «последний релиз».
#>
function Get-CuaDriverAsset {
    param([Parameter(Mandatory)] [string] $Architecture)

    # Версия и суммы — внутри функции: они меняются только вместе.
    $version = '0.28.2'
    $hashes = @{
        'windows-x86_64' = '3C1FCF10FF9513B94E4AF78AD6A216AB62AA95B2C9A3B70DFBDBA9F04E021533'
        'windows-arm64'  = '69720568A44ED8EAB3620C892B9DF524A8231013AC42E0AFCDAA4317CD90D0F1'
    }
    $label = switch ($Architecture.ToUpperInvariant()) {
        'AMD64' { 'windows-x86_64' }
        'X64'   { 'windows-x86_64' }
        'ARM64' { 'windows-arm64' }
        default { $null }
    }
    if (-not $label) { return $null }
    $name = "cua-driver-rs-$version-$label"
    return [pscustomobject]@{
        Version = $version
        Name    = $name
        Url     = "https://github.com/trycua/cua/releases/download/cua-driver-rs-v$version/$name.zip"
        Sha256  = $hashes[$label]
    }
}

function Install-CuaDriver {
    param([Parameter(Mandatory)] [string] $InstallRoot)

    $asset = Get-CuaDriverAsset -Architecture $env:PROCESSOR_ARCHITECTURE
    if (-not $asset) {
        Write-Note "cua-driver не собран для $env:PROCESSOR_ARCHITECTURE — инструменты окон будут выключены."
        return
    }
    $unpacked = Join-Path $InstallRoot 'cua-driver\unpacked'
    $exe = Join-Path $unpacked "$($asset.Name)\cua-driver.exe"
    if (Test-Path $exe) { Write-Ok "cua-driver $($asset.Version) уже на месте."; return }

    # Без драйвера Джарвис работает — окна просто ведутся через снимки экрана.
    # Поэтому сбой здесь — заметка, а не остановка установки.
    $zip = Join-Path ([System.IO.Path]::GetTempPath()) "$($asset.Name).zip"
    try {
        $ProgressPreference = 'SilentlyContinue'
        Invoke-WebRequest -Uri $asset.Url -OutFile $zip -UseBasicParsing
        $hash = (Get-FileHash -Path $zip -Algorithm SHA256).Hash
        if ($hash -ne $asset.Sha256) {
            throw "контрольная сумма не совпала ($hash)"
        }
        if (Test-Path $unpacked) { Remove-Item -Path $unpacked -Recurse -Force }
        New-Item -ItemType Directory -Path $unpacked -Force | Out-Null
        Expand-Archive -Path $zip -DestinationPath $unpacked -Force
        if (-not (Test-Path $exe)) { throw "в архиве нет $($asset.Name)\cua-driver.exe" }
        Write-Ok "cua-driver $($asset.Version): $exe"
    } catch {
        Write-Note "cua-driver не установлен: $($_.Exception.Message). Инструменты окон будут выключены."
    } finally {
        Remove-Item -Path $zip -Force -ErrorAction SilentlyContinue
    }
}

function New-Shortcut {
    param(
        [Parameter(Mandatory)] [string] $Path,
        [Parameter(Mandatory)] [string] $Target,
        [string] $Arguments = '',
        [string] $WorkingDirectory = '',
        [string] $Icon = ''
    )
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($Path)
    $shortcut.TargetPath = $Target
    $shortcut.Arguments = $Arguments
    if ($WorkingDirectory) { $shortcut.WorkingDirectory = $WorkingDirectory }
    if ($Icon) { $shortcut.IconLocation = $Icon }
    $shortcut.Description = 'Rujarvis — голосовой ассистент / voice assistant'
    $shortcut.Save()
}


# ---------------------------------------------------------------------------

Write-Host ''
Write-Host '  Rujarvis' -ForegroundColor White
Write-Host '  Голосовой ассистент для Windows · Voice assistant for Windows' -ForegroundColor DarkGray
Write-Host ''

if ($env:OS -ne 'Windows_NT') {
    throw 'Этот установщик рассчитан на Windows. На macOS и Linux соберите из исходников: см. docs/jarvis/install.md.'
}

Write-Step 'Проверяю зависимости'
Install-WithWinget -Id 'Git.Git' -Command 'git' -DisplayName 'Git'
Install-WithWinget -Id 'OpenJS.NodeJS.LTS' -Command 'node' -DisplayName 'Node.js'
if (-not (Test-Command 'pnpm')) {
    Write-Note 'Включаю pnpm через corepack…'
    corepack enable | Out-Null
    corepack prepare pnpm@9.15.9 --activate | Out-Null
}

Write-Step 'Получаю исходники'
if (Test-Path (Join-Path $SourceDir '.git')) {
    Write-Note "Обновляю $SourceDir"
    Invoke-Checked -FilePath 'git' -Arguments @('-C', $SourceDir, 'fetch', 'origin', $Branch) -What 'git fetch'
    Invoke-Checked -FilePath 'git' -Arguments @('-C', $SourceDir, 'checkout', $Branch) -What 'git checkout'
    Invoke-Checked -FilePath 'git' -Arguments @('-C', $SourceDir, 'pull', '--ff-only', 'origin', $Branch) -What 'git pull'
} else {
    New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null
    Invoke-Checked -FilePath 'git' -Arguments @('clone', '--depth', '1', '--branch', $Branch, $RepoUrl, $SourceDir) -What 'git clone'
}
if (-not (Test-Path (Join-Path $SourceDir 'app/main.ts'))) {
    throw "В ветке '$Branch' нет приложения Rujarvis (app/main.ts). Укажите нужную ветку через -Branch."
}
Write-Ok "Исходники: $SourceDir"

Assert-NodeVersion -SourceDir $SourceDir
Assert-PnpmVersion -SourceDir $SourceDir

$moved = Move-LegacyData -InstallRoot $InstallRoot
if ($moved.Count -gt 0) {
    Write-Step 'Перенёс данные прежней установки'
    $moved | ForEach-Object { Write-Ok $_ }
}

Push-Location $SourceDir
try {
    Write-Step 'Ставлю зависимости и собираю'
    Invoke-Checked -FilePath 'pnpm' -Arguments @('install', '--frozen-lockfile') -What 'pnpm install'
    Invoke-Checked -FilePath 'pnpm' -Arguments @('build') -What 'pnpm build'
    Write-Ok 'Приложение собрано.'

    Write-Step 'Скачиваю модели речи'
    $setupArgs = @('jarvis:setup', '--', '--language', $Language)
    if ($WhisperModel) { $setupArgs += @('--model', $WhisperModel) }
    Invoke-Checked -FilePath 'pnpm' -Arguments $setupArgs -What 'jarvis:setup'
}
finally {
    Pop-Location
}

Write-Step 'Ставлю драйвер окон'
Install-CuaDriver -InstallRoot $InstallRoot

Write-Step 'Создаю ярлык'
$electron = Join-Path $SourceDir 'node_modules\electron\dist\electron.exe'
$entry = Join-Path $SourceDir 'dist\app\main.cjs'
$icon = Join-Path $SourceDir 'resources\icon.ico'
if (-not (Test-Path $electron)) { throw "Electron не найден: $electron. Запустите установщик снова." }

$startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Rujarvis.lnk'
New-Shortcut -Path $startMenu -Target $electron -Arguments "`"$entry`"" -WorkingDirectory $SourceDir -Icon $icon
Write-Ok 'Ярлык в меню «Пуск»: Rujarvis'

$startup = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup\Rujarvis.lnk'
if ($Autostart) {
    New-Shortcut -Path $startup -Target $electron -Arguments "`"$entry`"" -WorkingDirectory $SourceDir -Icon $icon
    Write-Ok 'Запуск при входе в Windows включён.'
}

Write-Host ''
Write-Host '  Готово.' -ForegroundColor Green
Write-Host ''
Write-Host '  Rujarvis живёт в трее. При первом запуске он проведёт по настройке:' -ForegroundColor White
Write-Host '  вход в Claude Code, проверка микрофона — и можно говорить.' -ForegroundColor White
Write-Host ''
Write-Host "  Папка Джарвиса: $InstallRoot" -ForegroundColor DarkGray
Write-Host "  Лог:            $(Join-Path $InstallRoot 'logs\jarvis.log')" -ForegroundColor DarkGray
Write-Host ''

if (-not $NoLaunch) {
    Start-Process -FilePath $electron -ArgumentList "`"$entry`"" -WorkingDirectory $SourceDir
}
