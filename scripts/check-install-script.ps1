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
    # winget здесь заглушка. Настоящий ставит программы по-настоящему, а тест,
    # который меняет машину, — не тест.
    $global:wingetCalls = 0
    function global:winget { $global:wingetCalls++; $global:LASTEXITCODE = 1 }

    function global:node { 'v22.22.1' }
    $accepted = $true
    try { Assert-NodeVersion -SourceDir $nodeProbe } catch { $accepted = $false }
    Assert-That 'закреплённая версия Node принимается' $accepted

    function global:node { 'v24.18.0' }
    $accepted = $true
    try { Assert-NodeVersion -SourceDir $nodeProbe } catch { $accepted = $false }
    Assert-That 'более новый мажор принимается: нативных модулей больше нет' $accepted

    # Человек просил одну команду. Пока winget может обновить Node, установщик
    # обязан это сделать, а не выдать инструкцию посреди установки.
    $global:nodeAnswer = 'v20.11.0'
    function global:node { $global:nodeAnswer }
    function global:winget { $global:wingetCalls++; $global:nodeAnswer = 'v24.18.0'; $global:LASTEXITCODE = 0 }
    $global:wingetCalls = 0
    $upgraded = $true
    try { Assert-NodeVersion -SourceDir $nodeProbe } catch { $upgraded = $false }
    Assert-That 'старый Node обновляется сам, а не отдаётся человеку' $upgraded
    Assert-That 'обновление шло через winget' ($global:wingetCalls -ge 1)

    function global:winget { $global:wingetCalls++; $global:LASTEXITCODE = 1 }
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
    Remove-Item -Path 'function:global:winget' -ErrorAction SilentlyContinue
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

# --- pnpm ставится и меняется без прав администратора ------------------------
# corepack кладёт свою заглушку рядом с системным Node и без администратора
# получает EPERM. Установщик запускают обычным пользователем — значит первым
# должен идти npm, который ставит в папку пользователя.

$pnpmProbe = Join-Path ([System.IO.Path]::GetTempPath()) ("rujarvis-pnpm-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $pnpmProbe -Force | Out-Null
Set-Content -Path (Join-Path $pnpmProbe 'package.json') -Value '{"packageManager":"pnpm@9.15.9"}'

try {
    $global:pnpmAnswer = '11.11.0'
    $global:whoRan = @()
    function global:pnpm { $global:pnpmAnswer }
    function global:npm { $global:whoRan += 'npm'; $global:pnpmAnswer = '9.15.9' }
    function global:corepack { $global:whoRan += 'corepack' }

    $switched = $true
    try { Assert-PnpmVersion -SourceDir $pnpmProbe } catch { $switched = $false }
    Assert-That 'чужая версия pnpm меняется сама' $switched
    Assert-That 'первым идёт npm: он не просит прав' ($global:whoRan[0] -eq 'npm')
    Assert-That 'corepack не понадобился' ($global:whoRan -notcontains 'corepack')

    # npm бывает и бессилен — тогда corepack как запасной путь.
    $global:pnpmAnswer = '11.11.0'
    $global:whoRan = @()
    function global:npm { $global:whoRan += 'npm' }
    function global:corepack { $global:whoRan += 'corepack'; $global:pnpmAnswer = '9.15.9' }
    $viaCorepack = $true
    try { Assert-PnpmVersion -SourceDir $pnpmProbe } catch { $viaCorepack = $false }
    Assert-That 'когда npm бессилен, выручает corepack' $viaCorepack
    Assert-That 'corepack пробуют вторым' ($global:whoRan -contains 'corepack')

    # Оба не смогли — честная остановка с командой, которую можно скопировать.
    $global:pnpmAnswer = '11.11.0'
    function global:npm { }
    function global:corepack { }
    $pnpmMessage = ''
    try { Assert-PnpmVersion -SourceDir $pnpmProbe } catch { $pnpmMessage = $_.Exception.Message }
    Assert-That 'когда не смог никто — останавливаемся' ($pnpmMessage -ne '')
    Assert-That 'в сообщении есть готовая команда' ($pnpmMessage -match 'npm install -g pnpm@9\.15\.9')

    # Нужная версия уже стоит — никого не трогаем.
    $global:pnpmAnswer = '9.15.9'
    $global:whoRan = @()
    function global:npm { $global:whoRan += 'npm' }
    function global:corepack { $global:whoRan += 'corepack' }
    $quiet = $true
    try { Assert-PnpmVersion -SourceDir $pnpmProbe } catch { $quiet = $false }
    Assert-That 'подходящий pnpm оставляют в покое' ($quiet -and $global:whoRan.Count -eq 0)
}
finally {
    Remove-Item -Path $pnpmProbe -Recurse -Force -ErrorAction SilentlyContinue
    'pnpm', 'npm', 'corepack' | ForEach-Object {
        Remove-Item -Path "function:global:$_" -ErrorAction SilentlyContinue
    }
}

# --- PATH дополняем, а не заменяем -------------------------------------------
# Замена отняла бы пути, которые есть в процессе, но не в реестре: так собран
# PATH в CI и у менеджеров версий.

if ($IsWindows) {
    $ownPath = Join-Path ([System.IO.Path]::GetTempPath()) 'rujarvis-path-probe'
    $before = $env:Path
    try {
        $env:Path = "$ownPath;$env:Path"
        Update-SessionPath
        Assert-That 'путь только этого окна переживает обновление' ($env:Path -split ';' -contains $ownPath)
        Update-SessionPath
        Assert-That 'повтор не удваивает путь' ((($env:Path -split ';') | Where-Object { $_ -eq $ownPath }).Count -eq 1)
    }
    finally {
        $env:Path = $before
    }
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
