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

<#
    Запустить внешнюю программу и проверить КОД ВОЗВРАТА, а не болтовню.

    Та же ловушка 5.1, что у Invoke-Quiet ниже, и здесь она стоила установки
    целиком: при $ErrorActionPreference = 'Stop' любая строка в stderr внешней
    программы становится NativeCommandError и бросается, а код возврата никто
    не смотрит. `git clone` пишет «Cloning into ...» в stderr ВСЕГДА, даже
    когда всё хорошо, — и установка падала на шаге «Получаю исходники» на
    успешном клоне. Нашёл первый живой прогон на Windows, 25.09.2026.

    Вывод не глотаем, в отличие от Invoke-Quiet: человек должен видеть, как
    идёт клон и сборка. Ослабляется только предпочтение, а решает код.
#>
function Invoke-Checked {
    param(
        [Parameter(Mandatory)] [string] $FilePath,
        [Parameter(Mandatory)] [string[]] $Arguments,
        [string] $WorkingDirectory = $PWD.Path,
        [string] $What = 'команда'
    )
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $FilePath @Arguments 2>&1 | ForEach-Object { "$_" }
    }
    finally {
        $ErrorActionPreference = $prev
    }
    if ($LASTEXITCODE -ne 0) {
        throw "Не удалось выполнить: $What (код $LASTEXITCODE)"
    }
}

<#
    Запустить внешнюю программу, не считая её stderr исключением.

    В Windows PowerShell 5.1 перенаправление `2>&1` у внешней программы
    превращает КАЖДУЮ строку stderr в ErrorRecord, а при
    $ErrorActionPreference = 'Stop' первая же такая строка бросает
    NativeCommandError — код возврата при этом никто не смотрит. А в stderr
    пишут все: `npm warn`, `npm notice`, winget, corepack. Установщик падал до
    собственных проверок и до запасных путей.

    Здесь предпочтение временно ослабляется, а итог решает код возврата.
#>
function Invoke-Quiet {
    param(
        [Parameter(Mandatory)] [string] $FilePath,
        [Parameter(Mandatory)] [string[]] $Arguments
    )
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $FilePath @Arguments 2>&1 | Out-Null
        return $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $prev
    }
}

<#
    Подхватить PATH, который правили в другом процессе.

    winget и npm дописывают путь в реестр, а текущее окно PowerShell об этом
    не знает: оно читало PATH при запуске. Без этого только что поставленная
    команда «не найдена», и установщик останавливается на ровном месте.
