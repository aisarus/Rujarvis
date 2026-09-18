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
# Раньше проверялась только нижняя граница, поэтому машина с Node 24 проходила
# насквозь, а падало гораздо позже — на сборке нативных модулей.

$nodeProbe = Join-Path ([System.IO.Path]::GetTempPath()) ("rujarvis-nvmrc-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $nodeProbe -Force | Out-Null
Set-Content -Path (Join-Path $nodeProbe '.nvmrc') -Value '22.22.1'

function Write-Ok { param([string] $Message) }

try {
    function global:node { 'v22.22.1' }
    $accepted = $true
    try { Assert-NodeVersion -SourceDir $nodeProbe } catch { $accepted = $false }
    Assert-That 'закреплённая версия Node принимается' $accepted

    function global:node { 'v22.9.0' }
    $accepted = $true
    try { Assert-NodeVersion -SourceDir $nodeProbe } catch { $accepted = $false }
    Assert-That 'другой патч того же мажора принимается' $accepted

    function global:node { 'v24.18.0' }
    $rejected = $false
    $nodeMessage = ''
    try { Assert-NodeVersion -SourceDir $nodeProbe } catch { $rejected = $true; $nodeMessage = $_.Exception.Message }
    Assert-That 'более новый мажор отклоняется' $rejected
    Assert-That 'сообщение называет обе версии' ($nodeMessage -match '22' -and $nodeMessage -match '24\.18\.0')
    Assert-That 'сообщение подсказывает, как переключиться' ($nodeMessage -match 'fnm')
    # Без `fnm env` команда `fnm use` ничего не меняет в текущем окне —
    # инструкция без этой строки отправляет человека по кругу.
    Assert-That 'инструкция включает fnm env' ($nodeMessage -match 'fnm env')

    function global:node { 'v20.11.0' }
    $rejected = $false
    try { Assert-NodeVersion -SourceDir $nodeProbe } catch { $rejected = $true }
    Assert-That 'более старый мажор отклоняется' $rejected

    $survived = $true
    try { Assert-NodeVersion -SourceDir (Join-Path $nodeProbe 'missing') } catch { $survived = $false }
    Assert-That 'без .nvmrc проверка пропускается' $survived
}
finally {
    Remove-Item -Path $nodeProbe -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -Path 'function:global:node' -ErrorAction SilentlyContinue
}

# --- Обнаружение компилятора C++ -------------------------------------------
# Без MSVC node-gyp не соберёт нативные аддоны. Детектор обязан отвечать
# честным false там, где Visual Studio нет, а не падать.

$vsDetected = $null
$vsThrew = $false
try { $vsDetected = Test-VisualStudioBuildTools } catch { $vsThrew = $true }
Assert-That 'детектор MSVC не падает там, где Visual Studio нет' (-not $vsThrew)
Assert-That 'детектор MSVC возвращает булево' ($vsDetected -is [bool])

if ($failures -gt 0) {
    Write-Host "Провалено проверок: $failures" -ForegroundColor Red
    exit 1
}
Write-Host 'install.ps1: проверки функций пройдены' -ForegroundColor Green
