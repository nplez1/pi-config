#!/bin/sh
# pi-swap — make `pi` run Pi-Bolt, or put the real pi back.
#
#   pi-swap.sh apply     `pi` runs pi-bolt, everywhere, until removed
#   pi-swap.sh remove    the real pi again
#   pi-swap.sh status    what `pi` resolves to right now
#
# This is for trialling Pi-Bolt in place of pi. It is deliberately a single
# reversible switch, because the trial is meant to end in either "keep bolt" or
# "revert":
#
#   * `pi` and `pi-bolt` share ~/.pi/agent, so sessions, settings, providers and
#     credentials carry over untouched. Nothing is migrated and nothing is lost
#     either way.
#   * `pi update` becomes `pi-bolt update`, which has the same interface
#     (--self/--extensions/--models/--all/--rollback) over the same shared
#     package list, so package updates keep working. `pi-real update` updates the
#     real install.
#   * The real launcher is preserved as ~/.pi/agent/bin/pi.real and restore is a
#     `mv`, so reverting is exact rather than reconstructed.
#
# Two shims are installed, not one. A fresh login shell resolves `pi` through
# ~/.local/bin, while process trees started by pi or Orca get ~/.pi/agent/bin
# prepended to PATH — shimming only one would leave a way to reach the real pi by
# accident. `pi-real`, or PI_REAL=1, still reaches it deliberately.
set -eu

BOLT_HOME=${PIBOLT_HOME:-$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)}
PI_BIN=$HOME/.pi/agent/bin/pi
PI_REAL=$HOME/.pi/agent/bin/pi.real
LOCAL_BIN=$HOME/.local/bin
LOCAL_PI=$LOCAL_BIN/pi
STATE=$BOLT_HOME/.pi-swap-state
MARKER=pi-swap-shim

is_shim() { [ -f "$1" ] && grep -q "$MARKER" "$1" 2>/dev/null; }

shim() {
  cat <<EOF
#!/bin/sh
# $MARKER — installed by pi-swap.sh; \`pi\` runs Pi-Bolt.
# Revert:  $BOLT_HOME/pi-swap.sh remove
# Bypass:  PI_REAL=1 pi ...          (or use: pi-real)
if [ "\${PI_REAL:-0}" = 1 ]; then
  exec "\$HOME/.pi/agent/bin/pi.real" "\$@"
fi
bolt=\$(command -v pi-bolt 2>/dev/null) || {
  echo "pi-swap: pi-bolt is not on PATH. Revert with $BOLT_HOME/pi-swap.sh remove" >&2
  exit 127
}
# `pi-auto-project-skills` adds parent-project --skill/--append-system-prompt
# before a *session* starts. It is dispatched at the bottom, never for the two
# maintenance commands below: `compile` is not in the helper's pass-through list,
# so routing it there would hand `pi compile` flags it does not accept.
helper="\$HOME/.local/bin/pi-auto-project-skills"

# \`update\` and \`compile\` are the two commands that move what is installed, so
# they are also the ones that leave things out of step: a vulnerable dependency, a
# stale bundle over a freshly bumped pi-web-access, and — after a release bump or a
# \`compile --off\` — no compile record, so the compile set silently falls back to
# everything and dies on an extension Bun cannot compile. after-update.sh puts all
# three back, silently when there is nothing to do, and never changes the exit code.
sync="$BOLT_HOME/after-update.sh"
case " \${1:-} " in
  " update ")
    case " \$* " in
      *" --models "* | *" models "*) exec "\$bolt" "\$@" ;;
    esac
    "\$bolt" "\$@"
    rc=\$?
    [ -x "\$sync" ] && "\$sync"
    exit \$rc
    ;;
  " compile ")
    case " \$* " in
      # A revert, a report, an explicit include set, or an explicit "no exclusions":
      # the caller has said what they want, so pass it straight through.
      *" --off "* | *" --status "* | *" --help "* | *" -h "* | *" --only "* | *" --no-exclude "*)
        exec "\$bolt" "\$@" ;;
    esac
    # Otherwise add the exclusions this repo maintains — merged with any --exclude
    # the caller gave, because a repeated --exclude replaces rather than adds. A
    # bare \`pi compile\` then cannot die on the extension Bun refuses to build,
    # whether or not ~/.pi-bolt/compile.json survived the last update.
    if [ -x "\$sync" ]; then
      want=\$(\$sync --print-exclude 2>/dev/null || true)
      theirs=""
      n=\$#
      while [ "\$n" -gt 0 ]; do
        a=\$1; shift; n=\$((n - 1))
        case "\$a" in
          --exclude) if [ "\$n" -gt 0 ]; then theirs=\${theirs:+\$theirs,}\$1; shift; n=\$((n - 1)); fi ;;
          --exclude=*) theirs=\${theirs:+\$theirs,}\${a#--exclude=} ;;
          *) set -- "\$@" "\$a" ;;
        esac
      done
      [ -n "\$theirs" ] && want=\$theirs,\$want
      [ -n "\$want" ] && set -- "\$@" --exclude "\$want"
    fi
    "\$bolt" "\$@"
    rc=\$?
    [ -x "\$sync" ] && "\$sync"
    exit \$rc
    ;;
