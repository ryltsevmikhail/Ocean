"""Explicit opt-in Linux native gates; bound laptop concurrency, unchanged private runner."""
import json,os,pathlib,shutil,subprocess,tempfile
root=pathlib.Path(tempfile.mkdtemp(prefix='o173-',dir='/home/ryltsevmg'));root.chmod(0o700)
files=subprocess.check_output(['rg','-l','OCEAN_SANDBOX_NATIVE','apps/cli/src','packages/tools-node/src'],text=True).splitlines()+['packages/tools-node/src/desktop-durable-native.test.ts']
args=['pnpm','exec','vitest','run','--config','vitest.config.ts','--maxWorkers=2',*files]
print(json.dumps({'argv':args,'childTMPDIR':str(root),'runnerUnchanged':True,'native':'explicit Linux sandbox/Btrfs opt-ins','concurrency':2}),flush=True)
try:r=subprocess.run(args,env=dict(os.environ,OCEAN_SANDBOX_NATIVE='1',OCEAN_DESKTOP_BTRFS_NATIVE='1',TMPDIR=str(root)))
finally:shutil.rmtree(root)
print('NATIVE_EXIT',r.returncode,flush=True);raise SystemExit(r.returncode)
