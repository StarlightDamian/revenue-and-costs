@echo off
setlocal

"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
  echo.
  echo Startup failed. See the message above and .work\startup logs.
  pause
)

if "%EXIT_CODE%"=="0" if "%~1"=="" (
  echo.
  echo Services are ready. Copy the HOST or URL shown above.
  pause
)

exit /b %EXIT_CODE%