#>
function Update-SessionPath {
    # Машинный и пользовательский PATH живут в реестре — это только Windows.
    #
    # Проверяем НЕ через $IsWindows: этой переменной нет в Windows PowerShell
    # 5.1, а `Set-StrictMode -Version Latest` выше запрещает читать
    # неопределённые. Именно 5.1 открывается по умолчанию и именно в ней
    # человек запускает установку одной строкой — установщик падал на первом
    # же шаге с «The variable '$IsWindows' cannot be retrieved». Без строгого
    # режима вышло бы не лучше: `-not $null` истинно, функция вышла бы сразу,
    # и PATH не обновился бы вовсе.
    if ($env:OS -ne 'Windows_NT') { return }

    # Дописываем к тому, что уже есть в окне, а не заменяем: в текущем процессе
    # бывают пути, которых в реестре нет. Так делает CI, так делают менеджеры
    # версий - замена молча отняла бы у них node.
    $parts = @(
        $env:Path,
        [Environment]::GetEnvironmentVariable('Path', 'Machine'),
        [Environment]::GetEnvironmentVariable('Path', 'User')
    ) | Where-Object { $_ }

    $seen = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $kept = foreach ($one in (($parts -join ';') -split ';')) {
        if ($one -and $seen.Add($one)) { $one }
    }
    $env:Path = $kept -join ';'
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
    Update-SessionPath

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

    # Ни менеджера версий, ни подходящего Node — обновляем сами тем же winget,
    # которым поставили бы Node с нуля. Просили одну команду, а не инструкцию
    # посреди установки.
    if (Test-Command 'winget') {
        Write-Note "Установлен Node $current, нужен $wantedMajor или новее - обновляю через winget."
        $code = Invoke-Quiet -FilePath 'winget' -Arguments @(
            'upgrade', '--id', 'OpenJS.NodeJS.LTS', '--source', 'winget',
            '--accept-source-agreements', '--accept-package-agreements', '--silent')
        if ($code -ne 0) {
            # Node мог прийти не из winget: тогда upgrade нечего обновлять.
            Invoke-Quiet -FilePath 'winget' -Arguments @(
                'install', '--id', 'OpenJS.NodeJS.LTS', '--source', 'winget',
                '--accept-source-agreements', '--accept-package-agreements',
                '--silent', '--scope', 'user') | Out-Null
        }
        Update-SessionPath

        $afterWinget = ''
        try { $afterWinget = (node --version).Trim() } catch { $afterWinget = '' }
        if ($afterWinget -and [int] (($afterWinget -replace '^v', '') -split '\.')[0] -ge $wantedMajor) {
            Write-Ok "Node.js $afterWinget (через winget)"
            return
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

<#
    Какой pnpm отвечает в этой папке. $null - если его вообще нет.

    Спрашивать версию нужно в папке проекта: pnpm 10 и новее читает
    packageManager из package.json и подменяет себя нужной версией, но только
    когда его зовут внутри проекта.
#>
function Get-PnpmVersion {
    param([string] $Path = '.')

    if (-not (Test-Command 'pnpm')) { return $null }
    try {
        return (Invoke-InDirectory -Path $Path -Script { (pnpm --version).Trim() })
    } catch {
        return $null
    }
}

<#
    Поставить pnpm нужной версии, ничего не требуя от человека.

    Порядок важен. `corepack enable` кладёт свою заглушку рядом с системным
    Node и без прав администратора получает отказ:

        Internal Error: EPERM: operation not permitted,
        open 'C:\Program Files\nodejs\pnpm'

    А установщик запускают обычным пользователем - на то он и одна строка.
    Поэтому сначала npm: он идёт вместе с Node, ставит в папку пользователя и
    прав не просит. Corepack остаётся вторым.
#>
function Install-Pnpm {
    param(
        [Parameter(Mandatory)] [string] $Version,
        [string] $CheckIn = '.'
    )

    $wantedMajor = [int] ($Version -split '\.')[0]

    Write-Note "Ставлю pnpm $Version через npm."
    Invoke-Quiet -FilePath 'npm' -Arguments @('install', '-g', "pnpm@$Version") | Out-Null
    Update-SessionPath
    $after = Get-PnpmVersion -Path $CheckIn
    if ($after -and [int] ($after -split '\.')[0] -eq $wantedMajor) {
        Write-Ok "pnpm $after"
        return
    }

    Write-Note 'npm не справился - пробую corepack.'
    Invoke-Quiet -FilePath 'corepack' -Arguments @('enable') | Out-Null
    Invoke-Quiet -FilePath 'corepack' -Arguments @('prepare', "pnpm@$Version", '--activate') | Out-Null
    Update-SessionPath
    $after = Get-PnpmVersion -Path $CheckIn
    if ($after -and [int] ($after -split '\.')[0] -eq $wantedMajor) {
        Write-Ok "pnpm $after (через corepack)"
        return
    }

    throw @"
Нужен pnpm $Version, а pnpm отвечает «$after».

Ни npm, ни corepack не смогли поставить нужную версию. Выполните вручную и
запустите установщик снова:

    npm install -g pnpm@$Version
    pnpm --version
"@
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
    $current = Get-PnpmVersion -Path $SourceDir

    if ($current -and [int] ($current -split '\.')[0] -eq $wantedMajor) {
        Write-Ok "pnpm $current"
        return
    }

    if ($current) {
        Write-Note "Установлен pnpm $current, нужен $wantedVersion."
    } else {
        Write-Note "pnpm не найден, нужен $wantedVersion."
    }
    Install-Pnpm -Version $wantedVersion -CheckIn $SourceDir
}


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
# Исходников ещё нет, версия из package.json неизвестна - ставим ту, что закреплена
# в проекте. Дальше Assert-PnpmVersion сверится с package.json и поправит.
if (-not (Test-Command 'pnpm')) { Install-Pnpm -Version '9.15.9' }

Write-Step 'Получаю исходники'
if (Test-Path (Join-Path $SourceDir '.git')) {
    Write-Note "Обновляю $SourceDir"
    # Клон делается с `--depth 1 --branch`, а это подразумевает
    # `--single-branch`: обычный `fetch origin <ветка>` не заводит
    # `origin/<ветка>`, и `checkout` падал с «pathspec did not match» — сменить
    # ветку без удаления папки было нельзя. Refspec заводит ссылку явно, а
    # `checkout -B` переводит на неё; отдельный `pull` после этого не нужен.
    Invoke-Checked -FilePath 'git' -Arguments @(
        '-C', $SourceDir, 'fetch', 'origin', "+refs/heads/${Branch}:refs/remotes/origin/${Branch}") -What 'git fetch'
    Invoke-Checked -FilePath 'git' -Arguments @(
        '-C', $SourceDir, 'checkout', '-B', $Branch, "origin/${Branch}") -What 'git checkout'
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

# Ярлык на рабочем столе, как на маке.
#
# Меню «Пуск» человек ищет — рабочий стол он видит. На маке алиас установщик
# кладёт давно, на Windows его просто забыли, и первый живой человек это
# заметил сразу: «ярлык на рабочем столе установщик ещё не создал».
#
# Путь берём у самой Windows, а не из $env:USERPROFILE\Desktop: при
# перенесённой в OneDrive папке или нерусской локали склейка даёт папку,
# которой нет, и ярлык лёг бы в пустоту.
$desktopDir = [Environment]::GetFolderPath('Desktop')
if ($desktopDir -and (Test-Path $desktopDir)) {
    $desktop = Join-Path $desktopDir 'Rujarvis.lnk'
    New-Shortcut -Path $desktop -Target $electron -Arguments "`"$entry`"" -WorkingDirectory $SourceDir -Icon $icon
    Write-Ok "Ярлык на рабочем столе: $desktop"
} else {
    # Не находим — говорим об этом, а не молчим: установка от этого не
    # ломается, но человек должен знать, почему на столе пусто.
    Write-Note 'Папку рабочего стола найти не удалось — ярлык только в меню «Пуск».'
}

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
