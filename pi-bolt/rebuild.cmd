@echo off
rem rebuild.cmd — run rebuild.ps1 without depending on this machine's execution
rem policy.
rem
rem Windows ships with `Set-ExecutionPolicy Restricted`, which refuses to run any
rem .ps1 at all ("running scripts is disabled on this system"). -ExecutionPolicy
rem Bypass is a PER-PROCESS override: it changes nothing on the machine, needs no
rem administrator, and is the same thing install.ps1 already uses to call the
rem other helper scripts. That is why this wrapper exists rather than asking you
rem to run Set-ExecutionPolicy.
rem
rem   rebuild.cmd            rebuild whatever is stale
rem   rebuild.cmd -Check     is anything stale? (exit 1 if so)
rem   rebuild.cmd -Force     all three, unconditionally
rem   rebuild.cmd -Force -Verbose
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0rebuild.ps1" %*
exit /b %ERRORLEVEL%
