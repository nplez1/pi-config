#Requires -Version 5.1
<#
.SYNOPSIS
  after-update.ps1 - the Windows half of after-update.sh: put the install back in
  step after an update, quietly.

.DESCRIPTION
  `pi update` moves things that nothing else notices, and none of them shows up as
  an error at update time. Two of the Unix script's four still bite here:

    1. input    `pi update --extensions` runs `npm install` in the extension tree,
                which prunes anything that is not in package.json. pi-web-access is
                installed there as build input for the web-access bundle, so
                pruning it - and the dependencies the built bundle requires at run
                time - leaves a bundle that cannot be rebuilt and then cannot even
                be loaded.                      -> reinstalled, saved, if missing
    2. bundles  `pi update --extensions` bumps pi-web-access, and the prebuilt
                bundle that wraps it is a snapshot: pi-bolt then runs the old code
                silently.                        -> rebuild.ps1, then -Check

  The other two stay Unix-only, and this says so rather than implying otherwise:
  deps-audit.sh (the undici pin, then `npm audit fix`) is bash, and
  `pi-bolt compile` answers "compiling extensions in is not available on Windows
  yet" for every mode, so there is no compile record to re-assert. Extensions load
  from their files here, which is why the prebuilt dist-bun bundles are the one
  start-up lever this platform has.

  It also carries the module-shadowing check: a node_modules above the agent dir
  hijacks the four packages pi hands to extensions as fallbacks, so every
  extension loads a second copy of pi. That one is four stat() calls, and it
  explains what `doctor` misreports as "the JIT build would run heavy extensions
  faster".

  The `pi` shim (pi-swap.ps1) runs this after `pi update`; `pi update --models`
  passes through untouched because it moves no packages. `pi-bolt update` and
  `pi-real update` bypass the shim by definition - run after-update.cmd
  afterwards.

.PARAMETER Check
  Report what is out of step; change nothing. Exit 1 when something is.

.PARAMETER Verbose
  Print every verdict, not only what changed.

.EXAMPLE
  .\after-update.cmd            # do what is needed; print only what changed
  .\after-update.cmd -Check     # report and exit 1; change nothing
  .\after-update.cmd -Verbose   # print every verdict

.NOTES
  Exit status is 1 only when something is out of step, so a caller can run this
  after a command without changing that command's exit code - the shim restores
  pi-bolt's own code either way.

  Env: PI_AGENT_DIR  the agent directory (default %USERPROFILE%\.pi\agent).
       PIBOLT_BUN    bun, when it is not on PATH (rebuild.ps1 reads it too).

  Run this through after-update.cmd unless this machine's execution policy allows
  .ps1 files: Windows ships with `Set-ExecutionPolicy Restricted`, which answers a
  bare `.\after-update.ps1` with "running scripts is disabled on this system".
#>
[CmdletBinding()]
param([switch]$Check)

$ErrorActionPreference = 'Continue'

$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Agent = if ($env:PI_AGENT_DIR) { $env:PI_AGENT_DIR } else { Join-Path $env:USERPROFILE '.pi\agent' }
# Only -Verbose prints a verdict for a step that is already in step; the default
# run says what it changed and nothing else, exactly as after-update.sh does.
$quiet = $VerbosePreference -ne 'Continue'
$script:trouble = 0

function Say([string]$text) { Write-Output $text }
# Everything that went wrong goes to stderr and sets the exit code: a repair that
# failed is not a repair that was not needed. Write-Output here would make a
# failure read as part of the report.
function Fail([string]$text) {
  [Console]::Error.WriteLine($text)
  $script:trouble = 1
}

# ---- 0. a node_modules above the agent dir shadows the host's modules --------
# Pi hands these to extensions as *fallbacks*, so a copy on disk wins. A stray
# `npm install` in $HOME creates $HOME/node_modules, which sits above
# ~/.pi/agent and hijacks all four: every extension that imports one then loads a
# second Pi. Measured on the Unix side on 2026-10-24 - pi-bolt-subagents 239 ms
# instead of 8 ms, opensec-pi-todo 108 ms instead of 0 - and the cause is the same
# resolution order here, which is why the check is ported rather than dropped.
#
# ~/.pi/agent/npm/node_modules is deliberately NOT flagged: that one is where the
# extensions themselves are installed, and `typebox` living there is normal.
$HostModules = @(
  '@earendil-works\pi-coding-agent',
  '@earendil-works\pi-tui',
  '@earendil-works\pi-ai',
  'typebox'
)

# The node_modules directory that shadows, not the package inside it: the fix is
# to move the directory, so that is the path worth naming.
function Find-ShadowingModules([string]$start) {
  $dir = $start
  while ($dir) {
    $modules = Join-Path $dir 'node_modules'
    if (Test-Path -LiteralPath $modules) {
      foreach ($name in $HostModules) {
        if (Test-Path -LiteralPath (Join-Path $modules $name)) { return $modules }
      }
    }
    $parent = Split-Path -Parent $dir
    if (-not $parent -or $parent -eq $dir) { return $null }
    $dir = $parent
  }
  return $null
}

