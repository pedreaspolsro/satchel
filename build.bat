@echo off
setlocal
rem Builds the runnable Satchel.exe into dist\Satchel-win32-x64\ (no installer, just run it).
set "ROOT=%~dp0"
pushd "%ROOT%"
if not exist "node_modules\electron\dist\electron.exe" (
  echo Installing dependencies ...
  call npm install --no-audit --no-fund || goto fail
)
echo Building ...
call npm run build || goto fail
popd
echo.
echo Done: %ROOT%dist\Satchel-win32-x64\Satchel.exe
echo Pin that exe to the taskbar or create a shortcut to it; satchel.bat also prefers it now.
pause
exit /b 0

:fail
popd
echo.
echo Build failed - see the messages above (Node 20+ and npm must be on PATH).
pause
exit /b 1
