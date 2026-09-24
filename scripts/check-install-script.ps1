<#
    Проверка install.ps1: разбор синтаксиса и тесты чистых функций.

    Запуск:  pwsh -NoProfile -File scripts/check-install-script.ps1

    Сам путь установки не выполняется — загружаются только определения
    функций, поэтому проверку можно гонять на любой платформе с pwsh.
#>

$ErrorActionPreference = 'Stop'

$scriptPath = Join-Path (Split-Path -Parent $PSScriptRoot) 'install.ps1'
$errors = $null
$tokens = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$tokens, [ref]$errors)

if ($errors -and $errors.Count -gt 0) {
    Write-Host "Синтаксические ошибки в install.ps1: $($errors.Count)" -ForegroundColor Red
    $errors | ForEach-Object {
        Write-Host ("  строка {0}: {1}" -f $_.Extent.StartLineNumber, $_.Message)
    }
    exit 1
}
Write-Host 'install.ps1: синтаксис в порядке' -ForegroundColor Green

$functions = $ast.FindAll(
    { param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] },
    $true)
Invoke-Expression (($functions | ForEach-Object { $_.Extent.Text }) -join "`n")

$failures = 0
function Assert-That {
    param([string] $Name, [bool] $Condition)
    if ($Condition) {
        Write-Host "  ok   $Name"
    } else {
        Write-Host "  FAIL $Name" -ForegroundColor Red
        $script:failures++
    }
}

$shell = if ($IsWindows) { "$env:SystemRoot\System32\cmd.exe" } else { '/bin/sh' }
$failArgs = if ($IsWindows) { @('/c', 'exit 3') } else { @('-c', 'exit 3') }
$okArgs = if ($IsWindows) { @('/c', 'exit 0') } else { @('-c', 'exit 0') }
$presentCommand = if ($IsWindows) { 'cmd' } else { 'ls' }

Assert-That 'Test-Command находит существующую команду' (Test-Command $presentCommand)
Assert-That 'Test-Command не находит несуществующую' (-not (Test-Command 'no-such-command-xyz'))

$threw = $false
$message = ''
try {
    Invoke-Checked -FilePath $shell -Arguments $failArgs -What 'проверка'
} catch {
    $threw = $true
    $message = $_.Exception.Message
}
Assert-That 'Invoke-Checked падает на ненулевом коде выхода' $threw
Assert-That 'сообщение об ошибке называет шаг и код' ($message -match 'проверка' -and $message -match '3')

$passed = $true
try {
    Invoke-Checked -FilePath $shell -Arguments $okArgs -What 'успех'
} catch {
    $passed = $false
}
Assert-That 'Invoke-Checked пропускает нулевой код выхода' $passed


# --- Проверка версии Node ---------------------------------------------------
# Node нужен только для сборки: годится закреплённый мажор и всё, что новее.