$shadow = Find-ShadowingModules $Agent
if ($shadow) {
  $above = Split-Path -Parent $shadow
  Fail "pi sync: a node_modules above the agent dir carries host modules: $shadow"
  Fail 'pi sync: pi supplies those itself; a copy on disk wins, so extensions load a'
  Fail 'pi sync: second copy (here: ~390 ms of extension load instead of ~40 ms).'
  Fail 'pi sync: move it out of the way - nothing in pi needs it:'
  Fail "pi sync:   move `"$shadow`" `"$above\node_modules.shadowed`""
} elseif (-not $quiet) {
  Say "pi sync: no stray node_modules shadows the host's modules"
}

# ---- 1. the bundle build input ----------------------------------------------
# The web-access bundle is built from the pi-web-access package in the extension
# tree, and Pi-Bolt's package list excludes that package - so this repo installs
# it and *saves it as a dependency* purely as build input. Saved is the
# load-bearing part: `pi update --extensions` runs `npm install <specs>` in that
# tree, npm prunes anything that is not in package.json, and on 2026-10-31 that
# took pi-web-access and its dependencies out from under the prebuilt bundle. The
# bundle then failed to load ("Cannot find module p-limit") and pi-bolt would not
# start until the input was put back. A file test plus one `npm pkg get`, so this
# looks on every run and repairs only when the input is gone or unsaved.
$NpmRoot = Join-Path $Agent 'npm'
$WebAccessEntry = Join-Path $NpmRoot 'node_modules\pi-web-access\dist\index.js'
$npm = Get-Command npm -ErrorAction SilentlyContinue
if (-not $npm) {
  if (-not $quiet) { Say 'pi sync: npm is not on PATH; not checking the web-access build input' }
} else {
  $saved = ''
  $pkgJson = Join-Path $NpmRoot 'package.json'
  if (Test-Path -LiteralPath $pkgJson) {
    Push-Location -LiteralPath $NpmRoot
    try { $saved = (& npm pkg get dependencies.pi-web-access 2>$null | Out-String).Trim().Trim('"') }
    finally { Pop-Location }
  }
  # `npm pkg get` prints {} where the key is absent.
  if ($saved -in @('', '{}', 'undefined', 'null')) { $saved = '' }

  if (-not (Test-Path -LiteralPath $WebAccessEntry) -or -not $saved) {
    if ($Check) {
      Fail "pi sync: the pi-web-access build input is missing or unsaved - run: npm install --prefix `"$NpmRoot`" --save --legacy-peer-deps pi-web-access"
    } else {
      Say 'pi sync: restoring the pi-web-access build input (a bundle is built from it)...'
      & npm install --prefix $NpmRoot --save --legacy-peer-deps --no-audit --no-fund pi-web-access 2>&1 | Out-Null
      if ($LASTEXITCODE -eq 0) {
        Say 'pi sync: pi-web-access build input restored'
      } else {
        Fail 'pi sync: could not install the pi-web-access build input - the web-access bundle cannot be rebuilt'
      }
    }
  } elseif (-not $quiet) {
    Say 'pi sync: the web-access build input is present and saved'
  }
}

# ---- 2. bundles -------------------------------------------------------------
$Rebuild = Join-Path $Here 'rebuild.ps1'
if (-not (Test-Path -LiteralPath $Rebuild)) {
  if (-not $quiet) { Say 'pi sync: rebuild.ps1 is missing from this checkout; not checking the bundles' }
} elseif ($Check) {
  $report = & $Rebuild -Check *>&1 | Out-String
  if ($LASTEXITCODE -ne 0) {
    Fail "pi sync: a bundle is stale - run `"$Here\rebuild.cmd`""
    foreach ($line in ($report -split "`r?`n" | Where-Object { $_ })) { [Console]::Error.WriteLine("  $line") }
  } elseif (-not $quiet) {
    Say 'pi sync: the bundles are fresh'
  }
} else {
  # rebuild.mjs rebuilds only what is stale, and exits 0 even when a builder
  # failed - deliberately, so pi-bolt still starts on source broken mid-edit. Its
  # status therefore proves nothing; -Check is what knows, and a bundle that is
  # still stale is only ever visible here.
  $rebuilt = & $Rebuild *>&1 | Out-String
  foreach ($line in ($rebuilt -split "`r?`n" | Where-Object { $_ })) { Say $line }
  $report = & $Rebuild -Check *>&1 | Out-String
  if ($LASTEXITCODE -ne 0) {
    Fail 'pi sync: a bundle is still stale after the rebuild - pi-bolt loads the previous bundle'
    foreach ($line in ($report -split "`r?`n" | Where-Object { $_ })) { [Console]::Error.WriteLine("  $line") }
  } elseif (-not $quiet) {
    Say 'pi sync: the bundles are fresh'
  }
}

# ---- 3. the compile set -----------------------------------------------------
# Nothing to do here, and nothing to check either: `pi-bolt compile` refuses every
# mode on Windows, including --status, and exits 0 while doing so. Stated rather
# than implied, so a future edit cannot wire in a step that reports success and
# changes nothing.
if (-not $quiet) {
  Say 'pi sync: no compile set to re-assert on Windows (pi-bolt compile is unavailable here)'
}

if ($Check -and $script:trouble -eq 0 -and -not $quiet) { Say 'pi sync: nothing out of step' }

exit $script:trouble
