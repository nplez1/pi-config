#!/usr/bin/env python3
"""
mem-compare.py — peak RSS for pi vs pi-bolt: baseline, a short session, an idle
TUI, and a longer session.

Two measurement methods, because the two cases fail differently:

  * **Headless** (`-p`) runs exit on their own, so they are forked and reaped with
    wait4, whose rusage reports the true high-water mark rather than whatever a
    poll happened to catch.
  * **The TUI** never exits, so it is sampled with `ps` and killed at the end. It
    needs two things a naive pty spawn misses: a **window size** (a 0x0 pty makes
    it quit immediately) and a **process-group** kill, since a graceful SIGTERM
    can be held up by a process blocked on the terminal. Note the process shows as
    `pi-bolt`/`node`, not by its full path, which is why matching on the path
    finds nothing.

Every run has a hard deadline and escalates SIGTERM -> SIGKILL, so a stalled model
call cannot hang the comparison.

Both runtimes are a single process here (the pi launcher `exec`s node; pi-bolt is
one binary), so this is the whole footprint, not one process of a tree.

The real pi is invoked as `pi-real`, because pi-swap.sh makes `pi` mean pi-bolt.
"""
import fcntl
import os
import pty
import signal
import statistics
import struct
import sys
import tempfile
import termios
import time

KIB = 1024
REPORT = "/tmp/mem-compare.txt"
OUT = []


def say(line=""):
    print(line, flush=True)
    OUT.append(line)
    try:
        with open(REPORT, "w") as fh:
            fh.write("\n".join(OUT) + "\n")
    except OSError:
        pass


def to_bytes(rss_field):
    # ru_maxrss is bytes on macOS and kilobytes on Linux; `ps -o rss=` is always KB.
    return rss_field


def reap(pid, deadline_s):
    end = time.time() + deadline_s
    while time.time() < end:
        wpid, _, ru = os.wait4(pid, os.WNOHANG)
        if wpid == pid:
            return ru.ru_maxrss if sys.platform == "darwin" else ru.ru_maxrss * KIB
        time.sleep(0.1)
    for sig, grace in ((signal.SIGTERM, 2.0), (signal.SIGKILL, 2.0)):
        try:
            os.killpg(pid, sig)
        except ProcessLookupError:
            break
        end = time.time() + grace
        while time.time() < end:
            wpid, _, ru = os.wait4(pid, os.WNOHANG)
            if wpid == pid:
                return ru.ru_maxrss if sys.platform == "darwin" else ru.ru_maxrss * KIB
            time.sleep(0.1)
    try:
        os.waitpid(pid, 0)
    except ChildProcessError:
        pass
    return None


def peak_headless(name, argv, cwd, deadline=300.0):
    pid = os.fork()
    if pid == 0:
        try:
            os.chdir(cwd)
            devnull = os.open(os.devnull, os.O_RDWR)
            os.dup2(devnull, 0)
            os.dup2(devnull, 1)
            os.dup2(devnull, 2)
            os.execvp(name, [name] + argv)
        except OSError:
            os._exit(127)
    return reap(pid, deadline)


def peak_tui(name, cwd, hold=6.0, cols=120, rows=40):
    pid, fd = pty.fork()
    if pid == 0:
        try:
            os.chdir(cwd)
            os.execvp(name, [name])
        except OSError:
            os._exit(127)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

    peak = 0
    end = time.time() + hold
    while time.time() < end:
        out = os.popen(f"ps -o rss= -p {pid} 2>/dev/null").read().strip()
        if out.isdigit():
            peak = max(peak, int(out) * KIB)
        time.sleep(0.4)

    try:
        os.killpg(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    time.sleep(0.6)
    try:
        os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    try:
        os.waitpid(pid, 0)
    except ChildProcessError:
        pass
    return peak or None


def mb(n):
    return f"{n / (1024 * 1024):.1f}"


def collect(label, name, cwd, runs, fn):
    vals = []
    for i in range(runs):
        v = fn()
        say(f"      {name} run {i + 1}/{runs}: " + (f"{mb(v)} MB" if v else "FAILED"))
        if v:
            vals.append(v)
    return int(statistics.median(vals)) if vals else None


def main():
    turn = int(os.environ.get("MEM_TURNS", "3"))
    runs = int(os.environ.get("MEM_RUNS", "2"))
    prompt = "Reply with exactly the word OK and nothing else."
    body = " ".join(f"line {i}: the quick brown fox jumps over the lazy dog." for i in range(60))
    long_prompt = f"Acknowledge with the single word ACK.\n\n{body}"

    dirs = {}
    for name in ("pi-real", "pi-bolt"):
        d = os.path.join(tempfile.gettempdir(), f"mem-compare-{name}")
        os.makedirs(d, exist_ok=True)
        dirs[name] = d

    say(f"peak RSS. platform={sys.platform}  runs={runs} (median)  turns={turn}")
    say(f"long-turn payload ~{len(long_prompt) // 1024} KB")
    say()

    results = {}
    plan = [
        ("baseline: --version, no session", ["--version"], None),
        ("short session: one tiny prompt (-p)", ["-p", prompt], None),
        ("idle TUI, sampled over 6s", None, 6.0),
    ]

    for label, argv, hold in plan:
        say(label)
        for name in ("pi-real", "pi-bolt"):
            if hold is None:
                results[(name, label)] = collect(
                    label, name, dirs[name], runs,
                    lambda n=name, a=argv: peak_headless(n, a, dirs[n]),
                )
            else:
                results[(name, label)] = collect(
                    label, name, dirs[name], runs,
                    lambda n=name, h=hold: peak_tui(n, dirs[n], hold=h),
                )
        say()

    label = "longer session: continued turn"
    say(f"longer session: {turn} turns of ~{len(long_prompt) // 1024} KB, then measure the next turn")
    for name in ("pi-real", "pi-bolt"):
        d = dirs[name]
        for i in range(turn):
            say(f"      {name} building turn {i + 1}/{turn}")
            peak_headless(name, ["-p", long_prompt] if i == 0 else ["-c", "-p", long_prompt], d)
        results[(name, label)] = collect(
            label, name, d, runs,
            lambda n=name: peak_headless(n, ["-c", "-p", prompt], dirs[n]),
        )
    say()

    say("=" * 74)
    say(f"{'scenario':<38}{'pi (Node)':>12}{'pi-bolt':>12}{'delta':>12}")
    say("-" * 74)
    for lbl, *_ in plan + [(label, None, None)]:
        a, b = results.get(("pi-real", lbl)), results.get(("pi-bolt", lbl))
        if not a or not b:
            say(f"{lbl:<38}{'--':>12}{'--':>12}{'--':>12}")
            continue
        say(f"{lbl:<38}{mb(a) + ' MB':>12}{mb(b) + ' MB':>12}{(b - a) / a * 100:>11.1f}%")
    say("=" * 74)
    say()
    say("Each runtime used its own temp cwd, so neither can continue the other's")
    say("session. Pi files sessions under ~/.pi/agent/sessions keyed by cwd, so this")
    say("adds a few sessions there and disturbs none of the existing ones.")
    say(f"full report: {REPORT}")


if __name__ == "__main__":
    main()
