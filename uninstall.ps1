<#
.SYNOPSIS
    Удаляет Rujarvis с этого компьютера.

.DESCRIPTION
    Закрывает работающий Джарвис этой установки (по точному пути его
    electron.exe, чужие программы не трогает), убирает ярлыки — меню «Пуск»,
    рабочий стол, автозапуск — и папку установки целиком: приложение, модели
    речи, настройки, память, журнал, профиль браузера.

    НЕ трогает:
      - папку результатов на рабочем столе («Джарвис» / «Jarvis») — это
        сделанная работа человека;
      - вход в Claude Code и Codex (~\.claude, ~\.codex) — это чужие
        программы, и человек ставил их не для нас.

    26.09.2026 владелец удалял Джарвиса руками, и это заняло несколько попыток.

.PARAMETER InstallRoot
    Папка установки. По умолчанию %LOCALAPPDATA%\Rujarvis. Удаляется только
    папка с именем Rujarvis, в которой правда лежит Джарвис.
#>
param(
    [string] $InstallRoot = (Join-Path $env:LOCALAPPDATA 'Rujarvis')
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$SourceDir = Join-Path $InstallRoot 'src'

function Write-Step { param([string] $Message) Write-Host "`n==> $Message" -ForegroundColor Cyan }
function Write-Ok { param([string] $Message) Write-Host "    $Message" -ForegroundColor Green }
function Write-Note { param([string] $Message) Write-Host "    $Message" -ForegroundColor Yellow }

# Копия из install.ps1: оба скрипта скачиваются и запускаются поодиночке, и
# общего файла рядом может не быть. check-install-script.ps1 сверяет, что
# копии совпадают слово в слово.
function Get-OwnJarvisProcesses {
    # Процессы именно этой установки: по точному пути её electron.exe, а не по
    # имени. Chrome, Claude, VS Code и Discord тоже electron-подобны, и уборка
    # по маске однажды уже снесла человеку проводник.
    param([Parameter(Mandatory)] [string] $SourceDir)
    $electron = Join-Path $SourceDir 'node_modules\electron\dist\electron.exe'
    @(Get-CimInstance Win32_Process -Filter "Name = 'electron.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.ExecutablePath -and ($_.ExecutablePath -ieq $electron) })
}

function Stop-RunningJarvis {
    <#
    Закрыть Джарвиса этой установки, если он запущен.

    Запущенный держит свой electron.exe, и обновление Electron падало бы на
    `pnpm install`. А если файлы и заменились, старый процесс продолжал
    работать старым кодом: запуск в конце установки упирается в одиночный
    экземпляр и тихо выходит — человек думает, что обновился.

    Гасим каждый свой процесс вместе с детьми: с главным уходят его
    MCP-серверы и живые сессии агента, иначе они остались бы сиротами.
    Возвращает, был ли он запущен.
    #>
    param([Parameter(Mandatory)] [string] $SourceDir)
    $own = @(Get-OwnJarvisProcesses -SourceDir $SourceDir)
    if ($own.Count -eq 0) { return $false }

    $all = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
    $ids = @($own | ForEach-Object { $_.ProcessId })
    # Главные — те, чей родитель не из этого же списка: остальные уйдут с ними.
    $roots = @($own | Where-Object { $ids -notcontains $_.ParentProcessId })
    foreach ($root in $roots) {
        Write-Note "Закрываю работающий Джарвис (pid $($root.ProcessId)): иначе он держит файлы и остаётся на старом коде."
        $tree = New-Object System.Collections.Generic.List[int]
        $queue = New-Object System.Collections.Generic.Queue[int]
        $queue.Enqueue([int] $root.ProcessId)
        while ($queue.Count -gt 0) {
            $id = $queue.Dequeue()
            $tree.Add($id)
            foreach ($child in @($all | Where-Object { $_.ParentProcessId -eq $id })) {
                $queue.Enqueue([int] $child.ProcessId)
            }
        }
        # Сначала дети: главный, погашенный первым, мог бы успеть поднять их снова.
        for ($i = $tree.Count - 1; $i -ge 0; $i--) {
            Stop-Process -Id $tree[$i] -Force -ErrorAction SilentlyContinue
        }
    }

    $deadline = (Get-Date).AddSeconds(20)
    while ((Get-Date) -lt $deadline) {
        if (@(Get-OwnJarvisProcesses -SourceDir $SourceDir).Count -eq 0) { return $true }
        Start-Sleep -Milliseconds 300
    }
    throw 'Джарвис не закрылся за 20 секунд. Закройте его из трея и запустите установку снова.'
}

function Test-JarvisInstallRoot {
    # Удаляется только папка, которая правда Джарвис: имя Rujarvis и внутри его
    # приложение или данные. Опечатка в -InstallRoot не должна стоить диска.
    param([Parameter(Mandatory)] [string] $Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) { return $false }
    if ((Split-Path -Leaf $Path) -ne 'Rujarvis') { return $false }
    $приложение = Test-Path -LiteralPath (Join-Path $Path 'src\app\main.ts')
    $данные = Test-Path -LiteralPath (Join-Path $Path 'data')
    return ($приложение -or $данные)
}

function Remove-Tree {
    # node_modules под pnpm глубокий: Remove-Item в Windows PowerShell 5.1
    # спотыкается о пути длиннее 260 знаков. Тогда — rd с префиксом \\?\,
    # которому длина не мешает.
    param([Parameter(Mandatory)] [string] $Path)
    try {
        Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction Stop
    } catch {
        $prev = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try { & cmd.exe /d /c "rd /s /q `"\\?\$Path`"" 2>&1 | Out-Null } finally { $ErrorActionPreference = $prev }
    }
    return -not (Test-Path -LiteralPath $Path)
}

# ---------------------------------------------------------------------------

Write-Host ''
Write-Host '  Rujarvis — удаление' -ForegroundColor White
Write-Host ''

if ($env:OS -ne 'Windows_NT') {
    throw 'Этот скрипт для Windows. На macOS: bash uninstall.sh'
}

# Скрипт мог быть запущен из папки, которую сейчас удалит: рабочую папку уводим.
Set-Location -LiteralPath $env:TEMP

$removed = New-Object System.Collections.Generic.List[string]

Write-Step 'Закрываю Джарвиса'
if (Test-Path -LiteralPath $SourceDir) {
    if (Stop-RunningJarvis -SourceDir $SourceDir) { Write-Ok 'Работающий Джарвис закрыт.' }
    else { Write-Ok 'Не был запущен.' }
} else {
    Write-Ok 'Приложения нет — закрывать нечего.'
}

Write-Step 'Убираю ярлыки'
$desktopDir = [Environment]::GetFolderPath('Desktop')
$shortcuts = @(
    (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Rujarvis.lnk'),
    (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup\Rujarvis.lnk')
)
if ($desktopDir) { $shortcuts += (Join-Path $desktopDir 'Rujarvis.lnk') }
foreach ($lnk in $shortcuts) {
    if (Test-Path -LiteralPath $lnk) {
        Remove-Item -LiteralPath $lnk -Force
        $removed.Add($lnk)
        Write-Ok "Убран: $lnk"
    }
}

Write-Step 'Удаляю папку Джарвиса'
if (-not (Test-Path -LiteralPath $InstallRoot)) {
    Write-Ok "Папки нет: $InstallRoot"
} elseif (-not (Test-JarvisInstallRoot -Path $InstallRoot)) {
    throw "Не похоже на папку Джарвиса, не трогаю: $InstallRoot (нужно имя Rujarvis и внутри src\app\main.ts или data)."
} elseif (Remove-Tree -Path $InstallRoot) {
    $removed.Add($InstallRoot)
    Write-Ok "Удалена: $InstallRoot"
} else {
    throw "Папка удалилась не целиком: $InstallRoot. Закройте всё, что может её держать, и запустите удаление снова."
}

Write-Host ''
Write-Host '  Готово: Rujarvis удалён.' -ForegroundColor Green
Write-Host ''
Write-Host '  Не тронуто:' -ForegroundColor White
if ($desktopDir) {
    foreach ($name in @('Джарвис', 'Jarvis')) {
        $results = Join-Path $desktopDir $name
        if (Test-Path -LiteralPath $results) { Write-Host "    $results — ваши результаты" -ForegroundColor DarkGray }
    }
}
Write-Host '    Claude Code и Codex и вход в них — это отдельные программы' -ForegroundColor DarkGray
Write-Host ''
