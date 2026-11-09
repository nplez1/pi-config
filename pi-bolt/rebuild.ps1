#Requires -Version 5.1
<#
.SYNOPSIS
  rebuild.ps1 - Windows counterpart of rebuild.sh: keep the prebuilt pi-bolt
  bundles in step with the sources they were built from.

.DESCRIPTION
  pi-bolt loads the forks as prebuilt `dist-bun/` bundles, and that build output
  is gitignored - every machine generates its own. On Unix the ~/.zshrc hook runs
  rebuild.sh before each launch; Windows has no such hook, so run this after a
  `git pull`, a submodule bump, or `pi-bolt update --extensions`.

  The bundle sources are:
    plugins/pi-subagents          -> pi-bolt/pi-bolt-subagents
    plugins/pi-advisor-subagent   -> pi-bolt/pi-bolt-advisor-subagent
    ~/.pi/agent/npm/node_modules/pi-web-access
                                  -> pi-bolt/pi-bolt-web-access

.PARAMETER Force
  Rebuild every bundle unconditionally (what install.ps1 runs).

.PARAMETER Check
  Report staleness and exit 1; rebuild nothing.

.PARAMETER Verbose
  Stream each builder's full log instead of one line per bundle.

.EXAMPLE
  .\rebuild.ps1            # rebuild whatever is stale
  .\rebuild.ps1 -Check     # is anything stale?
  .\rebuild.ps1 -Force     # all three, unconditionally

  .\rebuild.cmd -Force     # what to use: the default execution policy refuses .ps1

.NOTES
  Run this through rebuild.cmd unless this machine's execution policy allows
  .ps1 files. Windows ships with `Set-ExecutionPolicy Restricted`, which answers
  a bare `.\rebuild.ps1` with "running scripts is disabled on this system";
  rebuild.cmd passes a per-process -ExecutionPolicy Bypass, which changes nothing
  on the machine and needs no administrator.

  Env: PIBOLT_BUN  path to bun when it is not on PATH.
  A *failed* rebuild still exits 0 in the default mode, exactly as rebuild.sh
  does: the usual cause is broken source mid-edit, and refusing to start pi-bolt
  at that moment is worse than running the previous working bundle. -Check is the
  mode that reports an exit code for gating.
#>
[CmdletBinding()]
param(
  [switch]$Force,
  [switch]$Check
)

$ErrorActionPreference = 'Continue'

$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Rebuilder = Join-Path $Here 'rebuild.mjs'

if (-not (Test-Path -LiteralPath $Rebuilder)) {
  Write-Error "rebuild.mjs is missing from $Here"
  exit 1
}

# rebuild.mjs is bun, not node: it imports ../../lib/bundle-info.mjs and drives
# Bun.build. Resolve bun the way rebuild.sh does - PIBOLT_BUN wins, then PATH.
$bun = $null
if ($env:PIBOLT_BUN) {
  if (Test-Path -LiteralPath $env:PIBOLT_BUN) { $bun = $env:PIBOLT_BUN }
} else {
  $cmd = Get-Command bun -ErrorAction SilentlyContinue
  if ($cmd) { $bun = $cmd.Source }
}
if (-not $bun) {
  Write-Error 'rebuild.ps1: bun is required (install bun, or set PIBOLT_BUN to its path)'
  exit 1
}

$arguments = @($Rebuilder)
if ($Check) { $arguments += '--check' }
elseif ($Force) { $arguments += '--force' }
if ($VerbosePreference -eq 'Continue') { $arguments += '--verbose' }

# rebuild.mjs reports progress on stderr even when it succeeds ("no readable
# build-info.json (ENOENT)" is just how a first build is described, since that
# file is gitignored), so both streams belong in the transcript.
& $bun @arguments 2>&1 | ForEach-Object { Write-Host $_ }
exit $LASTEXITCODE
