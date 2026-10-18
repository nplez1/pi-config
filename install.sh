#!/usr/bin/env bash
#
# install.sh — put this repo's pi config into $HOME.
#
# Two kinds of file:
#
#   portable  symlinked into place. Editing the live file edits this repo.
#   seeded    copied only if the target does not exist, then owned by the
#             machine. `settings.json` and `advisor.json` are seeded because
#             they hold account-specific values (which models you have, the
#             default model, the advisor's model) that legitimately differ per
#             machine. Run `./install.sh capture` to publish the non-account
#             parts of those files back into the repo.
#
# Nothing is deleted: an existing real file is moved to
# `<target>.pre-pi-config-<timestamp>`.
#
# Usage:
#   ./install.sh              link + seed, fetch submodules, npm install plugins,
#                             then install/compile Pi-Bolt and swap `pi` to it
#   ./install.sh --dry-run    print what would happen, change nothing
#   ./install.sh capture      copy the live settings/advisor back, minus account keys
#   ./install.sh uninstall    remove symlinks that point into this repo
#
# Env: PI_CONFIG_SKIP_PLUGINS=1  skip submodule fetch + npm install (offline test)
#      PI_CONFIG_SKIP_PIBOLT=1   skip installing/compiling/swapping Pi-Bolt (offline test)
#
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODE="install"
case "${1:-}" in
  --dry-run) MODE="dry-run" ;;
  capture) MODE="capture" ;;
  uninstall) MODE="uninstall" ;;
  "") ;;
  *) echo "unknown argument: $1" >&2; exit 2 ;;
esac

STAMP="$(date +%Y%m%d-%H%M%S)"
CHANGED=0
# Backups live in their own tree, NEVER next to the target: `~/.agents/skills`
# and `~/.pi/agent/agents` are scanned for `*/SKILL.md` and `*.md`, so a
# `<name>.pre-pi-config-*` sibling would be re-discovered as a duplicate skill
# or agent. Flattened to `<path with / as __>` so nothing looks like a resource.
BACKUP_ROOT="$HOME/.pi-config-backups"
flatten() { local rel="${1#"$HOME"/}"; printf '%s' "${rel//\//__}"; }
backup_slot() {
  local dir="$BACKUP_ROOT/$STAMP"
  [ "$MODE" = "dry-run" ] || mkdir -p "$dir"
  printf '%s/%s' "$dir" "$(flatten "$1")"
}

# ---- portable files: symlink -------------------------------------------------

link() {
  local rel="$1" dst="$2" src="$REPO/$1"
  if [ ! -e "$src" ]; then echo "  skip     $rel (missing in repo)"; return; fi
  if [ -L "$dst" ] && [ "$(readlink "$dst")" = "$src" ]; then echo "  ok       $dst"; return; fi
  if [ ! -w "$(dirname "$dst")" ]; then
    echo "  SKIP     $dst (parent not writable)"; return
  fi
  [ "$MODE" = "dry-run" ] || mkdir -p "$(dirname "$dst")"
  if [ -L "$dst" ]; then
    echo "  relink   $dst  (was -> $(readlink "$dst"))"
    if [ "$MODE" != "dry-run" ] && ! rm -f "$dst" 2>/dev/null; then
      echo "  SKIP     $dst (cannot remove existing symlink)"; return
    fi
  elif [ -e "$dst" ]; then
    local bak; bak="$(backup_slot "$dst")"
    # macOS refuses to rename a directory the user does not own even from a
    # writable parent (the root-owned Orca-installed skills), so treat a failed
    # move as "leave it alone", not a fatal error.
    if [ "$MODE" != "dry-run" ] && ! mv "$dst" "$bak" 2>/dev/null; then
      echo "  SKIP     $dst (cannot move aside; owned by another user — needs sudo)"; return
    fi
    echo "  backup   $dst -> $bak"
  fi
  echo "  link     $dst -> $src"
  if [ "$MODE" != "dry-run" ] && ! ln -s "$src" "$dst" 2>/dev/null; then
    echo "  SKIP     $dst (cannot create symlink)"; return
  fi
  CHANGED=$((CHANGED + 1))
}

