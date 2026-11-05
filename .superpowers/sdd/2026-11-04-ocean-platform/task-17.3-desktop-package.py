"""Invoke unchanged artifact helper with explicit disk staging using public packager option."""
import os,pathlib,subprocess,sys
source=pathlib.Path(sys.argv[1]); root=pathlib.Path(sys.argv[2])
helper=(source/'apps/desktop/qa/artifact.mjs').read_text()
package=next((source/'node_modules/.pnpm').glob('@electron+packager@*/node_modules/@electron/packager/dist/index.js'))
helper=helper.replace("from '@electron/packager'",'from '+repr(package.as_uri()))
helper=helper.replace("from '../dist/types/artifact-licenses.js'", 'from '+repr((source/'apps/desktop/dist/types/artifact-licenses.js').as_uri()))
assert helper.count('  prune: false,')==1
helper=helper.replace('  prune: false,', '  prune: false,\n  tmpdir: '+repr(str(root/'desktop/packager-tmp'))+',')
env=dict(os.environ,OCEAN_QA_PACKAGE_ROOT=str(root/'desktop'),OCEAN_QA_DESKTOP_VERSION='1.1.0-rc.3',OCEAN_QA_ELECTRON_ZIP_DIR='/home/ryltsevmg/.cache/electron/fb82adfe72ba90d98ee1fcb6b06511833495be5ee3638992b482dea07f0e7ad5')
result=subprocess.run(['node','--input-type=module'],input=helper,text=True,cwd=source,env=env)
sys.exit(result.returncode)
