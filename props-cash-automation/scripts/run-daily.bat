@echo off
REM Props.cash Daily Automation Run
REM Called by Windows Task Scheduler

cd /d "%~dp0.."
call npx tsx automation/runner.ts --headless=true
exit /b %ERRORLEVEL%