# ---- machine-owned files: seed once -----------------------------------------

seed() {
  local rel="$1" dst="$2" src="$REPO/$1"
  [ -e "$src" ] || { echo "  skip     $rel (missing in repo)"; return; }
  if [ ! -e "$dst" ] && [ ! -L "$dst" ] && [ ! -w "$(dirname "$dst")" ]; then
    echo "  SKIP     $dst (parent not writable)"; return
  fi
  [ "$MODE" = "dry-run" ] || mkdir -p "$(dirname "$dst")"
  if [ -L "$dst" ]; then
    # Left over from an earlier all-symlink layout: become machine-owned.
    echo "  convert  $dst (symlink -> local copy)"
    if [ "$MODE" != "dry-run" ] && ! { rm -f "$dst" && cp "$src" "$dst"; } 2>/dev/null; then
      echo "  SKIP     $dst (cannot convert)"; return
    fi
    CHANGED=$((CHANGED + 1))
  elif [ -e "$dst" ]; then
    echo "  keep     $dst (machine-owned; use 'capture' to publish changes)"
  else
    if [ "$MODE" != "dry-run" ] && ! cp "$src" "$dst" 2>/dev/null; then
      echo "  SKIP     $dst (cannot write; needs sudo)"; return
    fi
    echo "  seed     $dst (copy of $rel)"
    CHANGED=$((CHANGED + 1))
  fi
}

unlink_one() {
  local dst="$1"
  if [ ! -L "$dst" ]; then [ -e "$dst" ] && echo "  keep     $dst (not a symlink)"; return; fi
  local cur; cur="$(readlink "$dst")"
  case "$cur" in "$REPO"/*) ;; *) echo "  keep     $dst (points elsewhere: $cur)"; return ;; esac
  echo "  unlink   $dst"
  [ "$MODE" = "dry-run" ] || rm -f "$dst"
  local name; name="$(flatten "$dst")"
  local bak; bak="$(ls -1dt "$BACKUP_ROOT"/*/"$name" 2>/dev/null | head -1 || true)"
  if [ -n "$bak" ]; then
    echo "  restore  $bak -> $dst"
    [ "$MODE" = "dry-run" ] || mv "$bak" "$dst"
  fi
  CHANGED=$((CHANGED + 1))
}

# repo-relative path <TAB> absolute target
portable_targets() {
  printf '%s\t%s\n' \
    "dot-pi/agent/models.json"             "$HOME/.pi/agent/models.json" \
    "dot-pi/agent/AGENTS.md"               "$HOME/.pi/agent/AGENTS.md" \
    "dot-pi/agent/subagents.json"          "$HOME/.pi/agent/subagents.json" \
    "dot-pi/web-search.json"               "$HOME/.pi/web-search.json" \
    "dot-config/rpiv-todo/config.json"     "$HOME/.config/rpiv-todo/config.json"
  local f
  for f in "$REPO"/dot-pi/agent/agents/*; do
    [ -e "$f" ] || continue
    printf '%s\t%s\n' "dot-pi/agent/agents/$(basename "$f")" "$HOME/.pi/agent/agents/$(basename "$f")"
  done
  for f in "$REPO"/dot-pi/agent/extensions/*; do
    [ -e "$f" ] || continue
    printf '%s\t%s\n' "dot-pi/agent/extensions/$(basename "$f")" "$HOME/.pi/agent/extensions/$(basename "$f")"
  done
  # Only skills this repo ships. Skills installed and managed locally (Orca's
  # orca-cli / orchestration / computer-use) are deliberately not here, and
  # neither is ~/.agents/.skill-lock.json, which is per-machine install state.
  for d in "$REPO"/dot-agents/skills/*/; do
    [ -e "$d/SKILL.md" ] || continue
    local name; name="$(basename "$d")"
    # Link the skill directory, not SKILL.md inside it: some skill dirs are
    # root-owned (installed by another tool), and we can still replace the dir
    # from its writable parent while we could not write inside it.
    printf '%s\t%s\n' "dot-agents/skills/$name" "$HOME/.agents/skills/$name"
  done
}

