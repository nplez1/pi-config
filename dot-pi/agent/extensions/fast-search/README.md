# Fast built-in search

This Pi-Bolt extension retains the existing `find` and `grep` names, parameter schemas, descriptions, result format, and tool-call hooks. It does not rewrite Bash commands or add tools or prompt guidance.

Every supported search root, including small directories and Git worktrees, is eligible for acceleration. The native search starts first; if it is still running after 40 ms, an fd/rg-backed candidate search starts alongside it. The first valid result wins and the other search is cancelled. This avoids making an already-quick search wait for an external process, but concurrent scans can increase I/O and CPU, and faster results are not guaranteed.

fd enumerates a conservative candidate superset, native-compatible ignore rules are applied, and results are sorted before find limits. When no safe filename literal can be extracted, it enumerates all entries instead of narrowing the scope. Eligible grep queries include searches without a filename glob, with positive or negative globs, and with `~/` or `@` root paths. For these, rg is only a literal prefilter: Pi-Bolt's native grep performs the actual regular-expression match and formatting. Patterns without a provable required literal, uncertain cases and subprocess failures remain native. No searches are silently narrowed.

The compatibility rules cover Pi 1.4.0 and 1.5.0; other Pi versions retain the original built-ins until reviewed. The Pi-Bolt 1.0.9 and 1.1.0 native search walkers are identical; the latter's grep context-line fix is handled by native per-file grep. Matching the version does not prove that every build or platform has identical behavior. The extension does not replace tools provided by other extensions, and it does not fingerprint Pi-Bolt, fd or rg. It uses `fd` and `rg` found on `PATH` and falls back to native on missing tools, subprocess errors or uncertain cases. `pi-config/install.sh` installs missing dependencies with Homebrew when available (`brew install fd ripgrep`); without Homebrew, install them separately. The repo's `pi-bolt/compile-exclude.txt` keeps the file shim and linked directory on disk until their bundled behavior is verified. This is not a security sandbox.

## Disable or inspect

Start a new process with `PI_FAST_SEARCH_BACKEND=native pi-bolt` to retain the original built-ins. Alternatively, remove the `~/.pi/agent/extensions/fast-search.js` entry-point symlink and restart; the `fast-search` directory symlink holds the supporting files and may remain. `PI_FAST_SEARCH_TRACE=1` emits only tool name and selected backend to stderr, not query text or results.

## Tests

```sh
node --test ~/.pi/agent/extensions/fast-search/tests/*.test.mjs
python3 ~/.pi/agent/extensions/fast-search/tests/differential.py
python3 ~/.pi/agent/extensions/fast-search/tests/routes.py
python3 ~/.pi/agent/extensions/fast-search/tests/executables.py
python3 ~/.pi/agent/extensions/fast-search/tests/execpath.py
# Optional deeper generated coverage:
FAST_FUZZ_SEEDS=200 python3 ~/.pi/agent/extensions/fast-search/tests/differential.py
```

The differential test uses the installed Pi-Bolt runtime, fd and rg; it intentionally fails if the supported accelerated paths did not run. The routing test forces the external candidate path on small, Git, and broad roots and compares its output to native. The tests establish bounded evidence, not proof for every filesystem or concurrent filesystem mutation.
