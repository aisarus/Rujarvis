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

$nodeMajor = [int](((node --version) -replace '^v', '') -split '\.')[0]
if ($nodeMajor -lt 22) {
    throw "Нужен Node.js 22 или новее, найден $(node --version). Обновите Node.js и повторите."
}
Write-Ok "Node.js $(node --version)"

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
Write-Ok "Исходники: $SourceDir"

Push-Location $SourceDir
try {
    Write-Step 'Ставлю зависимости проекта'
    Invoke-Checked -FilePath 'pnpm' -Arguments @('install') -What 'pnpm install'

    Write-Step 'Скачиваю рантайм Interpreter'
    Invoke-Checked -FilePath 'pnpm' -Arguments @('run', 'download:oix', '--', '--current-platform') -What 'download:oix'
    Invoke-Checked -FilePath 'pnpm' -Arguments @('run', 'download:pdfcpu', '--', '--current-platform') -What 'download:pdfcpu'

    if (-not $SkipBuild) {
        Write-Step 'Собираю приложение (это самая долгая часть)'
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
call pnpm start
"@ | Set-Content -Path $launcher -Encoding ASCII

$startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Rujarvis.lnk'
New-Shortcut -Path $startMenu -Target $launcher -WorkingDirectory $SourceDir
Write-Ok "Ярлык в меню «Пуск»: Rujarvis"

Write-Host ''
Write-Host '  Готово.' -ForegroundColor Green
Write-Host ''
Write-Host '  Запуск:  меню «Пуск» → Rujarvis' -ForegroundColor White
Write-Host "  Или:     cd `"$SourceDir`" ; pnpm start" -ForegroundColor DarkGray
Write-Host ''
Write-Host '  Зажмите Ctrl + Space и говорите. Или скажите «Джарвис».' -ForegroundColor White
Write-Host ''
Write-Host '  Для задач по коду подключите подписку:' -ForegroundColor White
Write-Host '    claude        — вход в Claude Code' -ForegroundColor DarkGray
Write-Host '    codex login   — вход в Codex через ChatGPT' -ForegroundColor DarkGray
Write-Host '  Jarvis не хранит ключи и не читает токены — вход выполняется штатно.' -ForegroundColor DarkGray
Write-Host ''
