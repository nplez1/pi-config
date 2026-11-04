#!/usr/bin/env python3
"""Check unpinned PATH binaries are used and missing binaries fall back to native."""
import json, os, pathlib, shutil, subprocess, tempfile

HERE = pathlib.Path(__file__).resolve().parent
pi = shutil.which('pi-bolt')
real_fd, real_rg = shutil.which('fd'), shutil.which('rg')
if not all((pi, real_fd, real_rg)):
    raise SystemExit('pi-bolt, fd and rg must be on PATH for this test')
with tempfile.TemporaryDirectory(prefix='fast-search-executables-') as tmp:
    tmp = pathlib.Path(tmp)
    root = tmp / 'root'; root.mkdir()
    (root / 'example.txt').write_text('needle\n')
    for case in ('wrapped', 'missing-fd', 'missing-rg'):
        bins = tmp / case; bins.mkdir()
        marker = tmp / f'{case}.log'
        for name, real in (('fd', real_fd), ('rg', real_rg)):
            if case == f'missing-{name}':
                continue
            # A different executable with no pinned hash, transparently
            # delegating to the installed program while logging actual use.
            script = bins / name
            script.write_text(f'#!/bin/sh\nprintf "{name}\\n" >> "$FAST_EXEC_LOG"\nexec "$FAST_REAL_{name.upper()}" "$@"\n')
            script.chmod(0o700)
        out = tmp / f'{case}.json'
        env = dict(os.environ, PATH=str(bins), FAST_EXEC_ROOT=str(root), FAST_EXEC_OUT=str(out),
                   FAST_EXEC_LOG=str(marker), FAST_REAL_FD=real_fd, FAST_REAL_RG=real_rg,
                   PI_OFFLINE='1', PI_SKIP_VERSION_CHECK='1')
        env.pop('PI_FAST_SEARCH_BACKEND', None)
        cmd = [pi, '--mode', 'rpc', '--no-session', '--no-extensions', '--no-skills',
               '--no-context-files', '--no-prompt-templates', '--offline', '--tools', 'find,grep',
               '-e', str(HERE / 'executables.mjs')]
        proc = subprocess.run(cmd, cwd=root, env=env, stdin=subprocess.DEVNULL,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)
        if proc.returncode or not out.exists():
            raise SystemExit(f'{case} probe failed: ' + proc.stderr.decode('utf-8', 'replace')[-2000:])
        result = json.loads(out.read_text()); calls = marker.read_text().splitlines() if marker.exists() else []
        print(case, json.dumps(result), 'executed', calls)
        assert 'error' not in result and result['findEqual'] and result['grepEqual'], result
        backend = [d['backend'] for d in result['decisions']]
        expected = {'wrapped':['fd','rg'], 'missing-fd':['native','native'], 'missing-rg':['fd','native']}[case]
        assert backend == expected, (case, backend, expected)
        if case == 'wrapped':
            assert 'fd' in calls and 'rg' in calls, calls
