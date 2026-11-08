@echo off
rem after-update.cmd — run after-update.ps1 without depending on this machine's
rem execution policy.
rem
rem Windows ships with `Set-ExecutionPolicy Restricted`, which refuses to run any
rem .ps1 at all ("running scripts is disabled on this system"). -ExecutionPolicy
rem Bypass is a PER-PROCESS override: it changes nothing on the machine, needs no
rem administrator, and is what the `pi` shim and install.ps1 already use.
rem
rem   after-update.cmd            do what is needed; print only what changed
rem   after-update.cmd -Check     report and exit 1; change nothing
rem   after-update.cmd -Verbose   print every verdict
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0after-update.ps1" %*
exit /b %ERRORLEVEL%
