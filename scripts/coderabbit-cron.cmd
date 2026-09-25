@echo off
rem Шаг обхода CodeRabbit из планировщика Windows.
rem
rem Зачем отдельный файл. Планировщику нужен один исполняемый вызов, а работа
rem идёт в bash и требует правильной папки. Заодно всё пишется в журнал: иначе
rem задача, которая молча не делает ничего, неотличима от работающей.
rem
rem Ставится так (каждые 15 минут, от имени текущего пользователя):
rem   schtasks /create /tn "Rujarvis CodeRabbit" /sc minute /mo 15 ^
rem     /tr "C:\Users\ariel\AppData\Local\Rujarvis\src\scripts\coderabbit-cron.cmd"
rem
rem Снять:  schtasks /delete /tn "Rujarvis CodeRabbit" /f

setlocal

set "REPO=C:\Users\ariel\AppData\Local\Rujarvis\src"
set "LOG=C:\Users\ariel\AppData\Local\Rujarvis\logs\coderabbit.log"
set "BASH=C:\Program Files\Git\usr\bin\bash.exe"

if not exist "%LOG%\.." mkdir "C:\Users\ariel\AppData\Local\Rujarvis\logs" 2>nul

cd /d "%REPO%" || exit /b 1

for /f "tokens=1-2 delims= " %%a in ('powershell -NoProfile -Command "Get-Date -Format \"yyyy-MM-dd HH:mm:ss\""') do set "NOW=%%a %%b"
echo(>> "%LOG%"
echo === %NOW% ===>> "%LOG%"

"%BASH%" scripts/coderabbit-next.sh >> "%LOG%" 2>&1

endlocal