seed_targets() {
  printf '%s\t%s\n' \
    "dot-pi/agent/settings.json"            "$HOME/.pi/agent/settings.json" \
    "dot-pi/agent/pi-system-one.json"       "$HOME/.pi/agent/pi-system-one.json" \
    "dot-config/rpiv-advisor/advisor.json"  "$HOME/.config/rpiv-advisor/advisor.json"
}

# ---- capture: publish the non-account parts of the seeded files --------------

capture() {
  command -v node >/dev/null 2>&1 || { echo "capture needs node on PATH" >&2; exit 1; }
  node - "$REPO" <<'NODE'
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const repo = process.argv[2];
const home = os.homedir();
// Account-specific keys are stripped before writing the repo seed, so a
// machine's model choices never leak into the shared config.
const jobs = [
  {
    live: path.join(home, ".pi/agent/settings.json"),
    seed: path.join(repo, "dot-pi/agent/settings.json"),
    strip: ["defaultProvider", "defaultModel", "enabledModels", "lastChangelogVersion"],
  },
  {
    live: path.join(home, ".config/rpiv-advisor/advisor.json"),
    seed: path.join(repo, "dot-config/rpiv-advisor/advisor.json"),
    strip: ["modelKey", "compressorModelKey"],
  },
  {
    // Seeded, not linked: /so config rewrites this file with an atomic rename,
    // which would replace a symlink with a real file and silently drop the edit.
    live: path.join(home, ".pi/agent/pi-system-one.json"),
    seed: path.join(repo, "dot-pi/agent/pi-system-one.json"),
    strip: [],
  },
];
// Absolute paths into this clone's pi-bolt/ become the clone-independent form the
// ~/.pi/agent/pi-bolt-bundles symlink resolves (same trick as plugins/<name>).
const bundlePrefix = path.join(repo, "pi-bolt") + path.sep;
const toPortableBundles = (entries) =>
  entries.map((e) =>
    typeof e === "string" && e.startsWith(bundlePrefix)
      ? "pi-bolt-bundles/" + e.slice(bundlePrefix.length)
      : e,
  );
for (const job of jobs) {
  if (!fs.existsSync(job.live)) { console.log(`  skip     ${job.live} (missing)`); continue; }
  const live = JSON.parse(fs.readFileSync(job.live, "utf8"));
  const seed = JSON.parse(fs.readFileSync(job.seed, "utf8"));
  // Start from the live file so shared additions flow in, then drop account keys.
  for (const key of job.strip) delete live[key];
  const merged = { ...seed, ...live };
  if (Array.isArray(merged.piBolt?.packages)) {
    merged.piBolt.packages = toPortableBundles(merged.piBolt.packages);
  }
  fs.writeFileSync(job.seed, JSON.stringify(merged, null, 2) + "\n");
  console.log(`  capture  ${job.live} -> ${path.relative(repo, job.seed)}  (stripped: ${job.strip.join(", ")})`);
}
NODE
}

# ---- run --------------------------------------------------------------------

echo "repo: $REPO"
echo "mode: $MODE"
echo

if [ "$MODE" = "capture" ]; then
  echo "Publishing shared settings back to the repo (account keys stripped):"
  capture
  echo
  echo "Review with: git -C \"$REPO\" diff"
  exit 0
fi

if [ "$MODE" = "uninstall" ]; then
  echo "Removing symlinks that point into this repo:"
  while IFS=$'\t' read -r _rel dst; do unlink_one "$dst"; done < <(portable_targets)
  unlink_one "$HOME/.pi/agent/plugins"
  unlink_one "$HOME/.pi/agent/pi-bolt-bundles"
  echo
  echo "Done ($CHANGED change(s)). Seeded files (settings.json, pi-system-one.json,"
  echo "advisor.json) are left in place, and \`pi\` still runs Pi-Bolt — revert that"
  echo "separately with $REPO/pi-bolt/pi-swap.sh remove."
  exit 0
