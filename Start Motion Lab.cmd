@echo off
rem ---------------------------------------------------------------------------
rem  Start Motion Lab.
rem
rem  Serves the editor on http://127.0.0.1:5273 and opens it in your browser.
rem  Everything runs locally: projects and media live in the workspace folder
rem  next to this file, and nothing is uploaded anywhere.
rem ---------------------------------------------------------------------------
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Motion Lab needs Node.js 22 or newer.
  echo   Install it from https://nodejs.org and run this file again.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo   Installing the development dependencies ^(only needed for tests^)...
  call npm install --no-audit --no-fund
)

echo.
echo   Starting Motion Lab...
echo.
node server\index.js --port 5273 --open
pause
