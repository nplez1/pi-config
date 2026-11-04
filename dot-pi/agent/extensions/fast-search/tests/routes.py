#!/usr/bin/env python3
"""Check normal small/git/broad routing against installed native tools."""
import json, os, pathlib, subprocess, tempfile
HERE=pathlib.Path(__file__).resolve().parent
with tempfile.TemporaryDirectory(prefix='fast-search-routes-') as tmp:
    out=pathlib.Path(tmp)/'out.json'; root=pathlib.Path(tmp)/'root'; root.mkdir()
    env=dict(os.environ,FAST_ROUTE_ROOT=str(root),FAST_ROUTE_OUT=str(out),PI_OFFLINE='1',PI_SKIP_VERSION_CHECK='1')
    env.pop('PI_FAST_SEARCH_BACKEND',None)
    cmd=['pi-bolt','--mode','rpc','--no-session','--no-extensions','--no-skills','--no-context-files','--no-prompt-templates','--offline','--tools','find,grep','-e',str(HERE/'routes.mjs')]
    proc=subprocess.run(cmd,cwd=root,env=env,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=60)
    if proc.returncode or not out.exists():raise SystemExit('routing probe failed: '+proc.stderr.decode('utf-8','replace')[-1000:])
    result=json.loads(out.read_text());print(json.dumps(result,indent=2));assert 'error' not in result,result.get('error')
    for row in result['results']:
        expected='fd' if row['kind']=='find' else 'rg'
        assert row['equal'] and expected in row['attempted'] and row['decision']['backend'] in ('native',expected),row