fi

echo "Portable files (symlinked):"
while IFS=$'\t' read -r rel dst; do link "$rel" "$dst"; done < <(portable_targets)

echo
echo "Machine-owned files (seeded once, never overwritten):"
while IFS=$'\t' read -r rel dst; do seed "$rel" "$dst"; done < <(seed_targets)

echo
echo "Plugins directory (settings.json references plugins/<name>):"
dst="$HOME/.pi/agent/plugins"; src="$REPO/plugins"
[ "$MODE" = "dry-run" ] || mkdir -p "$(dirname "$dst")"
if [ -L "$dst" ] && [ "$(readlink "$dst")" = "$src" ]; then
  echo "  ok       $dst"
else
  if [ -e "$dst" ] && [ ! -L "$dst" ]; then
    bak="$(backup_slot "$dst")"
    if [ "$MODE" != "dry-run" ] && ! mv "$dst" "$bak" 2>/dev/null; then echo "  SKIP     $dst (cannot move aside)"; else echo "  backup   $dst -> $bak"; fi
  elif [ -L "$dst" ]; then
    echo "  relink   $dst -> $src"; [ "$MODE" = "dry-run" ] || rm -f "$dst" 2>/dev/null || true
  fi
  echo "  link     $dst -> $src"
  if [ "$MODE" != "dry-run" ] && ! ln -s "$src" "$dst" 2>/dev/null; then
    echo "  SKIP     $dst (cannot create symlink)"
  else
    CHANGED=$((CHANGED + 1))
  fi
fi

echo
echo "Pi-Bolt bundles directory (piBolt.packages references pi-bolt-bundles/<name>):"
dst="$HOME/.pi/agent/pi-bolt-bundles"; src="$REPO/pi-bolt"
[ "$MODE" = "dry-run" ] || mkdir -p "$(dirname "$dst")"
if [ -L "$dst" ] && [ "$(readlink "$dst")" = "$src" ]; then
  echo "  ok       $dst"
else
  if [ -e "$dst" ] && [ ! -L "$dst" ]; then
    bak="$(backup_slot "$dst")"
    if [ "$MODE" != "dry-run" ] && ! mv "$dst" "$bak" 2>/dev/null; then echo "  SKIP     $dst (cannot move aside)"; else echo "  backup   $dst -> $bak"; fi
  elif [ -L "$dst" ]; then
    echo "  relink   $dst -> $src"; [ "$MODE" = "dry-run" ] || rm -f "$dst" 2>/dev/null || true
  fi
  echo "  link     $dst -> $src"
  if [ "$MODE" != "dry-run" ] && ! ln -s "$src" "$dst" 2>/dev/null; then
    echo "  SKIP     $dst (cannot create symlink)"
  else
    CHANGED=$((CHANGED + 1))
  fi
fi

