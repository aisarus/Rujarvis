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
# Пропущенное считается отдельно: «нечем мерить» — не «прошло».
$skipped = 0
function Assert-That {
    param([string] $Name, [bool] $Condition)
    if ($Condition) {
        Write-Host "  ok   $Name"
    } else {
        Write-Host "  FAIL $Name" -ForegroundColor Red
        $script:failures++
    }
}

# Windows определяем по $env:OS, а не по той переменной, которой нет в 5.1.
#
# Ровно из-за неё падал сам install.ps1 — и вот она же сидела в стороже,
# который это и должен ловить. Строгого режима здесь нет, поэтому ничего
# не падало: читалось как $null, скрипт молча уходил в ветку /bin/sh, и
# две проверки Invoke-Checked проваливались. Увидеть это можно было только
# запустив сторожа пятёркой, а CI зовёт его семёркой, где переменная есть.
# Замер 25.09.2026: под 5.1 «Провалено проверок: 2», под 7 — ноль.
$onWindows = $env:OS -eq 'Windows_NT'

$shell = if ($onWindows) { "$env:SystemRoot\System32\cmd.exe" } else { '/bin/sh' }
$failArgs = if ($onWindows) { @('/c', 'exit 3') } else { @('-c', 'exit 3') }
$okArgs = if ($onWindows) { @('/c', 'exit 0') } else { @('-c', 'exit 0') }
$presentCommand = if ($onWindows) { 'cmd' } else { 'ls' }

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
# Болтовня в stderr — не отказ.
#
# В 5.1 при $ErrorActionPreference = 'Stop' строка stderr внешней программы
# становится NativeCommandError и бросается, а код возврата никто не смотрит.
# `git clone` пишет «Cloning into ...» в stderr ВСЕГДА, даже на успехе, — и
# установка падала на шаге «Получаю исходники» при успешном клоне. Нашёл
# первый живой прогон установки на Windows 25.09.2026.
#
# Проверяется это ДОЧЕРНЕЙ оболочкой со слитыми потоками, а не вызовом прямо
# здесь. Первая попытка звала Invoke-Checked в этом же процессе и оставалась
# зелёной на заведомо сломанном коде: NativeCommandError рождается только
# тогда, когда stderr внешней программы куда-то перенаправлен — а GitHub
# запускает шаг именно так, `powershell -command ". 'файл'"`. Проверка, не
# воспроизводящая условие, проверяет не то.
$noiseProbe = @'
$ErrorActionPreference = 'Stop'
__FUNCTION__
# Потоки СЛИВАЮТСЯ: без этого ловушка не срабатывает вовсе.
#
# Замер 25.09.2026: прямой вызов проходит, а `... *>&1 | Out-Null` роняет
# NativeCommandError. Первая версия этой пробы звала функцию прямо и потому
# зеленела на заведомо сломанном коде. Сливает потоки всякий, кто пишет
# установку в журнал, - и шаг CI, и человек, собирающий отчёт об ошибке.
$ok = $true
try {
    Invoke-Checked -FilePath $env:ComSpec -Arguments @('/c', 'echo Cloning into repo 1>&2 & exit 0') -What 'klon' *>&1 | Out-Null
} catch {
    $ok = $false
}
$seen = $false
try {
    Invoke-Checked -FilePath $env:ComSpec -Arguments @('/c', 'echo beda 1>&2 & exit 7') -What 'klon' *>&1 | Out-Null
} catch {
    $seen = $_.Exception.Message -match '7'
}
"ITOG noise=$ok fail=$seen"
'@

if ($onWindows) {
    $checkedText = ($functions | Where-Object { $_.Name -eq 'Invoke-Checked' } | Select-Object -First 1).Extent.Text
    $probeFile = Join-Path ([IO.Path]::GetTempPath()) 'rujarvis-noise-probe.ps1'
    # С BOM: 5.1 читает UTF-8 без него как ANSI и не разбирает кириллицу.
    [IO.File]::WriteAllText($probeFile, $noiseProbe.Replace('__FUNCTION__', $checkedText), [Text.UTF8Encoding]::new($true))
    # Ослабляем предпочтение и здесь: проба НАРОЧНО шумит в stderr, и с
    # 'Stop' эта строка роняла бы самого сторожа вместо честного FAIL.
    # Поймано на себе же, 25.09.2026.
    $prevPref = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $answer = & "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -Command ". '$probeFile'" 2>&1 | Out-String
    }
    finally {
        $ErrorActionPreference = $prevPref
    }
    Remove-Item $probeFile -Force -ErrorAction SilentlyContinue
    Assert-That 'Invoke-Checked не считает stderr отказом при нулевом коде' ($answer -match 'noise=True')
    Assert-That 'Invoke-Checked всё ещё падает на настоящем отказе с болтовнёй' ($answer -match 'fail=True')
}
else {
    Write-Host 'пропуск: ловушка stderr есть только в Windows PowerShell' -ForegroundColor Yellow
    $skipped += 2
}



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