$nodeProbe = Join-Path ([System.IO.Path]::GetTempPath()) ("rujarvis-nvmrc-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $nodeProbe -Force | Out-Null
Set-Content -Path (Join-Path $nodeProbe '.nvmrc') -Value '22.22.1'

function Write-Ok { param([string] $Message) }
function Write-Note { param([string] $Message) }

try {
    function global:node { 'v22.22.1' }
    $accepted = $true
    try { Assert-NodeVersion -SourceDir $nodeProbe } catch { $accepted = $false }
    Assert-That 'закреплённая версия Node принимается' $accepted

    function global:node { 'v24.18.0' }
    $accepted = $true
    try { Assert-NodeVersion -SourceDir $nodeProbe } catch { $accepted = $false }
    Assert-That 'более новый мажор принимается: нативных модулей больше нет' $accepted

    function global:node { 'v20.11.0' }
    $rejected = $false
    $nodeMessage = ''
    try { Assert-NodeVersion -SourceDir $nodeProbe } catch { $rejected = $true; $nodeMessage = $_.Exception.Message }
    Assert-That 'более старый мажор отклоняется' $rejected
    Assert-That 'сообщение называет обе версии' ($nodeMessage -match '22' -and $nodeMessage -match '20\.11\.0')
    Assert-That 'сообщение подсказывает, как обновить' ($nodeMessage -match 'winget upgrade')
    # Без `fnm env` команда `fnm use` ничего не меняет в текущем окне.
    Assert-That 'инструкция fnm включает fnm env' ($nodeMessage -match 'fnm env')

    $survived = $true
    try { Assert-NodeVersion -SourceDir (Join-Path $nodeProbe 'missing') } catch { $survived = $false }
    Assert-That 'без .nvmrc проверка пропускается' $survived
}
finally {
    Remove-Item -Path $nodeProbe -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -Path 'function:global:node' -ErrorAction SilentlyContinue
}

# --- Перенос данных прежней установки ----------------------------------------
# Модели весят гигабайт: переносим их из старых мест, а не качаем заново, и
# никогда не затираем то, что уже лежит на новом месте.

$legacy = Join-Path ([System.IO.Path]::GetTempPath()) ("rujarvis-legacy-" + [guid]::NewGuid())
$roaming = Join-Path $legacy 'Roaming\Interpreter'
$oldHome = Join-Path $legacy 'home\.openinterpreter\jarvis'
$root = Join-Path $legacy 'Local\Rujarvis'
New-Item -ItemType Directory -Path (Join-Path $roaming 'whisper-models\sherpa-onnx-whisper-base') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $roaming 'tts-models\vits-piper-ru_RU-irina-medium\vits-piper-ru_RU-irina-medium') -Force | Out-Null
New-Item -ItemType Directory -Path $oldHome -Force | Out-Null
Set-Content -Path (Join-Path $oldHome 'memory.json') -Value '{"projects":[]}'
New-Item -ItemType Directory -Path (Join-Path $root 'data') -Force | Out-Null
Set-Content -Path (Join-Path $root 'data\agent-notes.json') -Value 'new'
Set-Content -Path (Join-Path $oldHome 'agent-notes.json') -Value 'old'

try {
    $moved = Move-LegacyData -InstallRoot $root -RoamingRoot $roaming -LegacyHome $oldHome
    Assert-That 'модели распознавания переехали' (Test-Path (Join-Path $root 'models\whisper\sherpa-onnx-whisper-base'))
    Assert-That 'голос переехал и стал на уровень мельче' (Test-Path (Join-Path $root 'models\voices\vits-piper-ru_RU-irina-medium'))
    Assert-That 'память переехала' (Test-Path (Join-Path $root 'data\memory.json'))
    Assert-That 'новое не затёрто старым' ((Get-Content (Join-Path $root 'data\agent-notes.json') -Raw).Trim() -eq 'new')
    Assert-That 'перенесённое перечислено' ($moved.Count -eq 3)

    $again = Move-LegacyData -InstallRoot $root -RoamingRoot $roaming -LegacyHome $oldHome
    Assert-That 'повторный запуск ничего не трогает' ($again.Count -eq 0)
}
finally {
    Remove-Item -Path $legacy -Recurse -Force -ErrorAction SilentlyContinue
}

# --- Драйвер окон ------------------------------------------------------------
# Сумма нужна для каждой архитектуры, иначе проверка молча пропустит архив.

$x64 = Get-CuaDriverAsset -Architecture 'AMD64'
Assert-That 'cua-driver: x64 — архив windows-x86_64' ($x64.Url -eq 'https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.28.2/cua-driver-rs-0.28.2-windows-x86_64.zip')
Assert-That 'cua-driver: у x64 есть контрольная сумма' ($x64.Sha256 -match '^[0-9A-F]{64}$')
$arm = Get-CuaDriverAsset -Architecture 'ARM64'
Assert-That 'cua-driver: у ARM64 своя сумма' ($arm.Sha256 -match '^[0-9A-F]{64}$' -and $arm.Sha256 -ne $x64.Sha256)
Assert-That 'cua-driver: 32-битной сборки нет — и не выдумываем' ($null -eq (Get-CuaDriverAsset -Architecture 'x86'))

if ($failures -gt 0) {
    Write-Host "Провалено проверок: $failures" -ForegroundColor Red
    exit 1
}
Write-Host 'install.ps1: проверки функций пройдены' -ForegroundColor Green
