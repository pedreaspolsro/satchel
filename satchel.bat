@echo off
setlocal
rem Satchel launcher. Double-click (or run from a shortcut) to open the panel;
rem pass CLI flags for scripting, e.g.  satchel.bat --list
rem Prefers the packaged exe (build.bat); falls back to the dev checkout via Electron.
set "ROOT=%~dp0"
set "EXE=%ROOT%dist\Satchel-win32-x64\Satchel.exe"
set "ARGS="

if exist "%EXE%" goto run
set "EXE=%ROOT%node_modules\electron\dist\electron.exe"
set "ARGS="%ROOT%.""
if exist "%EXE%" goto run

echo Satchel: dependencies missing, running npm install ...
pushd "%ROOT%"
call npm install --no-audit --no-fund
popd
if not exist "%EXE%" (
  echo Satchel: install failed - is Node 20+ on PATH?
  pause
  exit /b 1
)

:run
if "%~1"=="" (
  rem GUI: detach so this console window closes right away. A second launch just focuses the running panel.
  start "Satchel" /D "%ROOT%" "%EXE%" %ARGS%
) else (
  rem CLI mode (--list, --launch, --tile ...): stay in the foreground so the output is visible.
  "%EXE%" %ARGS% %*
)
endlocal