if ($onWindows) {
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
else {
    # «Нечем мерить» обязано отличаться от «прошло».
    #
    # Блок выше не выполнялся вне Windows и не печатал ничего, а в конце
    # выводилось «проверки функций пройдены». Человек на macOS видел зелёный
    # итог, хотя Update-SessionPath никто не трогал.
    Write-Host 'пропуск: PATH проверяется только на Windows' -ForegroundColor Yellow
    $skipped += 1
}

# --- Драйвер окон ------------------------------------------------------------
# Сумма нужна для каждой архитектуры, иначе проверка молча пропустит архив.

$x64 = Get-CuaDriverAsset -Architecture 'AMD64'
Assert-That 'cua-driver: x64 — архив windows-x86_64' ($x64.Url -eq 'https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.28.2/cua-driver-rs-0.28.2-windows-x86_64.zip')
Assert-That 'cua-driver: у x64 есть контрольная сумма' ($x64.Sha256 -match '^[0-9A-F]{64}$')
$arm = Get-CuaDriverAsset -Architecture 'ARM64'
Assert-That 'cua-driver: у ARM64 своя сумма' ($arm.Sha256 -match '^[0-9A-F]{64}$' -and $arm.Sha256 -ne $x64.Sha256)
Assert-That 'cua-driver: 32-битной сборки нет — и не выдумываем' ($null -eq (Get-CuaDriverAsset -Architecture 'x86'))

# BOM и `irm | iex` вместе не живут.
#
# Файлу BOM НУЖЕН: без него Windows PowerShell 5.1 читает русские сообщения как
# ANSI, и байт 0x94 из «—», «Д», «Б» закрывает строку раньше времени — скрипт
# не разбирается вовсе. А `irm | iex` получает файл СТРОКОЙ, и BOM попадает в её
# начало: открывающий `<#` перестаёт распознаваться, и установка падает с
# «Непредвиденная лексема "ставит"».
#
# Эти две правды сошлись 26.09.2026 на живой машине человека: BOM я добавил
# вчера, команду в README не тронул, и установка перестала работать у всех.
# Поэтому теперь их сторожат ВМЕСТЕ: пока у файла есть BOM, в документации не
# должно быть ни `| iex`, ни `scriptblock::Create` от скачанной строки.
$ставитФайлом = @('README.md', 'README.en.md', 'docs/jarvis/install.md')
$сБом = [IO.File]::ReadAllBytes($scriptPath)[0..2] -join ' ' -eq '239 187 191'
Assert-That 'у install.ps1 есть BOM: без него 5.1 не разберёт кириллицу' $сБом

# Ярлык на рабочем столе.
#
# Первый живой человек прошёл установку целиком и сказал: «ярлык на рабочем
# столе установщик ещё не создал». Он и не создавал — только в меню «Пуск» и
# в автозапуске, хотя на маке алиас на столе кладётся давно. Меню человек
# ищет, стол он видит.
#
# Сторожим две вещи: что ярлык вообще делается и что папку спрашивают у
# Windows. Склейка $env:USERPROFILE + 'Desktop' врёт при папке, перенесённой
# в OneDrive, и при нерусской локали — ярлык лёг бы туда, где его не увидят.
$текст = [IO.File]::ReadAllText($scriptPath)
Assert-That 'install.ps1 кладёт ярлык на рабочий стол' ($текст -match "Join-Path \`$desktopDir 'Rujarvis\.lnk'")
Assert-That 'папка рабочего стола спрошена у Windows, а не склеена' ($текст -match "GetFolderPath\('Desktop'\)")

foreach ($док in $ставитФайлом) {
    $путьДок = Join-Path (Split-Path -Parent $PSScriptRoot) $док
    if (-not (Test-Path $путьДок)) { continue }
    $текстДок = Get-Content $путьДок -Raw
    $строкой = $текстДок -match 'install\.ps1[^
]*\|\s*iex' -or $текстДок -match 'scriptblock\]::Create\(\(irm'
    Assert-That "$док ставит через файл, а не строкой: BOM ломает iex" (-not $строкой)
    Assert-That "$док называет скачивание в файл" ($текстДок -match '-OutFile')
}

if ($failures -gt 0) {
    Write-Host "Провалено проверок: $failures" -ForegroundColor Red
    exit 1
}
if ($skipped -gt 0) {
    Write-Host "install.ps1: проверки функций пройдены, пропущено: $skipped" -ForegroundColor Yellow
}
else {
    Write-Host 'install.ps1: проверки функций пройдены' -ForegroundColor Green
}

# Итог проверки — её код возврата, а не то, что осталось от чужой команды.
#
# Без этой строки скрипт печатал «проверки пройдены» и возвращал единицу:
# $LASTEXITCODE держал код последней НАТИВНОЙ команды, отработавшей где-то
# внутри. `ci.yml` этого не видел, потому что зовёт скрипт отдельным процессом
# (`pwsh -File`), где код берётся заново. А обход установки Windows зовёт его
# через `shell: pwsh`, то есть точкой, и чужая единица утекала наружу: шаг
# падал на зелёной проверке. Поймано первым же живым прогоном 25.09.2026.
exit 0