if [ "$MODE" = "install" ] && [ "${PI_CONFIG_SKIP_PLUGINS:-0}" != "1" ]; then
  echo
  echo "Fetching plugin submodules:"
  # Non-fatal: a fork commit that was never pushed, or a network hiccup, must not
  # abort the rest of the install (pi config and Pi-Bolt still work without it).
  if ! git -C "$REPO" submodule update --init --recursive; then
    echo "  WARN     submodule update failed — a plugin source may be missing; continuing"
  fi
  echo
  echo "Installing plugin dependencies:"
  for p in "$REPO"/plugins/*/; do
    [ -f "$p/package.json" ] || continue
    echo "  npm install  $(basename "$p")"
    # Only real dependencies: --omit=dev skips test/build tooling, and
    # --legacy-peer-deps stops npm from installing its own copies of the
    # host-provided pi packages (which the loader aliases anyway).
    (cd "$p" && npm install --omit=dev --legacy-peer-deps --no-audit --no-fund)
  done
fi

# pi's own bundle is patched after install too: the /model picker gets friendly
# model names and ←/→ reasoning levels. `pi update`/npm replaces the bundle, so
# re-run this (or just start pi — the pi-picker-patch-guard extension heals it).
echo
echo "pi bundle patches (patches/README.md):"
if [ "$MODE" = "dry-run" ]; then
  node "$REPO/patches/model-picker.mjs" --check --no-write | sed 's/^/  /' || true
else
  node "$REPO/patches/model-picker.mjs" | sed 's/^/  /' || echo "  SKIP     could not patch the pi bundle (see patches/README.md)"
fi

# pi-bolt shares ~/.pi/agent with pi, so the seeded settings already declare its
# packages. This makes the machine match them: binary present, packages
# materialized, bundles rebuilt from this clone, the compile set compiled in, and
# `pi` swapped to run pi-bolt. Every step degrades to a printed SKIP rather than
# failing the install.
echo
echo "Pi-Bolt:"
if [ "${PI_CONFIG_SKIP_PIBOLT:-0}" = "1" ]; then
  echo "  skip     PI_CONFIG_SKIP_PIBOLT=1"
elif [ "$MODE" = "dry-run" ]; then
  echo "  would    install pi-bolt if missing (official installer, unattended)"
  echo "  would    pi-bolt update --extensions"
  echo "  would    $REPO/pi-bolt/rebuild.sh --force"
  echo "  would    pi-bolt compile --only $(paste -sd, "$REPO/pi-bolt/compile-set.txt")"
  echo "  would    $REPO/pi-bolt/pi-swap.sh apply"
else
  if command -v pi-bolt >/dev/null 2>&1; then
    echo "  ok       pi-bolt $(pi-bolt --version 2>/dev/null | head -1)"
  elif curl -fsSL https://pi-bolt.opensec.in/install.sh | PIBOLT_YES=1 PIBOLT_EXTENSIONS=no sh; then
    echo "  install  pi-bolt (official installer)"
  else
    echo "  SKIP     pi-bolt install failed; leaving pi as it is"
  fi

  if command -v pi-bolt >/dev/null 2>&1; then
    if pi-bolt update --extensions >/dev/null 2>&1; then echo "  ok       packages materialized"; else echo "  SKIP     pi-bolt update --extensions failed"; fi

    if ! command -v bun >/dev/null 2>&1; then
      echo "  SKIP     bundles need bun on PATH (pi-bolt loads the unbuilt forks)"
    elif "$REPO/pi-bolt/rebuild.sh" --force >/dev/null; then
      echo "  ok       bundles rebuilt"
    else
      echo "  SKIP     bundle rebuild failed (pi-bolt loads the unbuilt forks)"
    fi

    compile_set="$(paste -sd, "$REPO/pi-bolt/compile-set.txt")"
    if pi-bolt compile --only "$compile_set" >/dev/null 2>&1; then echo "  ok       compiled in: $compile_set"; else echo "  SKIP     compile failed (extensions still load from files)"; fi

    if "$REPO/pi-bolt/pi-swap.sh" apply >/dev/null 2>&1; then
      echo "  ok       pi now runs pi-bolt (revert: $REPO/pi-bolt/pi-swap.sh remove)"
    else
      echo "  SKIP     could not swap pi (is pi installed?)"
    fi
  fi
fi

echo
echo "Done ($CHANGED change(s))."
cat <<'EOF'

Next steps:
  1. Credentials — this repo intentionally ships none:
       • export any env var models.json references, e.g. OMLX_API_KEY
       • run `pi` and /login for the providers THIS machine has
  2. Pick a default model for this machine: `pi`, then /model.
     settings.json is machine-owned, so that choice stays local.
  3. Restart pi; `pi list` should show the plugins under ~/.pi/agent/plugins.
  4. `pi` now runs Pi-Bolt (pi-config/pi-bolt/README.md). `pi-real` or
     `PI_REAL=1 pi` reaches the stock launcher; revert with
     pi-config/pi-bolt/pi-swap.sh remove. Credentials are shared.
EOF
