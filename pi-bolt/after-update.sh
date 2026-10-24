#!/bin/sh
# after-update.sh — put the install back in step after an update, quietly.
#
#   after-update.sh                do what is needed; print only what changed
#   after-update.sh --check        report what is out of step; change nothing; exit 1
#   after-update.sh --verbose      print every verdict
#   after-update.sh --print-exclude  the compile-exclude list, comma separated
#   after-update.sh --shadow-check   only the module-shadowing check below
#
# `pi update` and `pi update --extensions` move three things that nothing else
# notices, and none of them shows up as an error at update time:
#
#   1. deps      Either npm tree can pick up a vulnerable dependency, and the
#                managed release loses its undici pin on every update, because
#                its package.json is regenerated.        -> deps-audit.sh
#   2. bundles   `pi update --extensions` bumps pi-web-access, and the prebuilt
#                bundle that wraps it is a snapshot: pi-bolt then runs the old
#                code silently.                            -> rebuild.sh --if-stale
#   3. compile   A new Pi-Bolt release starts without ~/.pi-bolt/compile.json, so
#                the compile set silently falls back to "everything installed".
#                That fails on the one extension Bun cannot compile (a top-level
#                await), and `pi-bolt update` then installs the release with
#                *nothing* compiled in — and every later bare `pi compile` dies
#                the same way. Re-assert pi-bolt/compile-exclude.txt.
#
# The `pi` shim (pi-swap.sh) runs this after `pi update`; `install.sh` runs
# deps-audit.sh and the rest itself. Running `pi-bolt update` or `pi-real update`
# directly skips the shim: run this afterwards, or `install.sh`.
#
# Exit status is 1 only for `--check` when something is out of step, so a caller
# can run it after a command without changing that command's exit code.
set -u

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exclude_file=$here/compile-exclude.txt

exclude_list() {
  [ -f "$exclude_file" ] || return 0
  sed 's/#.*//' "$exclude_file" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' | sed '/^$/d' | paste -sd, -
}

check_only=0
quiet=1
shadow_only=0

while [ $# -gt 0 ]; do
  case "$1" in
    --check) check_only=1 ;;
    --verbose | -v) quiet=0 ;;
    # Read by the `pi` shim: it passes this to `pi compile`, so the exclusions
    # hold even when ~/.pi-bolt/compile.json is gone (`compile --off` deletes it).
    --print-exclude) exclude_list; exit 0 ;;
    --shadow-check) shadow_only=1 ;;
    --help | -h)
      awk 'NR==1{next} /^#/{sub(/^# ?/,""); print; next} {exit}' "$0"
      exit 0
      ;;
    *)
      echo "after-update.sh: unknown argument: $1" >&2
      exit 2
      ;;
  esac
  shift
done

trouble=0

# ---- 0. a node_modules above the agent dir shadows the host's own modules ----
# Pi hands @earendil-works/pi-coding-agent, pi-tui, pi-ai and typebox to extensions
# as *fallbacks*, so a copy on disk wins. A stray `npm install` in $HOME creates
# $HOME/node_modules, which sits above ~/.pi/agent and hijacks all four: every
# extension that imports one then loads a second Pi. Measured here on 2026-10-24 —
# pi-bolt-subagents 239 ms instead of 8 ms, opensec-pi-todo 108 ms instead of 0,
# ~390 ms of extension load against ~42 ms. `doctor` reports that as "the JIT build
# would run heavy extensions faster", which is the wrong lead. This costs four
# stat() calls, so it looks every time.
#
# ~/.pi/agent/npm/node_modules is deliberately NOT flagged: that one is where the
# extensions themselves are installed, and `typebox` living there is normal.
host_modules="@earendil-works/pi-coding-agent @earendil-works/pi-tui @earendil-works/pi-ai typebox"

shadowed() {
  d=$HOME/.pi/agent
  while [ -n "$d" ] && [ "$d" != "/" ]; do
    if [ -d "$d/node_modules" ]; then
      for m in $host_modules; do
        if [ -e "$d/node_modules/$m" ]; then
          printf '%s/node_modules/%s\n' "$d" "$m"
          break
        fi
      done
    fi
    d=$(dirname "$d")
  done
}

shadow_report=$(shadowed)
if [ "$shadow_only" = 1 ]; then
  if [ -n "$shadow_report" ]; then
    printf '%s\n' "$shadow_report" >&2
    exit 1
  fi
  exit 0
fi
if [ -n "$shadow_report" ]; then
  printf 'pi sync: WARNING — a node_modules above the agent dir carries host modules:\n' >&2
  printf '%s\n' "$shadow_report" | sed 's|^|  |' >&2
  printf 'pi sync: pi supplies those itself; a copy on disk wins, so extensions load a\n' >&2
  printf 'pi sync: second copy (here: ~390 ms of extension load instead of ~40 ms).\n' >&2
  printf 'pi sync: move it out of the way — nothing in pi needs it:\n' >&2
  printf 'pi sync:   mv %s %s\n' \
    "$(printf '%s' "$shadow_report" | head -1 | sed 's|/node_modules/.*||')/node_modules" \
    "$HOME/node_modules.shadowed" >&2
  trouble=1