esac

# Everything else may be a session: let the helper decorate the invocation, and
# exec, so `pi` stays one process deep.
if [ -x "\$helper" ]; then
  exec "\$helper" "\$bolt" "\$@"
fi
exec "\$bolt" "\$@"
EOF
}

cmd_status() {
  printf '%-28s %s\n' "pi resolves to:" "$(command -v pi || echo '(not found)')"
  if is_shim "$PI_BIN"; then
    printf '%-28s %s\n' "swap:" "APPLIED (~/.pi/agent/bin/pi is the shim)"
  else
    printf '%-28s %s\n' "swap:" "not applied (~/.pi/agent/bin/pi is not the shim)"
  fi
  printf '%-28s %s\n' "real launcher preserved:" "$( [ -f "$PI_REAL" ] && echo "$PI_REAL" || echo 'no — nothing to restore' )"
  printf '%-28s %s\n' "~/.local/bin/pi:" "$( [ -L "$LOCAL_PI" ] && echo "symlink -> $(readlink "$LOCAL_PI")" || { is_shim "$LOCAL_PI" && echo 'shim' || echo 'other/none'; } )"
  printf '%s\n' ""
  printf '%-28s %s\n' "pi --version:" "$(pi --version 2>&1 | head -1)"
  printf '%-28s %s\n' "pi-real --version:" "$( (pi-real --version 2>/dev/null || echo '(not installed)') | head -1)"
  printf '%-28s %s\n' "pi-bolt --version:" "$(pi-bolt --version 2>&1 | head -1)"
}

case "${1:-status}" in
apply)
  command -v pi-bolt >/dev/null 2>&1 || { echo "pi-swap: pi-bolt is not on PATH; nothing to swap in." >&2; exit 1; }

  if [ ! -e "$PI_REAL" ]; then
    if [ ! -e "$PI_BIN" ]; then
      echo "pi-swap: $PI_BIN does not exist — is pi installed?" >&2
      exit 1
    fi
    # Preserve the real launcher byte-for-byte, mode and all.
    cp -p "$PI_BIN" "$PI_REAL"
    echo "pi-swap: preserved the real launcher as $PI_REAL"
  elif ! is_shim "$PI_BIN"; then
    # pi was updated since we applied: keep the newest launcher as the real one.
    cp -p "$PI_BIN" "$PI_REAL"
    echo "pi-swap: refreshed $PI_REAL from the updated launcher"
  fi

  shim >"$PI_BIN"
  chmod 755 "$PI_BIN"

  # A second shim where a fresh login shell looks first. Remember what was there.
  # The symlink is removed rather than written through, so this path keeps working
  # even if a pi update regenerates ~/.pi/agent/bin/pi underneath it.
  if [ -L "$LOCAL_PI" ]; then
    readlink "$LOCAL_PI" >"$STATE"
    echo "pi-swap: recorded the original ~/.local/bin/pi symlink in $STATE"
  fi
  rm -f "$LOCAL_PI"
  mkdir -p "$LOCAL_BIN"
  shim >"$LOCAL_PI"
  chmod 755 "$LOCAL_PI"

  # `pi-real` so the real install stays reachable by name.
  ln -sfn "$PI_REAL" "$LOCAL_BIN/pi-real"

  echo "pi-swap: applied — \`pi\` now runs pi-bolt"
  echo "  revert: $BOLT_HOME/pi-swap.sh remove"
  ;;

remove)
  if is_shim "$PI_BIN"; then
    if [ -f "$PI_REAL" ]; then
      mv "$PI_REAL" "$PI_BIN"
      chmod 755 "$PI_BIN"
      echo "pi-swap: restored $PI_BIN from $PI_REAL"
    else
      echo "pi-swap: no preserved launcher at $PI_REAL; leaving $PI_BIN as it is" >&2
    fi
  else
    # Something already replaced the shim (a pi update, or a manual revert).
    # Restoring the older preserved copy over a newer launcher would be a
    # downgrade, so leave it and only undo the ~/.local/bin side.
    echo "pi-swap: $PI_BIN is not the shim (already reverted or replaced) — leaving it"
  fi

  if [ -f "$STATE" ]; then
    target=$(cat "$STATE")
    rm -f "$LOCAL_PI"
    ln -s "$target" "$LOCAL_PI"
    rm -f "$STATE"
    echo "pi-swap: restored ~/.local/bin/pi -> $target"
  elif is_shim "$LOCAL_PI"; then
    rm -f "$LOCAL_PI"
    echo "pi-swap: removed the ~/.local/bin/pi shim (no original recorded to restore)"
  fi

  rm -f "$LOCAL_BIN/pi-real"
  echo "pi-swap: removed — \`pi\` runs the real pi again"
  ;;

status) cmd_status ;;

*)
  echo "usage: pi-swap.sh [apply|remove|status]" >&2
  exit 2
  ;;
esac
