@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js is required to build Photo Map. Install Node.js and try again.
  goto :failed
)
if not exist "node_modules\electron-builder\cli.js" (
  echo Build dependencies are missing. Run npm install in this folder first.
  goto :failed
)

echo Preparing bundled libraries...
node scripts\copy-vendor.js
if errorlevel 1 goto :failed

echo Building the portable Windows EXE...
node node_modules\electron-builder\cli.js --win portable --x64
if errorlevel 1 goto :failed

echo.
echo Build complete. Your EXE is in "%~dp0dist".
pause
exit /b 0

:failed
echo.
echo Build failed. See the error above.
pause
exit /b 1
