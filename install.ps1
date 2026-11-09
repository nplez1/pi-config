#Requires -Version 5.1
<#
.SYNOPSIS
  install.ps1 - Windows port of install.sh: put this repo's pi config into $HOME.

.DESCRIPTION
  Mirrors install.sh's two kinds of file:

    portable  linked into place. Editing the live file edits this repo.
    seeded    copied only if the target does not exist, then owned by the
              machine (settings.json, subagents.json, model-roles.json,
              advisor.json, pi-system-one.json hold account-specific values).

  Nothing is deleted: an existing real file is moved to
  %USERPROFILE%\.pi-config-backups\<stamp>\<flattened path>.

  Windows differences from install.sh, all printed as SKIP/note at run time:
    * Links are real symlinks when the process can make them (Developer Mode or
      an elevated prompt); otherwise a directory junction, then a hardlink, then
      a copy. The chosen mechanism is printed per target.
    * Homebrew is not available; fd/ripgrep are installed with winget when it is
      present, and are otherwise reported as missing.
    * Bun is installed here too (winget Oven-sh.Bun, else npm -g bun) because the
      prebuilt pi-bolt bundles are built with it, and Windows has no shell hook
      to rebuild them later.
    * Windows runs this through install.cmd, not directly: the default
      `Set-ExecutionPolicy Restricted` refuses every .ps1, and install.cmd passes
      a per-process -ExecutionPolicy Bypass instead of changing the machine.
    * The Unix helper scripts (pi-bolt/rebuild.sh, pi-swap.sh, after-update.sh,
      deps-audit.sh) are bash. pi-bolt/rebuild.sh is replaced by
      pi-bolt/rebuild.ps1 (run it via pi-bolt/rebuild.cmd), which this script
      runs, and the bundle and build-input halves of after-update.sh are
      pi-bolt/after-update.ps1 (after-update.cmd), which the `pi` shim runs after
      every `pi update`; the dependency audit and the compile set stay Unix-only.
      pi-bolt is provisioned with its own official Windows installer instead of
      install.sh, and the `pi` swap is done by pi-swap.ps1.

.PARAMETER DryRun
  Print what would happen, change nothing.

.PARAMETER Mode
  install (default), capture, or uninstall.

.EXAMPLE
  .\install.ps1
  .\install.cmd            (what to use: the default execution policy refuses .ps1)
  .\install.cmd -DryRun
  .\install.ps1 capture
  .\install.ps1 uninstall

.NOTES
  Env: PI_CONFIG_SKIP_PLUGINS=1  skip submodule fetch + npm install
       PI_CONFIG_SKIP_PIBOLT=1   skip installing Pi-Bolt
       PI_CONFIG_SKIP_TOOLS=1    skip installing fd/ripgrep with winget
       PI_CONFIG_SKIP_BUNDLES=1  skip bun + the pi-bolt bundle rebuild
       PI_CONFIG_LINK_MODE       pin one link tier: symlink | hardlink | copy
                                 (tests, and a machine whose policy forbids one)
       PIBOLT_BUN                path to bun when it is not on PATH
#>
[CmdletBinding()]
param(
  [switch]$DryRun,
  [Parameter(Position = 0)][string]$ModeArg = 'install'
)

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
# Not a ValidateSet: the mode variable is reassigned to 'dry-run' below, and a
# ValidateSet on it rejects that assignment at run time.
$Mode = if ($DryRun) { 'dry-run' } else { $ModeArg }
if ($Mode -notin @('install', 'capture', 'uninstall', 'dry-run')) {
  Write-Error "unknown mode: $Mode (expected install, capture, uninstall, or -DryRun)"
  exit 2
}

$Repo = (Resolve-Path (Split-Path -Parent $MyInvocation.MyCommand.Path)).Path
$HomeDir = $env:USERPROFILE
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$BackupRoot = Join-Path $HomeDir '.pi-config-backups'
$script:Changed = 0
$script:Skips = 0
$script:Hardlinks = 0

function Write-Line($status, $message) {
  if ($status -eq 'SKIP' -or $status -eq 'WARN') { $script:Skips++ }
  '{0,-9}{1}' -f ($status + ' '), $message
}

