#!/usr/bin/env python3
"""Compare packaged backends with the installed native tools; no model requests."""
import collections, hashlib, json, os, pathlib, subprocess, tempfile

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent
files = [ROOT / name for name in ('builtin-fast-engine.mjs', 'builtin-fast-candidates.mjs', 'builtin-native-compat.mjs', 'builtin-race.mjs')]
hashes = {file: hashlib.sha256(file.read_bytes()).hexdigest() for file in files}
for kind in ('fixture', 'fuzz'):
    with tempfile.TemporaryDirectory(prefix=f'fast-search-{kind}-') as temp:
        env = dict(os.environ, HOME=temp, XDG_CONFIG_HOME=str(pathlib.Path(temp) / 'xdg'),
                   PI_OFFLINE='1', PI_SKIP_VERSION_CHECK='1',
                   FAST_DIFF_ROOT=str(pathlib.Path(temp) / 'fixtures'),
                   FAST_ENGINE_MODULE=str(ROOT / 'builtin-fast-engine.mjs'))
        env.pop('PI_FAST_SEARCH_BACKEND', None)
        cmd = ['pi-bolt', '--mode', 'rpc', '--no-session', '--no-extensions', '--no-skills',
               '--no-context-files', '--no-prompt-templates', '--offline', '--tools', 'find,grep',
               '-e', str(HERE / f'differential-{kind}.mjs')]
        process = subprocess.run(cmd, cwd=temp, env=env, stdin=subprocess.DEVNULL,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=180)
        marker = 'BUILTIN_DIFFERENTIAL=' if kind == 'fixture' else 'BUILTIN_FUZZ='
        lines = [line for line in process.stderr.decode('utf-8', 'replace').splitlines() if line.startswith(marker)]
        if process.returncode or not lines:
            raise SystemExit(f'{kind} probe did not complete: ' + process.stderr.decode('utf-8', 'replace')[-2000:])
        rows = json.loads(lines[-1][len(marker):])
        failures = [row for row in rows if not row['equal'] or (row.get('expectBackend') and (row.get('decision') or {}).get('backend') != row['expectBackend'])]
        decisions = collections.Counter((row.get('decision') or {}).get('backend') for row in rows)
        print(kind, 'cases', len(rows), 'mismatches', len(failures), 'decisions', dict(decisions))
        for failure in failures[:10]:
            print(json.dumps(failure, ensure_ascii=True)[:3000])
        if failures or not decisions.get('fd') or not decisions.get('rg'):
            raise SystemExit(f'{kind} parity failed or the fd/rg candidate paths did not run')
for file, expected in hashes.items():
    if hashlib.sha256(file.read_bytes()).hexdigest() != expected:
        raise SystemExit(f'source changed during differential tests: {file.name}')
