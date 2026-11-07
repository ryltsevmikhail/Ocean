import os, pathlib, shutil, subprocess, sys, tempfile
root = pathlib.Path(tempfile.mkdtemp(prefix="oa-"))
env = {"PATH": os.environ["PATH"], "LANG": "C.UTF-8", "USER": "ryltsevmg", "LOGNAME": "ryltsevmg", "SHELL": "/bin/bash", "NO_COLOR": "1", "FORCE_COLOR": "0", "TERM": "dumb"}
for key, name in [("HOME", "home"), ("XDG_CONFIG_HOME", "config"), ("XDG_DATA_HOME", "data"), ("XDG_CACHE_HOME", "cache"), ("XDG_STATE_HOME", "state"), ("XDG_RUNTIME_DIR", "run"), ("TMPDIR", "t")]:
    path = root / name
    path.mkdir(mode=0o700)
    env[key] = str(path)
try:
    result = subprocess.run(sys.argv[1:], env=env, umask=0o022)
finally:
    shutil.rmtree(root)
sys.exit(result.returncode)
