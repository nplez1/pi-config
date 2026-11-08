#Requires -Version 5.1
<#
.SYNOPSIS
  pi-swap.ps1 - Windows port of pi-swap.sh: make `pi` run Pi-Bolt, or put it back.

.DESCRIPTION
  Same three actions as the shell version, same reasoning:

    apply    `pi` runs pi-bolt, everywhere, until removed
    remove   the previous `pi` again (or no `pi` at all if there was none)
    status   what `pi` resolves to right now

  `pi` and `pi-bolt` share %USERPROFILE%\.pi\agent, so sessions, settings,
  providers and credentials carry over untouched. Nothing is migrated.

  Windows differences from pi-swap.sh, which this script prints at run time:

    * A shim is a `.cmd`, not a POSIX script, and the second location is
      %USERPROFILE%\.pi\agent\bin on PATH rather than ~/.local/bin.
    * Windows installs Pi-Bolt directly, so there is usually no stock `pi` to
      preserve. When one exists it is preserved as `pi-real.cmd` and reachable
      with `pi-real` or PI_REAL=1, exactly like the Unix version.
    * The Unix shim routes `update` and `compile` through after-update.sh and
      rebuild.sh. Those are bash and are not ported, so the Windows shim calls
      pi-bolt directly and says so.

.EXAMPLE
  .\pi-swap.ps1 apply
  .\pi-swap.ps1 status
  .\pi-swap.ps1 remove

.NOTES
  Env: PI_SWAP_SKIP_PATH=1  leave the user PATH alone. For a managed machine that
       refuses the write, and for tests, which must never touch the real one; the
       shim is still written, so `pi` resolves once that directory reaches PATH by
       other means.
       PI_SWAP_PATH_KEY   the registry key the PATH read/write targets, for tests
       (default HKCU:\Environment).
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0)][string]$Action = 'status'
)

$ErrorActionPreference = 'Stop'

$BoltHome = $PSScriptRoot
$AgentBin = Join-Path $env:USERPROFILE '.pi\agent\bin'
$PiShim   = Join-Path $AgentBin 'pi.cmd'
$PiReal   = Join-Path $AgentBin 'pi-real.cmd'
$State    = Join-Path $BoltHome '.pi-swap-state'
$Marker   = 'pi-swap-shim'
# A managed machine can refuse the user PATH write, and a test must never touch
# the real one. Either way the shim is still written; only PATH is left alone.
$SkipPath = $env:PI_SWAP_SKIP_PATH -eq '1'
# Where the user PATH lives. Overridable so a test can exercise the real read and
# write without editing this machine's environment.
$PathKey = if ($env:PI_SWAP_PATH_KEY) { $env:PI_SWAP_PATH_KEY } else { 'HKCU:\Environment' }

function Test-IsShim([string]$path) {
  if (-not (Test-Path -LiteralPath $path)) { return $false }
  try { return (Select-String -LiteralPath $path -Pattern $Marker -SimpleMatch -Quiet) }
  catch { return $false }
}

# A preserved launcher is the only way back, so never overwrite it with something
# that is not usable. The Unix version had exactly this bug on 2026-10-24.
function Test-PlausibleLauncher([string]$path) {
  if (-not (Test-Path -LiteralPath $path)) { return $false }
  return ((Get-Item -LiteralPath $path).Length -gt 0)
}

function Get-ShimBody {
  # No parenthesised blocks: `exit /b` inside a nested `( )` silently returns 0
  # instead of its code, so the failure paths use labels and exit at top level.
  $body = @(
    '@echo off',
    "rem $Marker - installed by pi-swap.ps1; pi runs Pi-Bolt.",
    "rem Revert:  $BoltHome\pi-swap.ps1 remove",
    'rem Bypass:  set PI_REAL=1  (or use: pi-real)',
    'if "%PI_REAL%"=="1" goto pi_swap_real',
    'where pi-bolt >nul 2>&1 || goto pi_swap_missing',
    'rem The Unix shim routes `update`/`compile` through after-update.sh and',
    'rem rebuild.sh; those are bash and are not ported, so call pi-bolt directly.',
    'pi-bolt %*',
    'exit /b %ERRORLEVEL%',
    '',
    ':pi_swap_real',
    "if not exist `"$PiReal`" goto pi_swap_no_real",
    "call `"$PiReal`" %*",
    'exit /b %ERRORLEVEL%',
    '',
    ':pi_swap_no_real',
    "echo pi-swap: PI_REAL=1 but there is no preserved launcher at $PiReal. Revert with $BoltHome\pi-swap.ps1 remove 1>&2",
    'exit /b 127',
    '',
    ':pi_swap_missing',
    "echo pi-swap: pi-bolt is not on PATH. Revert with $BoltHome\pi-swap.ps1 remove 1>&2",
    'exit /b 127'
  )
  return $body
}

