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
#   ./install.sh              link + seed, fetch submodules, npm install plugins
#   ./install.sh --dry-run    print what would happen, change nothing
#   ./install.sh capture      copy the live settings/advisor back, minus account keys
#   ./install.sh uninstall    remove symlinks that point into this repo
#
# Env: PI_CONFIG_SKIP_PLUGINS=1  skip submodule fetch + npm install (offline test)
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
    local bak="$dst.pre-pi-config-$STAMP"
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
  local bak; bak="$(ls -1dt "$dst".pre-pi-config-* 2>/dev/null | head -1 || true)"
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
    "dot-config/rpiv-todo/config.json"     "$HOME/.config/rpiv-todo/config.json" \
    "dot-agents/.skill-lock.json"          "$HOME/.agents/.skill-lock.json"
  local f
  for f in "$REPO"/dot-pi/agent/agents/*; do
    [ -e "$f" ] || continue
    printf '%s\t%s\n' "dot-pi/agent/agents/$(basename "$f")" "$HOME/.pi/agent/agents/$(basename "$f")"
  done
  for f in "$REPO"/dot-pi/agent/extensions/*; do
    [ -e "$f" ] || continue
    printf '%s\t%s\n' "dot-pi/agent/extensions/$(basename "$f")" "$HOME/.pi/agent/extensions/$(basename "$f")"
  done
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
    strip: ["defaultProvider", "defaultModel", "enabledModels"],
  },
  {
    live: path.join(home, ".config/rpiv-advisor/advisor.json"),
    seed: path.join(repo, "dot-config/rpiv-advisor/advisor.json"),
    strip: ["modelKey", "compressorModelKey"],
  },
];
for (const job of jobs) {
  if (!fs.existsSync(job.live)) { console.log(`  skip     ${job.live} (missing)`); continue; }
  const live = JSON.parse(fs.readFileSync(job.live, "utf8"));
  const seed = JSON.parse(fs.readFileSync(job.seed, "utf8"));
  // Start from the live file so shared additions flow in, then drop account keys.
  for (const key of job.strip) delete live[key];
  const merged = { ...seed, ...live };
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
  echo
  echo "Done ($CHANGED change(s)). Seeded files (settings.json, advisor.json) are left in place."
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
    bak="$dst.pre-pi-config-$STAMP"
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
  git -C "$REPO" submodule update --init --recursive
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
EOF