elif [ "$quiet" = 0 ]; then
  echo "pi sync: no stray node_modules shadows the host's modules"
fi

# ---- 1. dependencies --------------------------------------------------------
if [ -x "$here/deps-audit.sh" ]; then
  if [ "$check_only" = 1 ]; then
    "$here/deps-audit.sh" --check || trouble=1
  else
    "$here/deps-audit.sh" || trouble=1
  fi
fi

# ---- 2. bundles -------------------------------------------------------------
if [ -x "$here/rebuild.sh" ]; then
  if [ "$check_only" = 1 ]; then
    "$here/rebuild.sh" --check >/dev/null 2>&1 || {
      echo "pi sync: a bundle is stale — run $here/rebuild.sh" >&2
      trouble=1
    }
  elif rebuild_line=$("$here/rebuild.sh" --if-stale 2>&1); then
    [ -n "$rebuild_line" ] && printf '%s\n' "$rebuild_line"
  else
    printf 'pi sync: bundle rebuild failed — pi-bolt is running the previous bundle\n' >&2
    [ -n "${rebuild_line:-}" ] && printf '%s\n' "$rebuild_line" | sed 's/^/  /' >&2
    trouble=1
  fi
fi

# ---- 3. the compile record --------------------------------------------------
if command -v pi-bolt >/dev/null 2>&1 && [ -f "$exclude_file" ]; then
  record=$HOME/.pi-bolt/compile.json
  want=$(exclude_list)
  drift=""

  if [ ! -f "$record" ]; then
    drift="the compile record is missing"
  else
    have=$(awk 'seen{print} /"exclude"[[:space:]]*:/{seen=1}' "$record" \
      | grep -o '"[^"]*"' | tr -d '"' | paste -sd, -)
    [ "$have" = "$want" ] || drift="the recorded exclusion is [${have}] not [$want]"
    if [ -z "$drift" ]; then
      built=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$record" | head -1)
      running=$(pi-bolt --version 2>/dev/null | sed -n 's/.*Pi-Bolt \([0-9.A-Za-z-]*\).*/\1/p')
      [ -n "$built" ] && [ -n "$running" ] && [ "$built" != "$running" ] \
        && drift="built for Pi-Bolt $built, running $running"
    fi
  fi

  if [ -n "$drift" ]; then
    if [ "$check_only" = 1 ]; then
      echo "pi sync: compile set out of step ($drift) — run pi-bolt compile --exclude $want" >&2
      trouble=1
    else
      printf 'pi sync: recompiling (%s)…\n' "$drift"
      log=$HOME/.pi-bolt/compile.log
      log_before=$(cksum "$log" 2>/dev/null || true)
      if compile_out=$(pi-bolt compile --exclude "$want" 2>&1); then
        printf 'pi sync: compiled in: %s\n' "$(pi-bolt compile --status 2>/dev/null | sed -n 's/^Extensions compiled in[^:]*: *//p')"
      else
        printf 'pi sync: compile failed — extensions still load from their files\n' >&2
        # Name the culprit when the compiler did: an extension with a top-level
        # await cannot be compiled in at all, and the fix is one line in
        # compile-exclude.txt, not another attempt at the same build. pi-bolt
        # prints the full error to its log and a summary to the terminal, so read
        # the log — but only if this build wrote it.
        culprit=""
        if [ "$(cksum "$log" 2>/dev/null || true)" != "$log_before" ]; then
          culprit=$(sed -n 's|.*transitive dependency ".*/package-\([^/"]*\)/index\.ts".*|\1|p' "$log" | head -1)
        fi
        [ -z "$culprit" ] && culprit=$(printf '%s\n' "$compile_out" \
          | sed -n 's|.*transitive dependency ".*/package-\([^/"]*\)/index\.ts".*|\1|p' | head -1)
        if [ -n "$culprit" ]; then
          printf 'pi sync: %s has a top-level await, which Bun cannot compile in — add it to %s\n' \
            "$culprit" "$exclude_file" >&2
        else
          printf 'pi sync: see %s, or retry pi-bolt compile --exclude %s\n' "$log" "$want" >&2
        fi
        trouble=1
      fi
    fi
  elif [ "$quiet" = 0 ]; then
    echo "pi sync: compile record is in step"
  fi
fi

[ "$check_only" = 1 ] && [ "$trouble" = 0 ] && [ "$quiet" = 0 ] && echo "pi sync: nothing out of step"

exit "$trouble"