# The .NET accessor expands REG_EXPAND_SZ and writes the result back as REG_SZ,
# which would turn every %USERPROFILE%-style entry in the user PATH into a fixed
# path. Read and write the raw value instead.
function Get-RawUserPath {
  try {
    $key = Get-Item -LiteralPath $PathKey -ErrorAction Stop
    $raw = $key.GetValue('Path', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    if ($null -ne $raw) { return [string]$raw }
  } catch { }
  return [Environment]::GetEnvironmentVariable('PATH', 'User')
}

function Set-RawUserPath([string]$value) {
  if (-not (Test-Path -LiteralPath $PathKey)) { New-Item -Path $PathKey -Force | Out-Null }
  # ExpandString keeps any %VARS% unexpanded, whether or not the old value was
  # REG_SZ; a value with no variables behaves identically either way.
  Set-ItemProperty -LiteralPath $PathKey -Name 'Path' -Value $value -Type ExpandString
}

function Test-PathHasAgentBin {
  $userPath = Get-RawUserPath
  if (-not $userPath) { return $false }
  return ($userPath -split ';' | Where-Object { $_.TrimEnd('\') -ieq $AgentBin.TrimEnd('\') }).Count -gt 0
}

# added | present | failed — the caller must not report "already on PATH" for a
# write it could not perform.
function Add-AgentBinToPath {
  if (Test-PathHasAgentBin) { return 'present' }
  $userPath = Get-RawUserPath
  $newPath = if ([string]::IsNullOrWhiteSpace($userPath)) { $AgentBin } else { "$AgentBin;$userPath" }
  try { Set-RawUserPath $newPath }
  catch { Write-Warning "pi-swap: could not write the user PATH ($($_.Exception.Message)); add $AgentBin yourself"; return 'failed' }
  return 'added'
}

function Remove-AgentBinFromPath {
  $userPath = Get-RawUserPath
  if (-not $userPath) { return $false }
  $kept = $userPath -split ';' | Where-Object {
    $t = $_.Trim(); $t -ne '' -and ($t.TrimEnd('\') -ine $AgentBin.TrimEnd('\'))
  }
  Set-RawUserPath ($kept -join ';')
  return $true
}

# A stock pi installed by npm lives in %APPDATA%\npm and is shadowed by our shim
# once AgentBin is earlier on PATH; it would never be found by looking at the
# shim's own path. Find it where it actually is, so `pi-real` exists when the
# machine really has a pi to go back to.
function Find-RealPi {
  $found = Get-Command pi -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $found -or -not $found.Source) { return $null }
  $dir = (Split-Path -Parent $found.Source).TrimEnd('\')
  if ($dir -ieq $AgentBin.TrimEnd('\')) { return $null }   # that is our shim
  return $found.Source
}

function Invoke-Apply {
  if (-not (Get-Command pi-bolt -ErrorAction SilentlyContinue)) {
    Write-Error 'pi-swap: pi-bolt is not on PATH; nothing to swap in.'
    exit 1
  }
  New-Item -ItemType Directory -Force -Path $AgentBin | Out-Null

  # Preserve any real `pi` launcher that is not already our shim. There are two
  # places one can be: already in AgentBin under our name, or elsewhere on PATH
  # (npm installs pi into %APPDATA%\npm), where our shim will shadow it once
  # AgentBin comes first.
  $preserved = $false
  if ((Test-Path -LiteralPath $PiShim) -and -not (Test-IsShim $PiShim)) {
    if (Test-PlausibleLauncher $PiShim) {
      Copy-Item -LiteralPath $PiShim -Destination $PiReal -Force
      Write-Output "pi-swap: preserved the existing launcher as $PiReal"
      $preserved = $true
    } else {
      Write-Warning "pi-swap: $PiShim is empty; not preserving it as $PiReal"
    }
  }
  if (-not $preserved -and -not (Test-Path -LiteralPath $PiReal)) {
    $real = Find-RealPi
    if ($real) {
      # A wrapper rather than a copy: an npm .cmd launcher resolves its own
      # directory with %~dp0, which breaks the moment it is relocated.
      $body = @(
        '@echo off',
        "rem $Marker - the real pi launcher, preserved by pi-swap.ps1",
        "`"$real`" %*",
        'exit /b %ERRORLEVEL%'
      )
      Set-Content -LiteralPath $PiReal -Value $body -Encoding ASCII
      Write-Output "pi-swap: preserved $real as $PiReal"
      $preserved = $true
    }
  }

  Set-Content -LiteralPath $PiShim -Value (Get-ShimBody) -Encoding ASCII
  Write-Output "pi-swap: wrote $PiShim"

  if ($SkipPath) {
    Write-Output "pi-swap: PI_SWAP_SKIP_PATH=1 - left your user PATH alone (add $AgentBin yourself)"
  } else {
    switch (Add-AgentBinToPath) {
      'added' {
        Set-Content -LiteralPath $State -Value "added-agent-bin-to-path" -Encoding ASCII
        Write-Output "pi-swap: added $AgentBin to your user PATH (new terminals pick it up)"
      }
      'present' { Write-Output "pi-swap: $AgentBin is already on your user PATH" }
      default   { Write-Warning "pi-swap: left your user PATH unchanged; add $AgentBin yourself" }
    }
  }

  Write-Output 'pi-swap: applied - `pi` now runs pi-bolt'
  Write-Output "  revert: $BoltHome\pi-swap.ps1 remove"
}

function Invoke-Remove {
  if (Test-IsShim $PiShim) {
    if (Test-Path -LiteralPath $PiReal) {
      Move-Item -LiteralPath $PiReal -Destination $PiShim -Force
      Write-Output "pi-swap: restored $PiShim from $PiReal"
    } else {
      Remove-Item -LiteralPath $PiShim -Force
      Write-Output "pi-swap: removed the shim (no previous launcher to restore)"
    }
  } elseif (Test-Path -LiteralPath $PiShim) {
    Write-Output "pi-swap: $PiShim is not the shim (already reverted or replaced) - leaving it"
  } else {
    Write-Output "pi-swap: no shim at $PiShim"
  }

  if ((Test-Path -LiteralPath $State) -and -not $SkipPath) {
    if ((Get-Content -LiteralPath $State -Raw).Trim() -eq 'added-agent-bin-to-path') {
      Remove-AgentBinFromPath | Out-Null
      Write-Output "pi-swap: removed $AgentBin from your user PATH"
    }
  }
  if (Test-Path -LiteralPath $State) { Remove-Item -LiteralPath $State -Force }

  Write-Output 'pi-swap: removed - `pi` no longer runs pi-bolt'
}

function Invoke-Status {
  $resolved = (Get-Command pi -ErrorAction SilentlyContinue)
  '{0,-30} {1}' -f 'pi resolves to:', ($(if ($resolved) { $resolved.Source } else { '(not found)' }))
  '{0,-30} {1}' -f 'swap:', ($(if (Test-IsShim $PiShim) { "APPLIED ($PiShim is the shim)" } else { "not applied ($PiShim is not the shim)" }))
  '{0,-30} {1}' -f 'previous launcher preserved:', ($(if (Test-Path -LiteralPath $PiReal) { $PiReal } else { 'no - nothing to restore' }))
  '{0,-30} {1}' -f "$AgentBin on user PATH:", ($(if ($SkipPath) { 'skipped (PI_SWAP_SKIP_PATH=1)' } elseif (Test-PathHasAgentBin) { 'yes' } else { 'no' }))
  Write-Output ''
  $piOut = & cmd /c "pi --version 2>&1" 2>$null | Select-Object -First 1
  '{0,-30} {1}' -f 'pi --version:', $(if ($piOut) { $piOut } else { '(failed)' })
  $realOut = & cmd /c "pi-real --version 2>&1" 2>$null | Select-Object -First 1
  '{0,-30} {1}' -f 'pi-real --version:', $(if ($realOut) { $realOut } else { '(not installed)' })
  # A bare `& pi-bolt` throws under $ErrorActionPreference = 'Stop', so status
  # has to ask whether it exists before it reports what it says.
  $boltOut = if (Get-Command pi-bolt -ErrorAction SilentlyContinue) { & pi-bolt --version 2>&1 | Select-Object -First 1 } else { $null }
  '{0,-30} {1}' -f 'pi-bolt --version:', $(if ($boltOut) { $boltOut } else { '(not installed)' })
}

switch ($Action.ToLower()) {
  'apply'   { Invoke-Apply }
  'remove'  { Invoke-Remove }
  'status'  { Invoke-Status }
  default {
    Write-Output 'usage: pi-swap.ps1 [apply|remove|status]'
    exit 2
  }
}
