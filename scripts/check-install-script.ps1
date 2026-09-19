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

# --- Проверка версии Bun ----------------------------------------------------
# Bun 1.4.x не умеет запускать pnpm.cmd без shell: true и роняет сборку
# подмодуля с EINVAL. CI закрепляет линию 1.2, и установщик обязан проверять
# её так же, как версию Node, — иначе winget приносит последнюю.

$bunProbe = Join-Path ([System.IO.Path]::GetTempPath()) ("rujarvis-bun-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path (Join-Path $bunProbe '.github/workflows') -Force | Out-Null
Set-Content -Path (Join-Path $bunProbe '.github/workflows/ci.yml') -Encoding utf8 -Value @'
jobs:
  voice-e2e:
    steps:
      - uses: oven-sh/setup-bun@v2.2.0
        with:
          bun-version: 1.2.20
'@

try {
    Assert-That 'закреплённая версия Bun читается из ci.yml' ((Get-PinnedBunVersion -SourceDir $bunProbe) -eq '1.2.20')
    Assert-That 'без ci.yml версия Bun не выдумывается' ($null -eq (Get-PinnedBunVersion -SourceDir (Join-Path $bunProbe 'missing')))

    Assert-That 'закреплённая версия Bun принимается' ($null -eq (Get-BunVersionProblem -SourceDir $bunProbe -CurrentVersion '1.2.20'))
    Assert-That 'другой патч той же линии принимается' ($null -eq (Get-BunVersionProblem -SourceDir $bunProbe -CurrentVersion '1.2.21'))

    $bunMessage = Get-BunVersionProblem -SourceDir $bunProbe -CurrentVersion '1.4.2'
    Assert-That 'более новая линия Bun отклоняется' ($null -ne $bunMessage)
    Assert-That 'сообщение про Bun называет обе версии' ($bunMessage -match '1\.4\.2' -and $bunMessage -match '1\.2')
    Assert-That 'сообщение про Bun подсказывает команду установки' ($bunMessage -match 'winget install' -and $bunMessage -match 'Oven-sh\.Bun')

    Assert-That 'более старая линия Bun тоже отклоняется' ($null -ne (Get-BunVersionProblem -SourceDir $bunProbe -CurrentVersion '1.1.30'))
    Assert-That 'без ci.yml проверка Bun пропускается' ($null -eq (Get-BunVersionProblem -SourceDir (Join-Path $bunProbe 'missing') -CurrentVersion '1.4.2'))
}
finally {
    Remove-Item -Path $bunProbe -Recurse -Force -ErrorAction SilentlyContinue
}

# --- Unix-утилиты из Git для сборки подмодуля -------------------------------
# Скрипты сборки interpreter-extension зовут `rm`, а pnpm на Windows запускает
# их через cmd.exe. На образах GitHub Actions каталог Git\usr\bin лежит в PATH,
# поэтому CI собирается, а чистая машина — нет.

$gitTools = $null
$gitThrew = $false
try { $gitTools = Get-GitUnixToolsDir } catch { $gitThrew = $true }
Assert-That 'поиск Unix-утилит Git не падает там, где их нет' (-not $gitThrew)
Assert-That 'поиск Unix-утилит Git возвращает путь или null' ($null -eq $gitTools -or $gitTools -is [string])

if ($failures -gt 0) {
    Write-Host "Провалено проверок: $failures" -ForegroundColor Red
    exit 1
}
Write-Host 'install.ps1: проверки функций пройдены' -ForegroundColor Green