function Get-Flattened([string]$path) {
  $rel = $path
  if ($path.StartsWith($HomeDir, [StringComparison]::OrdinalIgnoreCase)) {
    $rel = $path.Substring($HomeDir.Length).TrimStart('\')
  }
  return $rel -replace '[\\/]', '__'
}

function Get-BackupSlot([string]$target) {
  $dir = Join-Path $BackupRoot $Stamp
  if ($Mode -ne 'dry-run') { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  return Join-Path $dir (Get-Flattened $target)
}

function Test-IsLink([string]$path) {
  if (-not (Test-Path -LiteralPath $path)) { return $false }
  $item = Get-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
  if (-not $item) { return $false }
  if ([bool]($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { return $true }
  # A hardlink is the no-privilege fallback for a file and carries no reparse
  # point. PowerShell 5.1 still reports it as LinkType HardLink with the other
  # names in Target; without this a re-run sees it as a real file and moves it
  # into a new backup directory on every single run.
  return ($item.LinkType -eq 'HardLink')
}

function Get-LinkKind([string]$path) {
  $item = Get-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
  if ($item) { return $item.LinkType }
  return $null
}

function Get-LinkTarget([string]$path) {
  $item = Get-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
  if (-not $item) { return $null }
  if ($item.LinkTarget) { return $item.LinkTarget }
  # A hardlink can have many names; Target lists all of them, so joining them
  # would build a garbage path. One name is enough for display.
  if ($item.Target) { return (@($item.Target) | Select-Object -First 1) }
  return $null
}

# Does this link (or hardlink, which has no single target) point at $src? A
# multi-name hardlink lists every name, so any match counts.
function Test-LinkPointsAt([string]$path, [string]$src) {
  $item = Get-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
  if (-not $item) { return $false }
  foreach ($target in @($item.Target)) {
    if (-not $target) { continue }
    $resolved = Resolve-Path -LiteralPath $target -ErrorAction SilentlyContinue
    if ($resolved -and $resolved.Path -eq $src) { return $true }
  }
  return $false
}

# Create a link. Symlink needs privilege (Developer Mode or elevated); a
# directory junction and a file hardlink do not, and a copy always works.
# PI_CONFIG_LINK_MODE pins one tier - for tests, and for a machine whose policy
# forbids one of them: symlink | hardlink | copy. Directories use a junction on
# the hardlink tier, since a directory cannot be hardlinked.
function New-ConfigLink([string]$src, [string]$dst) {
  $isDir = Test-Path -LiteralPath $src -PathType Container
  $pinned = $script:LinkMode
  if (-not $pinned -or $pinned -eq 'symlink') {
    try { New-Item -ItemType SymbolicLink -Path $dst -Target $src -ErrorAction Stop | Out-Null; return 'symlink' } catch { }
  }
  if (-not $pinned -or $pinned -eq 'hardlink') {
    try {
      if ($isDir) {
        New-Item -ItemType Junction -Path $dst -Target $src -ErrorAction Stop | Out-Null
        return 'junction'
      }
      New-Item -ItemType HardLink -Path $dst -Target $src -ErrorAction Stop | Out-Null
      $script:Hardlinks++
      return 'hardlink'
    } catch { }
  }
  if (-not $pinned -or $pinned -eq 'copy') {
    try {
      if ($isDir) { Copy-Item -LiteralPath $src -Destination $dst -Recurse -Force -ErrorAction Stop }
      else        { Copy-Item -LiteralPath $src -Destination $dst -Force -ErrorAction Stop }
      return 'copy (edits will NOT reach the repo)'
    } catch { return $null }
  }
  return $null
}

function Invoke-Link([string]$rel, [string]$dst) {
  $src = Join-Path $Repo ($rel -replace '/', '\')
  if (-not (Test-Path -LiteralPath $src)) { Write-Line 'skip' "$rel (missing in repo)"; return }
  if (Test-LinkPointsAt $dst $src) {
    Write-Line 'ok' $dst; return
  }
  $parent = Split-Path -Parent $dst
  if ($Mode -ne 'dry-run') { New-Item -ItemType Directory -Force -Path $parent | Out-Null }

  if (Test-IsLink $dst) {
    if ((Get-LinkKind $dst) -eq 'HardLink') {
      # Not our link (ours returned above). A hardlink shares its bytes with
      # another name, so dropping this name is not the harmless operation that
      # dropping a symlink is: keep a copy first.
      $bak = Get-BackupSlot $dst
      if ($Mode -ne 'dry-run') {
        try { Copy-Item -LiteralPath $dst -Destination $bak -Force -ErrorAction Stop }
        catch { Write-Line 'SKIP' "$dst (cannot back up a foreign hardlink: $($_.Exception.Message))"; return }
        Write-Line 'backup' "$dst -> $bak (was a hardlink to $(Get-LinkTarget $dst))"
        Remove-Item -LiteralPath $dst -Force -ErrorAction SilentlyContinue
      } else { Write-Line 'would' "backup $dst (hardlink to $(Get-LinkTarget $dst))" }
    } else {
      Write-Line 'relink' "$dst (was -> $(Get-LinkTarget $dst))"
      if ($Mode -ne 'dry-run') { Remove-Item -LiteralPath $dst -Force -Recurse -ErrorAction SilentlyContinue }
    }
  } elseif (Test-Path -LiteralPath $dst) {
    $bak = Get-BackupSlot $dst
    if ($Mode -ne 'dry-run') {
      try { Move-Item -LiteralPath $dst -Destination $bak -ErrorAction Stop; Write-Line 'backup' "$dst -> $bak" }
      catch { Write-Line 'SKIP' "$dst (cannot move aside: $($_.Exception.Message))"; return }
    } else { Write-Line 'would' "backup $dst" }
  }

  if ($Mode -eq 'dry-run') { Write-Line 'would' "link $dst -> $src"; $script:Changed++; return }
  $how = New-ConfigLink $src $dst
  if ($how) { Write-Line 'link' "$dst -> $src  [$how]"; $script:Changed++ }
  else { Write-Line 'SKIP' "$dst (cannot create link)" }
}

function Invoke-Seed([string]$rel, [string]$dst) {
  $src = Join-Path $Repo ($rel -replace '/', '\')
  if (-not (Test-Path -LiteralPath $src)) { Write-Line 'skip' "$rel (missing in repo)"; return }
  $parent = Split-Path -Parent $dst
  if ($Mode -ne 'dry-run') { New-Item -ItemType Directory -Force -Path $parent | Out-Null }

  if (Test-LinkPointsAt $dst $src) {
    Write-Line 'convert' "$dst (link -> local copy)"
    if ($Mode -ne 'dry-run') {
      Remove-Item -LiteralPath $dst -Force -ErrorAction SilentlyContinue
      Copy-Item -LiteralPath $src -Destination $dst -Force
      $script:Changed++
    }
  } elseif (Test-IsLink $dst) {
    # A link to something else - including a hardlink to a file outside this
    # repo - is the machine's own file. Converting it would delete the values it
    # holds, so leave it alone.
    Write-Line 'keep' "$dst (link to $(Get-LinkTarget $dst); use 'capture' to publish changes)"
  } elseif (Test-Path -LiteralPath $dst) {
    Write-Line 'keep' "$dst (machine-owned; use 'capture' to publish changes)"
  } else {
    if ($Mode -eq 'dry-run') { Write-Line 'would' "seed $dst (copy of $rel)"; $script:Changed++; return }
    try { Copy-Item -LiteralPath $src -Destination $dst -Force -ErrorAction Stop; Write-Line 'seed' "$dst (copy of $rel)"; $script:Changed++ }
    catch { Write-Line 'SKIP' "$dst (cannot write: $($_.Exception.Message))" }
  }
}

# repo-relative path -> absolute target
# Emits objects, not nested arrays: PowerShell unrolls nested arrays on return,
# which silently collapsed the per-file targets into their parent directory.
function New-Target($rel, $target) {
  [PSCustomObject]@{ Rel = $rel; Target = $target }
}

function Get-PortableTargets {
  $out = New-Object System.Collections.Generic.List[object]
  $out.Add((New-Target 'dot-pi/agent/models.json'                   '.pi/agent/models.json'))
  $out.Add((New-Target 'dot-pi/agent/AGENTS.md'                     '.pi/agent/AGENTS.md'))
  $out.Add((New-Target 'dot-pi/web-search.json'                     '.pi/web-search.json'))
  $out.Add((New-Target 'dot-config/rpiv-todo/config.json'           '.config/rpiv-todo/config.json'))
  $out.Add((New-Target 'dot-config/pi-smart-compaction/config.json' '.config/pi-smart-compaction/config.json'))

  foreach ($sub in @('dot-pi/agent/agents', 'dot-pi/agent/extensions')) {
    $dir = Join-Path $Repo ($sub -replace '/', '\')
    if (Test-Path -LiteralPath $dir) {
      $destDir = ($sub -replace '^dot-pi/', '.pi/')
      Get-ChildItem -LiteralPath $dir | ForEach-Object {
        $out.Add((New-Target "$sub/$($_.Name)" "$destDir/$($_.Name)"))
      }
    }
  }
  $skills = Join-Path $Repo 'dot-agents\skills'
  if (Test-Path -LiteralPath $skills) {
    Get-ChildItem -LiteralPath $skills -Directory | ForEach-Object {
      if (Test-Path (Join-Path $_.FullName 'SKILL.md')) {
        $out.Add((New-Target "dot-agents/skills/$($_.Name)" ".agents/skills/$($_.Name)"))
      }
    }
  }
  return $out
}

function Get-SeedTargets {
  $out = New-Object System.Collections.Generic.List[object]
  $out.Add((New-Target 'dot-pi/agent/settings.json'            '.pi/agent/settings.json'))
  $out.Add((New-Target 'dot-pi/agent/pi-system-one.json'       '.pi/agent/pi-system-one.json'))
  $out.Add((New-Target 'dot-pi/agent/subagents.json'           '.pi/agent/subagents.json'))
  $out.Add((New-Target 'dot-config/pi-config/model-roles.json' '.config/pi-config/model-roles.json'))
  $out.Add((New-Target 'dot-config/rpiv-advisor/advisor.json'  '.config/rpiv-advisor/advisor.json'))
  return $out
}

# ---------------------------------------------------------------- capture ----
function Invoke-Capture {
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error 'capture needs node on PATH'
    exit 1
  }
  $js = @'
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const repo = process.argv[2];
const home = os.homedir();
const jobs = [
  { live: path.join(home, ".pi/agent/settings.json"),
    seed: path.join(repo, "dot-pi/agent/settings.json"),
    strip: ["defaultProvider","defaultModel","enabledModels","lastChangelogVersion"] },
  { live: path.join(home, ".pi/agent/subagents.json"),
    seed: path.join(repo, "dot-pi/agent/subagents.json"),
    strip: [],
    transform: (live) => {
      const overrides = live.agentOverrides ?? {};
      for (const [name, override] of Object.entries(overrides)) {
        if (!override || typeof override !== "object") continue;
        delete override.model; delete override.thinking;
        if (Object.keys(override).length === 0) delete overrides[name];
      }
      live.agentOverrides = overrides;
    } },
  { live: path.join(home, ".config/pi-config/model-roles.json"),
    seed: path.join(repo, "dot-config/pi-config/model-roles.json"),
    strip: [],
    transform: (live) => { for (const k of Object.keys(live)) live[k] = Array.isArray(live[k]) ? [] : null; } },
  { live: path.join(home, ".config/rpiv-advisor/advisor.json"),
    seed: path.join(repo, "dot-config/rpiv-advisor/advisor.json"),
    strip: ["modelKey","compressorModelKey","effort","compressorEffort","disabledForModels"] },
  { live: path.join(home, ".pi/agent/pi-system-one.json"),
    seed: path.join(repo, "dot-pi/agent/pi-system-one.json"), strip: [] }
];
const bundlePrefix = path.join(repo, "pi-bolt") + path.sep;
const toPortableBundles = (entries) => entries.map((e) =>
  typeof e === "string" && e.startsWith(bundlePrefix)
    ? "pi-bolt-bundles/" + e.slice(bundlePrefix.length) : e);
for (const job of jobs) {
  if (!fs.existsSync(job.live)) { console.log(`  skip     ${job.live} (missing)`); continue; }
  const live = JSON.parse(fs.readFileSync(job.live, "utf8"));
  const seed = JSON.parse(fs.readFileSync(job.seed, "utf8"));
  for (const key of job.strip) delete live[key];
  if (typeof job.transform === "function") job.transform(live);
  const merged = { ...seed, ...live };
  for (const key of job.strip) delete merged[key];
  if (Array.isArray(merged.piBolt?.packages)) merged.piBolt.packages = toPortableBundles(merged.piBolt.packages);
  fs.writeFileSync(job.seed, JSON.stringify(merged, null, 2) + "\n");
  console.log(`  wrote    ${job.seed}`);
}
'@
  $tmp = Join-Path $env:TEMP 'pi-config-capture.js'
  Set-Content -LiteralPath $tmp -Value $js -Encoding UTF8
  & node $tmp $Repo
  # A capture that failed to parse a file must not read as success: it is the
  # one mode whose whole job is writing the repo's seed files.
  exit $LASTEXITCODE
}

# ------------------------------------------------------------- submodules ----
# `git submodule update --init --recursive` populates an *empty* submodule, but
# it will not touch one whose index has the tracked files staged as deleted -
# which is the state a half-finished submodule checkout leaves behind. The
# directory then holds nothing but a `.git` file, its `package.json` is missing,
# so the npm step below silently skips it and pi-bolt loads no plugin at all.
# Detect exactly that and reset the submodule's own index and worktree to its
# recorded HEAD. Committed work is untouched: this is `--hard` against the
# submodule's HEAD, not against the superproject.
function Repair-Submodule([string]$name) {
  $dir = Join-Path $Repo ("plugins/" + $name)
  if (-not (Test-Path -LiteralPath (Join-Path $dir '.git'))) { return }

  # Files the submodule's HEAD tracks; empty means the checkout is broken, not
  # merely dirty.
  $tracked = & git -C $dir ls-tree --name-only HEAD 2>$null
  if ($LASTEXITCODE -ne 0 -or -not $tracked) { return }

  $present = @(Get-ChildItem -LiteralPath $dir -Force -ErrorAction SilentlyContinue |
               Where-Object { $_.Name -ne '.git' })
  if ($present.Count -gt 0) { return }

  if ($Mode -eq 'dry-run') { Write-Line 'would' "reset $dir to its recorded HEAD (empty checkout)"; return }
  if ((& git -C $dir reset --hard HEAD 2>&1) -and $LASTEXITCODE -eq 0) {
    Write-Line 'repair' "$dir (was an empty checkout; reset to HEAD)"
    $script:Changed++
  } else {
    Write-Line 'WARN' "$dir is an empty checkout and could not be reset"
  }
}

# -------------------------------------------------------------- uninstall ----
function Invoke-Uninstall {
  Write-Output 'Removing links that point into this repo:'
  $all = New-Object System.Collections.Generic.List[object]
  foreach ($t in (Get-PortableTargets)) { $all.Add($t) }
  foreach ($t in (Get-SeedTargets)) { $all.Add($t) }
  $all.Add((New-Target 'plugins' '.pi/agent/plugins'))
  $all.Add((New-Target 'pi-bolt' '.pi/agent/pi-bolt-bundles'))
  foreach ($pair in $all) {
    $dst = Join-Path $HomeDir ($pair.Target -replace '/', '\')
    if (-not (Test-IsLink $dst)) { continue }
    $cur = Get-LinkTarget $dst
    # A bare prefix test would also match a sibling checkout such as
    # `pi-config-old`; require the separator.
    $repoRoot = $Repo.TrimEnd('\')
    $inRepo = $cur -and ($cur.TrimEnd('\') -ieq $repoRoot -or
      $cur.StartsWith($repoRoot + '\', [StringComparison]::OrdinalIgnoreCase))
    if ($inRepo) {
      Write-Line 'unlink' $dst
      if ($Mode -ne 'dry-run') { Remove-Item -LiteralPath $dst -Force -Recurse -ErrorAction SilentlyContinue }
      $script:Changed++
    } else { Write-Line 'keep' "$dst (points elsewhere: $cur)" }
  }
  Write-Output ''
  Write-Output 'Machine-owned files (settings.json, subagents.json, model-roles.json, advisor.json) are left in place.'
}

# ------------------------------------------------------------------ main -----
# Validate the tier before anything is linked: an unrecognised value would
# otherwise make New-ConfigLink return $null and SKIP every target.
$script:LinkMode = $env:PI_CONFIG_LINK_MODE
if ($script:LinkMode -and $script:LinkMode -notin @('symlink', 'hardlink', 'copy')) {
  Write-Line 'WARN' "unknown PI_CONFIG_LINK_MODE '$($script:LinkMode)'; using the default tiers"
  $script:LinkMode = $null
}

Write-Output "pi-config (Windows port) - repo: $Repo"
Write-Output "home: $HomeDir"
Write-Output "mode: $Mode"
Write-Output ''

if ($Mode -eq 'capture') { Invoke-Capture }   # exits with node's status
if ($Mode -eq 'uninstall') { Invoke-Uninstall; exit 0 }

Write-Output 'Portable files (linked):'
foreach ($pair in (Get-PortableTargets)) {
  Invoke-Link $pair.Rel (Join-Path $HomeDir ($pair.Target -replace '/', '\'))
}

Write-Output ''
Write-Output 'Machine-owned files (seeded once):'
foreach ($pair in (Get-SeedTargets)) {
  Invoke-Seed $pair.Rel (Join-Path $HomeDir ($pair.Target -replace '/', '\'))
}

Write-Output ''
Write-Output 'Plugins directory (settings.json references plugins/<name>):'
Invoke-Link 'plugins' (Join-Path $HomeDir '.pi\agent\plugins')

Write-Output ''
Write-Output 'Pi-Bolt bundles directory (piBolt.packages references pi-bolt-bundles/<name>):'
Invoke-Link 'pi-bolt' (Join-Path $HomeDir '.pi\agent\pi-bolt-bundles')

# ---- search tools: Homebrew's job on Unix -----------------------------------
Write-Output ''
Write-Output 'Search tools (fd, ripgrep):'
if ($env:PI_CONFIG_SKIP_TOOLS -eq '1') {
  Write-Line 'skip' 'PI_CONFIG_SKIP_TOOLS=1'
} else {
  $missing = @()
  if (-not (Get-Command fd -ErrorAction SilentlyContinue) -and
      -not (Get-Command fdfind -ErrorAction SilentlyContinue)) { $missing += 'fd' }
  if (-not (Get-Command rg -ErrorAction SilentlyContinue)) { $missing += 'ripgrep' }
  if (-not $missing.Count) {
    Write-Line 'ok' 'fd and ripgrep are on PATH'
  } elseif (Get-Command winget -ErrorAction SilentlyContinue) {
    if ($Mode -eq 'dry-run') {
      Write-Line 'would' "winget install $($missing -join ', ')"
    } else {
      foreach ($m in $missing) {
        $id = if ($m -eq 'fd') { 'sharkdp.fd' } else { 'BurntSushi.ripgrep.MSVC' }
        & winget install --id $id -e --silent --accept-package-agreements --accept-source-agreements 2>&1 | Out-Null
        if ($LASTEXITCODE -eq 0) { Write-Line 'install' "winget $id" }
        else { Write-Line 'SKIP' "winget $id exited $LASTEXITCODE; install $m yourself" }
      }
    }
  } else {
    Write-Line 'SKIP' "winget not available; install manually: $($missing -join ', ')"
  }
}

# ---- submodules + plugin npm -----------------------------------------------
if ($Mode -eq 'install' -and $env:PI_CONFIG_SKIP_PLUGINS -ne '1') {
  Write-Output ''
  Write-Output 'Fetching plugin submodules:'
  & git -C $Repo submodule update --init --recursive
  if ($LASTEXITCODE -ne 0) { Write-Line 'WARN' 'submodule update failed - a plugin source may be missing; continuing' }
  # A submodule can survive the update above with an empty worktree (see
  # Repair-Submodule). Check every plugin, not only the submodules: the forks
  # are gitlinks here, and one left empty costs its whole plugin at load time.
  Get-ChildItem -LiteralPath (Join-Path $Repo 'plugins') -Directory -ErrorAction SilentlyContinue |
    ForEach-Object { Repair-Submodule $_.Name }

  Write-Output ''
  Write-Output 'Installing plugin dependencies:'
  Get-ChildItem -LiteralPath (Join-Path $Repo 'plugins') -Directory -ErrorAction SilentlyContinue | ForEach-Object {
    if (Test-Path (Join-Path $_.FullName 'package.json')) {
      Write-Line 'npm' "install $($_.Name)"
      Push-Location $_.FullName
      & npm install --omit=dev --legacy-peer-deps --no-audit --no-fund --no-package-lock 2>&1 | Out-Null
      Pop-Location
    } else {
      Write-Line 'WARN' "$($_.Name) has no package.json - plugin source missing; skipping its dependencies"
    }
  }
} elseif ($Mode -eq 'dry-run') {
  Write-Output ''
  Write-Output 'Fetching plugin submodules:'
  Write-Line 'would' 'git submodule update --init --recursive'
  Write-Line 'would' 'reset any plugins/*/ that is an empty checkout back to its HEAD'
  Write-Line 'would' 'npm install --omit=dev in each plugins/*/ with a package.json'
}

# ---- pi-bolt ----------------------------------------------------------------
Write-Output ''
Write-Output 'Pi-Bolt:'
if ($env:PI_CONFIG_SKIP_PIBOLT -eq '1') {
  Write-Line 'skip' 'PI_CONFIG_SKIP_PIBOLT=1'
} elseif ($Mode -eq 'dry-run') {
  Write-Line 'would' 'install pi-bolt with its official Windows installer (install.ps1, unattended) if missing'
  Write-Line 'would' 'pi-bolt update --extensions'
  Write-Line 'would' 'npm install --save pi-web-access into ~/.pi/agent/npm (build input)'
  Write-Line 'would' 'install bun (winget Oven-sh.Bun, else npm -g bun)'
  Write-Line 'would' 'pi-bolt/rebuild.ps1 -Force, then -Check'
} else {
  $bolt = Get-Command pi-bolt -ErrorAction SilentlyContinue
  if (-not $bolt) {
    $candidate = Join-Path $HomeDir '.pi-bolt'
    if (Test-Path $candidate) {
      $exe = Get-ChildItem -LiteralPath $candidate -Recurse -Filter 'pi-bolt.exe' -ErrorAction SilentlyContinue |
             Sort-Object LastWriteTime -Descending | Select-Object -First 1
      if ($exe) { $env:PATH = "$($exe.DirectoryName);$env:PATH"; $bolt = Get-Command pi-bolt -ErrorAction SilentlyContinue }
    }
  }
  if ($bolt) {
    Write-Line 'ok' "pi-bolt $(& pi-bolt --version 2>&1 | Select-Object -First 1)"
  } else {
    $prevYes = $env:PIBOLT_YES; $prevExt = $env:PIBOLT_EXTENSIONS
    $env:PIBOLT_YES = '1'; $env:PIBOLT_EXTENSIONS = 'no'
    $installer = Join-Path $env:TEMP 'pi-bolt-install.ps1'
    try {
      # Run it as its own process. install.sh pipes it to a separate sh; doing
      # that with Invoke-Expression would run someone else's script in this
      # script's scope, where its `exit` ends this run halfway, its
      # $ErrorActionPreference / Set-StrictMode leak into every later step, and
      # its variables can overwrite $Repo and $HomeDir.
      Invoke-WebRequest -Uri 'https://pi-bolt.opensec.in/install.ps1' -UseBasicParsing -OutFile $installer -ErrorAction Stop
      & powershell -NoProfile -ExecutionPolicy Bypass -File $installer 2>&1 | Out-Null
      if ($LASTEXITCODE -eq 0) { Write-Line 'install' 'pi-bolt (official Windows installer)' }
      else { Write-Line 'SKIP' "pi-bolt installer exited $LASTEXITCODE" }
    } catch {
      Write-Line 'SKIP' "pi-bolt install failed: $($_.Exception.Message)"
    } finally {
      $env:PIBOLT_YES = $prevYes; $env:PIBOLT_EXTENSIONS = $prevExt
      Remove-Item -LiteralPath $installer -Force -ErrorAction SilentlyContinue
    }
    $exe = Get-ChildItem -LiteralPath (Join-Path $HomeDir '.pi-bolt') -Recurse -Filter 'pi-bolt.exe' -ErrorAction SilentlyContinue |
           Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($exe) { $env:PATH = "$($exe.DirectoryName);$env:PATH" }
  }

  if (Get-Command pi-bolt -ErrorAction SilentlyContinue) {
    & pi-bolt update --extensions 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) { Write-Line 'ok' 'packages materialized' }
    else { Write-Line 'SKIP' 'pi-bolt update --extensions failed' }

    # ---- bundles: the forks pi-bolt loads as prebuilt dist-bun/ ------------
    # pi-bolt's piBolt.packages points at pi-bolt-bundles/pi-bolt-subagents and
    # pi-bolt-bundles/pi-bolt-advisor-subagent, whose package.json entries are
    # `./dist-bun/index.js`. That build output is gitignored and per-machine, so
    # on a machine that has never built them the extension entry does not exist
    # and the plugin silently does not load. On Unix rebuild.sh is run by the
    # ~/.zshrc hook; Windows has no such hook, so it is done here.
    Write-Output ''
    Write-Output 'Pi-Bolt bundles (pi-bolt/rebuild.ps1):'
    if ($env:PI_CONFIG_SKIP_BUNDLES -eq '1') {
      Write-Line 'skip' 'PI_CONFIG_SKIP_BUNDLES=1'
    } else {
      # The web-access bundle wraps the published pi-web-access dist as its build
      # input, and piBolt.packages excludes that package (the bundle replaces
      # it), so nothing else would install it. It is saved as a dependency
      # rather than installed --no-save: npm prunes packages that are not in
      # package.json, and an update runs `npm install <specs>` in this tree,
      # which removes it along with the dependencies the built bundle requires
      # at run time.
      $npmRoot = Join-Path $HomeDir '.pi/agent/npm'
      $webAccessEntry = Join-Path $npmRoot 'node_modules/pi-web-access/dist/index.js'
      $webAccessSaved = ''
      if (Test-Path -LiteralPath (Join-Path $npmRoot 'package.json')) {
        Push-Location $npmRoot
        $webAccessSaved = (& npm pkg get dependencies.pi-web-access 2>$null | Out-String).Trim().Trim('"')
        Pop-Location
      }
      if ($webAccessSaved -in @('', '{}', 'undefined')) { $webAccessSaved = '' }
      if (-not (Test-Path -LiteralPath $webAccessEntry) -or -not $webAccessSaved) {
        Write-Line 'install' 'pi-web-access (build input for the web-access bundle)'
        & npm install --prefix $npmRoot --save --legacy-peer-deps --no-audit --no-fund pi-web-access 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) { Write-Line 'SKIP' 'could not install the web-access build input' }
      }

      # Bun is the bundle builder (Bun.build + native require), not an option.
      $bun = $null
      if ($env:PIBOLT_BUN) {
        if (Test-Path -LiteralPath $env:PIBOLT_BUN) { $bun = $env:PIBOLT_BUN }
        else {
          # rebuild.ps1 treats a bad PIBOLT_BUN as fatal; here it is only a hint.
          Write-Line 'WARN' "PIBOLT_BUN points at nothing ($env:PIBOLT_BUN); ignoring it"
          Remove-Item Env:\PIBOLT_BUN -ErrorAction SilentlyContinue
        }
      }
      if (-not $bun) {
        $bunCmd = Get-Command bun -ErrorAction SilentlyContinue
        if ($bunCmd) { $bun = $bunCmd.Source }
      }
      if (-not $bun) {
        Write-Line 'install' 'bun (needed to build the pi-bolt bundles)'
        # winget's package is the official standalone binary; the npm package is
        # a thin wrapper that downloads it in a postinstall script, which npm 11
        # gates behind --allow-scripts. Prefer winget, fall back to npm, and
        # treat a failure as a printed SKIP like every other optional step here.
        if (Get-Command winget -ErrorAction SilentlyContinue) {
          & winget install --id Oven-sh.Bun -e --silent --accept-package-agreements --accept-source-agreements 2>&1 | Out-Null
          if ($LASTEXITCODE -ne 0) { Write-Line 'WARN' "winget install Oven-sh.Bun exited $LASTEXITCODE" }
        } else {
          & npm install -g bun 2>&1 | Out-Null
          if ($LASTEXITCODE -ne 0) { Write-Line 'WARN' "npm install -g bun exited $LASTEXITCODE" }
        }
        # A winget install updates the machine PATH, which this process does not
        # inherit; look where it lands before giving up.
        $bunCmd = Get-Command bun -ErrorAction SilentlyContinue
        if ($bunCmd) { $bun = $bunCmd.Source }
        else {
          foreach ($candidate in @(
              (Join-Path $HomeDir '.bun\bin\bun.exe'),
              (Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links\bun.exe'))) {
            if (Test-Path -LiteralPath $candidate) { $bun = $candidate; break }
          }
        }
      }

      if (-not $bun) {
        Write-Line 'SKIP' 'bundles need bun on PATH (pi-bolt loads the unbuilt forks)'
      } else {
        $rebuild = Join-Path $Repo 'pi-bolt\rebuild.ps1'
        # Hand the bun we resolved to the child. On a fresh machine winget has
        # just installed it, so this process's inherited PATH does not have it
        # yet and rebuild.ps1 would answer "bun is required" - on the one run
        # where the bundles are guaranteed to be missing.
        $env:PIBOLT_BUN = $bun
        # The exit code is not proof: rebuild.mjs deliberately exits 0 when a
        # bundle fails so pi-bolt still starts. -Check is what actually knows,
        # and a stale bundle is only ever visible here.
        $rebuildLog = & powershell -NoProfile -ExecutionPolicy Bypass -File $rebuild -Force 2>&1
        $checkOk = $false
        if ($LASTEXITCODE -eq 0) {
          & powershell -NoProfile -ExecutionPolicy Bypass -File $rebuild -Check 2>&1 | Out-Null
          $checkOk = ($LASTEXITCODE -eq 0)
        }
        if ($checkOk) {
          Write-Line 'ok' 'bundles rebuilt'
        } else {
          Write-Line 'SKIP' 'bundle rebuild failed (pi-bolt loads the unbuilt forks)'
          $rebuildLog | ForEach-Object { Write-Output "         $_" }
          # Print the form that actually runs here. A bare .ps1 path is refused
          # outright under the default Restricted policy, so the hint has to
          # carry the bypass (or point at the .cmd wrapper) to be usable.
          Write-Line 'retry' "powershell -NoProfile -ExecutionPolicy Bypass -File `"$rebuild`" -Force -Verbose"
        }
      }
    }
  }
}

# ---- pi -> pi-bolt swap (pi-bolt/pi-swap.ps1) -------------------------------
# The Unix installer leaves this to pi-swap.sh; without it `pi` does not exist on
# Windows and Orca (which detects agents by CLI name) never sees Pi-Bolt.
Write-Output ''
Write-Output '`pi` -> pi-bolt swap (pi-bolt/pi-swap.ps1):'
$swap = Join-Path $Repo 'pi-bolt\pi-swap.ps1'
if ($env:PI_CONFIG_SKIP_PIBOLT -eq '1') {
  Write-Line 'skip' 'PI_CONFIG_SKIP_PIBOLT=1'
} elseif (-not (Test-Path -LiteralPath $swap)) {
  Write-Line 'SKIP' 'pi-bolt/pi-swap.ps1 is missing from this checkout'
} elseif ($Mode -eq 'dry-run') {
  Write-Line 'would' 'pi-swap.ps1 apply (make `pi` run pi-bolt)'
} else {
  & powershell -NoProfile -ExecutionPolicy Bypass -File $swap apply 2>&1 |
    ForEach-Object { Write-Line 'swap' $_ }
}

# ---- not ported -------------------------------------------------------------
Write-Output ''
Write-Output 'Unix-only steps (not ported to Windows):'
foreach ($item in @(
    'pi-bolt compile - unavailable: this build answers "compiling extensions in is not available on Windows yet"',
    'pi-bolt/deps-audit.sh - bash; pins undici and runs npm audit fix',
    'patches/model-picker.mjs - patches the pi bundle, which Windows does not install'
  )) { Write-Line 'skip' $item }

# The half of after-update.sh that does exist here, said out loud because a shim
# written before pi-bolt/after-update.cmd existed does nothing after an update -
# and `apply` above is what rewrites that shim.
Write-Line 'note' '`pi update` runs pi-bolt\after-update.cmd afterwards (bundles + the web-access build input)'

# `pi-bolt compile` is not merely unported - the Windows build refuses every
# mode, including --list and --status, and it exits 0 while doing so. A future
# edit that wired it in here would read as "ok" and change nothing, so the check
# is stated rather than implied. What it costs: extensions load from files, which
# is why the prebuilt dist-bun bundles above matter more here than on Unix - they
# are the only start-up lever this platform has.
#
# Guarded: this runs even when PI_CONFIG_SKIP_PIBOLT=1 or the install failed, and
# a bare `& pi-bolt` there writes "not recognized" noise onto a clean run.
$compileProbe = if (Get-Command pi-bolt -ErrorAction SilentlyContinue) { & pi-bolt compile --status 2>&1 | Out-String } else { '' }
if ($compileProbe -match 'not available on Windows') {
  Write-Line 'note' 'extensions load from files on Windows; the dist-bun bundles are the start-up lever'
}


Write-Output ''
Write-Output "Done. $($script:Changed) change(s), $($script:Skips) skip/warning(s)."
if ($script:Hardlinks -gt 0) {
  # A hardlink survives an in-place edit but not a replacement: git checkout and
  # pull write a new file, and an editor that saves by rename does the same. The
  # next run notices and repairs it, but until then the live file is a private
  # copy, so say so instead of leaving it to be discovered.
  Write-Output "$($script:Hardlinks) file(s) are hardlinked because this process cannot create symlinks:"
  Write-Output '  a git checkout/pull replaces the repo file and breaks the link - re-run install.cmd after a pull.'
}
if ($Mode -ne 'dry-run' -and $script:Changed -gt 0) {
  Write-Output 'Restart Pi-Bolt (or run /reload) to pick up the config.'
}
