@echo off
rem install.cmd - run install.ps1 without depending on this machine's execution
rem policy.
rem
rem Windows ships with `Set-ExecutionPolicy Restricted`, so a bare
rem `.\install.ps1` is refused ("running scripts is disabled on this system").
rem -ExecutionPolicy Bypass is a PER-PROCESS override: it changes nothing on the
rem machine and needs no administrator.
rem
rem   install.cmd             link + seed, submodules, plugins, Pi-Bolt, bundles
rem   install.cmd -DryRun     print what would happen, change nothing
rem   install.cmd capture     publish this machine's settings back into the repo
rem   install.cmd uninstall   remove the links that point into this repo
rem
rem Env vars work as documented in install.ps1 (PI_CONFIG_SKIP_PLUGINS,
rem PI_CONFIG_SKIP_PIBOLT, PI_CONFIG_SKIP_TOOLS, PI_CONFIG_SKIP_BUNDLES,
rem PIBOLT_BUN).
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
exit /b %ERRORLEVEL%
