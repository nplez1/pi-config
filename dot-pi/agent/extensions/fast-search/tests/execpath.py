#!/usr/bin/env python3
"""Check registration does not depend on reading/fingerprinting the Pi executable."""
import json, os, pathlib, subprocess
HERE=pathlib.Path(__file__).resolve().parent
cmd=['pi-bolt','--mode','rpc','--no-session','--no-extensions','--no-skills','--no-context-files','--no-prompt-templates','--offline','--tools','find,grep','-e',str(HERE/'execpath.mjs')]
env=dict(os.environ,PI_OFFLINE='1',PI_SKIP_VERSION_CHECK='1');env.pop('PI_FAST_SEARCH_BACKEND',None)
proc=subprocess.run(cmd,env=env,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=60)
lines=proc.stderr.decode('utf-8','replace').splitlines();events=[line for line in lines if line.startswith('FAST_EXEC_PATH=')]
if proc.returncode or len(events)!=1:raise SystemExit('execPath probe failed: '+'\n'.join(lines[-20:]))
tools=json.loads(events[0].split('=',1)[1]);print(json.dumps(tools));assert {x['name'] for x in tools}=={'find','grep'}
assert all(x['source']['source']=='cli' and pathlib.Path(x['source']['path']).name=='execpath.mjs' for x in tools),tools
