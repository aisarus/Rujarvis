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

if ($failures -gt 0) {
    Write-Host "Провалено проверок: $failures" -ForegroundColor Red
    exit 1
}
Write-Host 'install.ps1: проверки функций пройдены' -ForegroundColor Green
