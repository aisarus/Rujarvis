@echo off
rem Шаг обхода CodeRabbit из планировщика Windows.
rem
rem Зачем отдельный файл. Планировщику нужен один исполняемый вызов, а работа
rem идёт в bash и требует правильной папки. Заодно всё пишется в журнал: иначе
rem задача, которая молча не делает ничего, неотличима от работающей.
rem
rem Ставится так — ОДИН раз, копией ВНЕ рабочего дерева:
rem
rem   mkdir "%LOCALAPPDATA%\Rujarvis\tools"
rem   copy scripts\coderabbit-cron.cmd "%LOCALAPPDATA%\Rujarvis\tools\"
rem   schtasks /create /tn "Rujarvis CodeRabbit" /sc minute /mo 15 ^
rem     /tr "%LOCALAPPDATA%\Rujarvis\tools\coderabbit-cron.cmd"
rem
rem Снять:  schtasks /delete /tn "Rujarvis CodeRabbit" /f
rem
rem Две поломки, из-за которых обход молча встал на полтора часа 25.09.2026.
rem Обе видны только в журнале, и обе тут закрыты:
rem
rem   1. Задача указывала на файл В рабочем дереве. Стоило переключить ветку,
rem      где этого файла нет, — и планировщик отдавал код 1 каждые пятнадцать
rem      минут. Поэтому задача смотрит на копию в %LOCALAPPDATA%, а сам шаг
rem      берётся из git, из ветки main: ветка рабочего дерева больше ни на что
rem      не влияет.
rem   2. Планировщик даёт узкий PATH, и bash не находил awk («awk: command not
rem      found»), хотя тот лежит рядом с самим bash. Из окна разработчика всё
rem      работало, и поломка нашлась только в журнале. PATH задаётся явно.

setlocal

set "REPO=C:\Users\ariel\AppData\Local\Rujarvis\src"
set "LOGDIR=C:\Users\ariel\AppData\Local\Rujarvis\logs"
set "LOG=%LOGDIR%\coderabbit.log"
set "GIT=C:\Program Files\Git"
set "BASH=%GIT%\usr\bin\bash.exe"

rem PATH планировщика беднее пользовательского: сюда кладём то, чем пользуется
rem сам скрипт — awk, date, grep — и gh с git.
set "PATH=%GIT%\usr\bin;%GIT%\mingw64\bin;%GIT%\cmd;%PATH%"

if not exist "%LOGDIR%" mkdir "%LOGDIR%" 2>nul

cd /d "%REPO%" || exit /b 1

for /f "tokens=1-2 delims= " %%a in ('powershell -NoProfile -Command "Get-Date -Format \"yyyy-MM-dd HH:mm:ss\""') do set "NOW=%%a %%b"
echo(>> "%LOG%"
echo === %NOW% ===>> "%LOG%"

rem Шаг берём из origin/main, а не из рабочего дерева: обход не должен зависеть
rem ни от того, на какой ветке я сижу, ни от того, насколько отстал локальный
rem main.
git fetch --quiet origin main >> "%LOG%" 2>&1

rem Через файл, а не через трубу. `git show ... | bash -s` при неудаче git
rem отдаёт bash пустой ввод: тот молча выходит с нулём, и задача выглядит
rem работающей, ничего не делая. Пустой файл ловим и говорим об этом.
set "STEP=%TEMP%ujarvis-coderabbit-next.sh"
git show origin/main:scripts/coderabbit-next.sh > "%STEP%" 2>> "%LOG%"
for %%F in ("%STEP%") do if %%~zF LSS 100 (
  echo НЕ ВЫШЛО: шаг обхода не достался из origin/main>> "%LOG%"
  exit /b 1
)

"%BASH%" "%STEP%" >> "%LOG%" 2>&1

endlocal
