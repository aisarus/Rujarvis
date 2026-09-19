<#
.SYNOPSIS
    Установка Rujarvis — русскоязычного голосового ассистента на базе
    Interpreter Workstation.

.DESCRIPTION
    Одна команда в PowerShell:

        irm https://raw.githubusercontent.com/aisarus/Rujarvis/main/install.ps1 | iex

    Скрипт проверяет и доустанавливает зависимости через winget, собирает
    приложение из исходников, скачивает русские модели речи и создаёт ярлык.

    Всё ставится в пользовательский профиль — права администратора не нужны.
    Скрипт можно запускать повторно: он обновляет уже установленное.

.PARAMETER InstallRoot
    Куда положить исходники. По умолчанию %LOCALAPPDATA%\Rujarvis.

.PARAMETER Branch
    Ветка репозитория. По умолчанию main.

.PARAMETER WhisperModel
    Модель распознавания речи: tiny, base, small, turbo, medium.
    По умолчанию выбирается по объёму оперативной памяти.

.PARAMETER SkipBuild
    Только зависимости и модели, без сборки приложения.
#>

[CmdletBinding()]
param(
    [string] $InstallRoot = (Join-Path $env:LOCALAPPDATA 'Rujarvis'),
    [string] $Branch = 'main',
    [ValidateSet('tiny', 'base', 'small', 'turbo', 'medium')]
    [string] $WhisperModel,
    [switch] $SkipBuild
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

function Get-RecommendedWhisperModel {
    $ramBytes = (Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory
    $ramGb = [math]::Round($ramBytes / 1GB)
    if ($ramGb -ge 16) { return 'small' }
    if ($ramGb -ge 8) { return 'base' }
    return 'tiny'
}

function Get-VsWherePath {
    # Join-Path throws on a null root, and these variables are simply absent
    # off Windows — a detector must answer "no", not take the installer down.
    $roots = @(${env:ProgramFiles(x86)}, $env:ProgramFiles) |
        Where-Object { $_ -and $_.Trim() }

    foreach ($root in $roots) {
        $candidate = Join-Path $root 'Microsoft Visual Studio\Installer\vswhere.exe'
        if (Test-Path $candidate) { return $candidate }
    }
    return $null
}

<#
    The project compiles native Node addons on Windows (interpreter-window-pin,
    node-pty, uiohook-napi), so node-gyp needs a real MSVC toolchain. It is not
    on PATH, so Get-Command cannot find it — vswhere is the supported way to
    ask whether the C++ workload is present.
#>
function Test-VisualStudioBuildTools {
    $vswhere = Get-VsWherePath
    if (-not $vswhere) { return $false }

    try {
        $found = & $vswhere -products * `
            -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
            -property installationPath 2>$null
    } catch {
        return $false
    }
    return [bool] ($found -and ($found | Out-String).Trim())
}

function Install-VisualStudioBuildTools {
    if (Test-VisualStudioBuildTools) {
        Write-Ok 'Компилятор C++ (MSVC) уже установлен.'
        return
    }

    if (-not (Test-Command 'winget')) {
        throw 'Нужны Visual Studio Build Tools с рабочей нагрузкой "Разработка классических приложений на C++", но winget недоступен. Установите их вручную: https://visualstudio.microsoft.com/visual-cpp-build-tools/'
    }

    Write-Note 'Ставлю Visual Studio Build Tools (C++). Это несколько гигабайт и самый долгий шаг.'
    winget install --id Microsoft.VisualStudio.2022.BuildTools --source winget `
        --accept-source-agreements --accept-package-agreements `
        --override '--quiet --wait --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended'

    if (-not (Test-VisualStudioBuildTools)) {
        throw @'
Visual Studio Build Tools установлены, но рабочая нагрузка C++ не найдена.
Откройте Visual Studio Installer, нажмите «Изменить» и отметьте
«Разработка классических приложений на C++», затем запустите установщик снова.
'@
    }
    Write-Ok 'Компилятор C++ готов.'
}

<#
    Node version.

    The repository pins an exact version in .nvmrc and package.json declares
    ">=22 <23". Checking only the lower bound let a machine with Node 24 through,
    and the failure surfaced much later as a native build error — so the check
    is a range, and it reads the requirement from the checkout instead of
    hardcoding it.
#>
function Assert-NodeVersion {
    param([Parameter(Mandatory)] [string] $SourceDir)

    $nvmrc = Join-Path $SourceDir '.nvmrc'
    if (-not (Test-Path $nvmrc)) { return }

    $wanted = (Get-Content $nvmrc -Raw).Trim()
    $wantedMajor = [int] ($wanted -split '\.')[0]
    $current = (node --version).Trim()
    $currentMajor = [int] (($current -replace '^v', '') -split '\.')[0]

    if ($currentMajor -eq $wantedMajor) {
        Write-Ok "Node.js $current"
        return
    }

    # A version manager can fix this without sending the user away. fnm needs
    # its environment loaded into the current session first — `fnm use` alone
    # changes nothing in a shell that never ran `fnm env`.
    if (Test-Command 'fnm') {
        Write-Note "Установлен Node $current, нужен $wantedMajor.x — переключаю через fnm."
        try {
            fnm install $wanted 2>&1 | Out-Null
            fnm env --shell power-shell | Out-String | Invoke-Expression
            fnm use $wanted 2>&1 | Out-Null

            $switched = (node --version).Trim()
            if ([int] (($switched -replace '^v', '') -split '\.')[0] -eq $wantedMajor) {
                Write-Ok "Node.js $switched (через fnm)"
                return
            }
        } catch {
            # Fall through to the instructions below.
        }
    }

    throw @"
Нужен Node.js $wantedMajor.x (проект закрепляет $wanted), а установлен $current.
Нативные модули не соберутся под другой мажорной версией.

Выполните по одной команде:

    winget install Schniz.fnm
    fnm install $wanted
    fnm env --shell power-shell | Out-String | Invoke-Expression
    fnm use $wanted

Третья строка обязательна: без неё `fnm use` не меняет версию в текущем окне.
Проверьте `node --version` и запустите установщик снова — он продолжит
с этого места.
"@
}

function Get-PinnedBunVersion {
    # Версия Bun закреплена в CI, а не здесь: так требование живёт в одном
    # месте и не расходится с тем, что проект действительно проверяет.
    param([Parameter(Mandatory)] [string] $SourceDir)

    $workflow = Join-Path $SourceDir '.github/workflows/ci.yml'
    if (-not (Test-Path $workflow)) { return $null }

    $match = [regex]::Match((Get-Content $workflow -Raw), 'bun-version:\s*([0-9]+\.[0-9]+\.[0-9]+)')
    if (-not $match.Success) { return $null }
    return $match.Groups[1].Value
}

function Get-BunVersionProblem {
    # Чистая функция: решает, годится ли версия, и ничего не делает с машиной.
    # Возвращает $null, когда всё в порядке, иначе — готовое сообщение.
    param(
        [Parameter(Mandatory)] [string] $SourceDir,
        [Parameter(Mandatory)] [string] $CurrentVersion
    )

    $wanted = Get-PinnedBunVersion -SourceDir $SourceDir
    if (-not $wanted) { return $null }

    $wantedLine = ($wanted -split '\.')[0..1] -join '.'
    $currentLine = ($CurrentVersion.Trim() -split '\.')[0..1] -join '.'
    if ($currentLine -eq $wantedLine) { return $null }

    return @"
Нужен Bun линии $wantedLine (CI закрепляет $wanted), а установлен $CurrentVersion.
Начиная с 1.3 Bun отказывается запускать pnpm.cmd без shell: true, и сборка
подмодуля interpreter-extension падает с ошибкой EINVAL.

Выполните:

    winget install --id Oven-sh.Bun --version $wanted --force

Если этой версии нет в winget, подойдёт любая из линии ${wantedLine}:

    winget show Oven-sh.Bun --versions
"@
}

function Assert-BunVersion {
    param([Parameter(Mandatory)] [string] $SourceDir)

    $wanted = Get-PinnedBunVersion -SourceDir $SourceDir
    if (-not $wanted) { return }

    $current = (bun --version).Trim()
    if (-not (Get-BunVersionProblem -SourceDir $SourceDir -CurrentVersion $current)) {
        Write-Ok "Bun $current"
        return
    }

    # winget чаще всего может это починить сам, не отправляя человека читать
    # инструкцию. Точной версии из CI в каталоге может не быть, поэтому берём
    # самую свежую из нужной линии.
    if (Test-Command 'winget') {
        $wantedLine = ($wanted -split '\.')[0..1] -join '.'
        Write-Note "Установлен Bun $current, нужна линия $wantedLine — ставлю через winget."

        $candidates = @($wanted)
        $available = winget show Oven-sh.Bun --versions 2>$null |
            Where-Object { $_ -match "^$([regex]::Escape($wantedLine))\." } |
            ForEach-Object { $_.Trim() }
        if ($available) { $candidates += $available }

        foreach ($candidate in ($candidates | Select-Object -Unique)) {
            winget install --id Oven-sh.Bun --version $candidate --source winget `
                --accept-source-agreements --accept-package-agreements --silent --scope user --force 2>&1 | Out-Null

            $switched = (bun --version).Trim()
            if (-not (Get-BunVersionProblem -SourceDir $SourceDir -CurrentVersion $switched)) {
                Write-Ok "Bun $switched"
                return
            }
        }
    }

    throw (Get-BunVersionProblem -SourceDir $SourceDir -CurrentVersion $current)
}

function Get-GitUnixToolsDir {
    # Скрипты сборки подмодуля interpreter-extension написаны под Unix и зовут
    # `rm`. pnpm на Windows запускает их через cmd.exe, где `rm` нет, — сборка
    # падает с кодом 127. Git для Windows приносит эти утилиты с собой.
    $git = Get-Command git -ErrorAction SilentlyContinue
    if (-not $git) { return $null }

    $root = Split-Path -Parent (Split-Path -Parent $git.Source)
    if (-not $root) { return $null }

    $candidate = Join-Path $root 'usr\bin'
    if (Test-Path (Join-Path $candidate 'rm.exe')) { return $candidate }
    return $null
}

function Add-GitUnixToolsToPath {
    $tools = Get-GitUnixToolsDir
    if (-not $tools) {
        Write-Note 'Unix-утилиты Git не найдены — сборка подмодуля может упасть на `rm`.'
        return
    }
    if (($env:Path -split ';') -contains $tools) { return }

    # Только в КОНЕЦ PATH. В начале этот каталог перекрыл бы системный tar.exe
    # версией из MSYS, которая принимает пути вида C:\... за имя удалённого
    # хоста и роняет распаковку рантайма.
    $env:Path = $env:Path.TrimEnd(';') + ';' + $tools
}

function New-Shortcut {
    param(
        [Parameter(Mandatory)] [string] $Path,
        [Parameter(Mandatory)] [string] $Target,
        [string] $Arguments = '',
        [string] $WorkingDirectory = ''
    )
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($Path)
    $shortcut.TargetPath = $Target
    $shortcut.Arguments = $Arguments
    if ($WorkingDirectory) { $shortcut.WorkingDirectory = $WorkingDirectory }
    $shortcut.Description = 'Rujarvis — голосовой ассистент'
    $shortcut.Save()
}

# ---------------------------------------------------------------------------

Write-Host ''
Write-Host '  Rujarvis' -ForegroundColor White
Write-Host '  Русскоязычный голосовой ассистент для Windows' -ForegroundColor DarkGray
Write-Host ''

if ($env:OS -ne 'Windows_NT') {
    throw 'Этот установщик рассчитан на Windows. На macOS и Linux соберите из исходников: см. docs/jarvis/install.md.'
}

Write-Step 'Проверяю зависимости'
Install-WithWinget -Id 'Git.Git'        -Command 'git'   -DisplayName 'Git'
Install-WithWinget -Id 'OpenJS.NodeJS.LTS' -Command 'node' -DisplayName 'Node.js'
Install-WithWinget -Id 'Rustlang.Rustup' -Command 'cargo' -DisplayName 'Rust'
Install-WithWinget -Id 'Oven-sh.Bun'    -Command 'bun'   -DisplayName 'Bun'
Install-VisualStudioBuildTools

# The exact Node version is checked after the clone, against the .nvmrc the
# repository pins, rather than guessed here.

if (-not (Test-Command 'pnpm')) {
    Write-Note 'Включаю pnpm через corepack…'
    corepack enable | Out-Null
    corepack prepare pnpm@9.15.9 --activate | Out-Null
}
Write-Ok "pnpm $(pnpm --version)"

Write-Step 'Получаю исходники'
if (Test-Path (Join-Path $SourceDir '.git')) {
    Write-Note "Обновляю $SourceDir"
    Invoke-Checked -FilePath 'git' -Arguments @('-C', $SourceDir, 'fetch', 'origin', $Branch) -What 'git fetch'
    Invoke-Checked -FilePath 'git' -Arguments @('-C', $SourceDir, 'checkout', $Branch) -What 'git checkout'
    Invoke-Checked -FilePath 'git' -Arguments @('-C', $SourceDir, 'pull', '--ff-only', 'origin', $Branch) -What 'git pull'
    Invoke-Checked -FilePath 'git' -Arguments @('-C', $SourceDir, 'submodule', 'update', '--init', '--recursive') -What 'git submodule update'
} else {
    New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null
    Invoke-Checked -FilePath 'git' -Arguments @('clone', '--recurse-submodules', '--branch', $Branch, $RepoUrl, $SourceDir) -What 'git clone'
}
# The Jarvis layer lives in jarvis/. If it is missing, the branch that was
# cloned does not carry this work — installing on regardless would produce a
# plain Workstation that looks like a broken Jarvis.
if (-not (Test-Path (Join-Path $SourceDir 'jarvis/core.ts'))) {
    throw "В ветке '$Branch' нет слоя Jarvis (каталог jarvis/). Укажите ветку с этим кодом через -Branch."
}
Write-Ok "Исходники: $SourceDir"

Assert-NodeVersion -SourceDir $SourceDir
Assert-BunVersion -SourceDir $SourceDir

Push-Location $SourceDir
try {
    Write-Step 'Ставлю зависимости проекта'
    Invoke-Checked -FilePath 'pnpm' -Arguments @('install') -What 'pnpm install'

    Write-Step 'Скачиваю рантайм Interpreter'
    Invoke-Checked -FilePath 'pnpm' -Arguments @('run', 'download:oix', '--', '--current-platform') -What 'download:oix'
    Invoke-Checked -FilePath 'pnpm' -Arguments @('run', 'download:pdfcpu', '--', '--current-platform') -What 'download:pdfcpu'

    if (-not $SkipBuild) {
        Write-Step 'Собираю приложение (это самая долгая часть)'
        Add-GitUnixToolsToPath
        Invoke-Checked -FilePath 'pnpm' -Arguments @('run', 'build') -What 'pnpm run build'
        Write-Ok 'Сборка готова.'
    }

    Write-Step 'Настраиваю голос'
    if (-not $WhisperModel) {
        $WhisperModel = Get-RecommendedWhisperModel
        Write-Note "Модель распознавания выбрана по объёму памяти: $WhisperModel"
    }
    Invoke-Checked -FilePath 'pnpm' -Arguments @('run', 'jarvis:setup', '--', '--model', $WhisperModel) -What 'jarvis:setup'
}
finally {
    Pop-Location
}

Write-Step 'Создаю ярлык'
$launcher = Join-Path $InstallRoot 'Rujarvis.cmd'
@"
@echo off
cd /d "$SourceDir"
rem Без этой переменной распакованный Electron идёт за интерфейсом на
rem localhost:5173, то есть на dev-сервер Vite, которого у пользователя нет,
rem и приложение закрывается с ERR_CONNECTION_REFUSED.
set INTERPRETER_USE_BUILT_RENDERER=true
call pnpm start
"@ | Set-Content -Path $launcher -Encoding ASCII

$startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Rujarvis.lnk'
New-Shortcut -Path $startMenu -Target $launcher -WorkingDirectory $SourceDir
Write-Ok "Ярлык в меню «Пуск»: Rujarvis"

Write-Host ''
Write-Host '  Готово.' -ForegroundColor Green
Write-Host ''
Write-Host '  Запуск:  меню «Пуск» → Rujarvis' -ForegroundColor White
Write-Host "  Или:     cd `"$SourceDir`" ; `$env:INTERPRETER_USE_BUILT_RENDERER='true' ; pnpm start" -ForegroundColor DarkGray
Write-Host ''
Write-Host '  Зажмите Ctrl + Space и говорите. Или скажите «Джарвис».' -ForegroundColor White
Write-Host ''
Write-Host '  Для задач по коду подключите подписку:' -ForegroundColor White
Write-Host '    claude        — вход в Claude Code' -ForegroundColor DarkGray
Write-Host '    codex login   — вход в Codex через ChatGPT' -ForegroundColor DarkGray
Write-Host '  Jarvis не хранит ключи и не читает токены — вход выполняется штатно.' -ForegroundColor DarkGray
Write-Host ''
