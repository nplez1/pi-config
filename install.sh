#!/usr/bin/env bash
#
# install.sh — symlink this repo's tracked pi config into $HOME.
#
# Every `dot-X/...` path in the repo maps to `~/.X/...`. Files are symlinked
# one by one (never a whole directory that holds untracked user files, e.g.
# `~/.pi/agent/extensions`, which may also contain Orca extensions that are not
# in this repo). Nothing is deleted: an existing real file is moved aside to
# `<target>.pre-pi-config-<timestamp>` so it can be restored by hand.
#
# Usage:
#   ./install.sh              install / refresh the symlinks, init submodules, npm install
#   ./install.sh --dry-run    print what would happen, change nothing
#   ./install.sh uninstall    remove symlinks that point into this repo, restore newest backup
#
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODE="install"
case "${1:-}" in
  --dry-run) MODE="dry-run" ;;
  uninstall) MODE="uninstall" ;;
  "") ;;
  *) echo "unknown argument: $1" >&2; exit 2 ;;
esac

STAMP="$(date +%Y%m%d-%H%M%S)"
CHANGED=0

# Symlink $REPO/<rel> to $dst.
link() {
  local rel="$1" dst="$2" src="$REPO/$1"
  if [ ! -e "$src" ]; then
    echo "  skip     $rel (missing in repo)"
    return
  fi
  [ "$MODE" = "dry-run" ] || mkdir -p "$(dirname "$dst")"
  if [ -L "$dst" ]; then
    local cur; cur="$(readlink "$dst")"
    if [ "$cur" = "$src" ]; then
      echo "  ok       $dst"
      return
    fi
    echo "  relink   $dst  (was -> $cur)"
    [ "$MODE" = "dry-run" ] || rm -f "$dst"
  elif [ -e "$dst" ]; then
    local bak="$dst.pre-pi-config-$STAMP"
    echo "  backup   $dst -> $bak"
    [ "$MODE" = "dry-run" ] || mv "$dst" "$bak"
  fi
  echo "  link     $dst -> $src"
  [ "$MODE" = "dry-run" ] || ln -s "$src" "$dst"
  CHANGED=$((CHANGED + 1))
}

# Remove a symlink that points into $REPO, restoring the newest backup if any.
unlink_one() {
  local dst="$1"
  if [ ! -L "$dst" ]; then
    [ -e "$dst" ] && echo "  keep     $dst (not a symlink)"
    return
  fi
  local cur; cur="$(readlink "$dst")"
  case "$cur" in
    "$REPO"/*) ;;
    *) echo "  keep     $dst (points elsewhere: $cur)"; return ;;
  esac
  echo "  unlink   $dst"
  [ "$MODE" = "dry-run" ] || rm -f "$dst"
  local bak; bak="$(ls -1dt "$dst".pre-pi-config-* 2>/dev/null | head -1 || true)"
  if [ -n "$bak" ]; then
    echo "  restore  $bak -> $dst"
    [ "$MODE" = "dry-run" ] || mv "$bak" "$dst"
  fi
  CHANGED=$((CHANGED + 1))
}

# The tracked files, as "repo-relative-path<TAB>absolute-target".
targets() {
  printf '%s\t%s\n' \
    "dot-pi/agent/settings.json"          "$HOME/.pi/agent/settings.json" \
    "dot-pi/agent/models.json"            "$HOME/.pi/agent/models.json" \
    "dot-pi/agent/AGENTS.md"              "$HOME/.pi/agent/AGENTS.md" \
    "dot-pi/agent/subagents.json"         "$HOME/.pi/agent/subagents.json" \
    "dot-pi/web-search.json"              "$HOME/.pi/web-search.json" \
    "dot-config/rpiv-todo/config.json"    "$HOME/.config/rpiv-todo/config.json" \
    "dot-config/rpiv-advisor/advisor.json" "$HOME/.config/rpiv-advisor/advisor.json" \
    "dot-agents/.skill-lock.json"         "$HOME/.agents/.skill-lock.json"
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
    printf '%s\t%s\n' "dot-agents/skills/$name/SKILL.md" "$HOME/.agents/skills/$name/SKILL.md"
  done
}

echo "repo: $REPO"
echo "mode: $MODE"
echo

if [ "$MODE" = "uninstall" ]; then
  echo "Removing symlinks that point into this repo:"
  while IFS=$'\t' read -r _rel dst; do
    unlink_one "$dst"
  done < <(targets)
  echo
  echo "Also removing the plugins symlink:"
  unlink_one "$HOME/.pi/agent/plugins"
  echo
  echo "Done ($CHANGED change(s)). Backups left as *.pre-pi-config-* if any existed."
  exit 0
fi

echo "Linking config files:"
while IFS=$'\t' read -r rel dst; do
  link "$rel" "$dst"
done < <(targets)

echo
echo "Linking plugins directory (settings.json references plugins/<name>):"
dst="$HOME/.pi/agent/plugins"
src="$REPO/plugins"
[ "$MODE" = "dry-run" ] || mkdir -p "$(dirname "$dst")"
if [ -L "$dst" ] && [ "$(readlink "$dst")" = "$src" ]; then
  echo "  ok       $dst"
elif [ -e "$dst" ] && [ ! -L "$dst" ]; then
  bak="$dst.pre-pi-config-$STAMP"
  echo "  backup   $dst -> $bak"
  [ "$MODE" = "dry-run" ] || mv "$dst" "$bak"
  echo "  link     $dst -> $src"
  [ "$MODE" = "dry-run" ] || ln -s "$src" "$dst"
  CHANGED=$((CHANGED + 1))
elif [ -L "$dst" ]; then
  echo "  relink   $dst -> $src"
  [ "$MODE" = "dry-run" ] || { rm -f "$dst"; ln -s "$src" "$dst"; }
  CHANGED=$((CHANGED + 1))
else
  echo "  link     $dst -> $src"
  [ "$MODE" = "dry-run" ] || ln -s "$src" "$dst"
  CHANGED=$((CHANGED + 1))
fi

# Set PI_CONFIG_SKIP_PLUGINS=1 to link files without touching the network
# (no submodule fetch, no npm install) — used by the repo's own install test.
if [ "$MODE" = "install" ] && [ "${PI_CONFIG_SKIP_PLUGINS:-0}" != "1" ]; then
  echo
  echo "Fetching plugin submodules:"
  git -C "$REPO" submodule update --init --recursive
  echo
  echo "Installing plugin dependencies:"
  for p in "$REPO"/plugins/*/; do
    [ -f "$p/package.json" ] || continue
    echo "  npm install  $(basename "$p")"
    (cd "$p" && npm install --no-audit --no-fund)
  done
fi

echo
echo "Done ($CHANGED change(s))."
cat <<'EOF'

Next steps on a fresh machine:
  1. Credentials — this repo intentionally ships none:
       • export OMLX_API_KEY=...   (any provider models.json references as $VAR)
       • run `pi` and use /login for deepseek, fireworks, xiaomi, github-copilot
         (or copy a private auth.json to ~/.pi/agent/auth.json)
  2. Restart pi (extensions and settings load at startup).
  3. `pi list` should show the three plugins under ~/.pi/agent/plugins.
EOF
