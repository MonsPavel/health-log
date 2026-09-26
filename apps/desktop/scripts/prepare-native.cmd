@echo off
rem TASK-022 §5: Windows-обёртка prepare-native для cmd.exe — канонический
rem скрипт bash (среда проекта Windows + Git Bash, §22; постинсталл вызывает
rem bash напрямую). Требует bash в PATH (Git for Windows).
bash "%~dp0prepare-native.sh" %*
exit /b %ERRORLEVEL%
