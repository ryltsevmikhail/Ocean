"""Read-only exact candidate inventory and evidence freeze after final native/installed probes."""
import hashlib,json,pathlib,platform,subprocess,sys,tarfile,zipfile
root=pathlib.Path(sys.argv[1]);source=root/'source';plan=pathlib.Path('/home/ryltsevmg/Projects/Ocean-stable/.superpowers/sdd/2026-11-04-ocean-platform');sha=lambda b:hashlib.sha256(b).hexdigest();file_sha=lambda p:sha(p.read_bytes())
revision=subprocess.check_output(['git','rev-parse','HEAD'],cwd=source,text=True).strip();assert revision=='ec1e5d59fc8f7bc08122f331d636c9ae0f1d031a';assert subprocess.check_output(['git','status','--porcelain'],cwd=source,text=True)==''
archive=root/'cli/ocean-1.1.0-rc.3-linux-x64.tar.gz';assert file_sha(archive)=='933d0b3a535685a4606e92c91ecd970507e0d403002d2e348cfb2b304302556d'
with tarfile.open(archive) as t:
    raw=t.extractfile('manifest.json').read();manifest=json.loads(raw)
(root/'cli/manifest.json').write_bytes(raw)
installed=root/'prefix/lib/ocean/releases/1.1.0-rc.3'
for name,record in manifest['files'].items():
    p=installed/name;assert file_sha(p)==record['sha256'];assert p.stat().st_mode&511==record['mode']
assert {str(p.relative_to(installed)) for p in installed.rglob('*') if p.is_file()}==set(manifest['files'])|{'manifest.json'}
meta=root/'desktop/desktop-artifact.json';desktop=json.loads(meta.read_text());
for record in desktop['inventory']:
    p=root/'desktop/artifact/OceanDesktop-linux-x64'/record['path'];assert file_sha(p)==record['sha256'];assert p.stat().st_size==record['size']
asar=root/'desktop/artifact/OceanDesktop-linux-x64/resources/app.asar';b=asar.read_bytes();header=json.loads(b[16:16+int.from_bytes(b[12:16],'little')]);offset=8+int.from_bytes(b[4:8],'little');licenses={}
for name in ['LICENSE','NOTICE','THIRD_PARTY_LICENSES/vue-MIT.txt','THIRD_PARTY_LICENSES/zod-MIT.txt','node_modules/zod/LICENSE']:
    item=header
    for p in name.split('/'):item=item['files'][p]
    body=b[offset+int(item['offset']):offset+int(item['offset'])+item['size']];assert body==(root/'desktop/stage'/name).read_bytes();licenses[name]={'bytes':len(body),'sha256':sha(body)}
assert licenses['THIRD_PARTY_LICENSES/vue-MIT.txt']['sha256']=='1bb85cc9b13b81ef41c81c51866172fc345e0503c86726a6755b796590b70175'
zip_path=pathlib.Path('/home/ryltsevmg/.cache/electron/fb82adfe72ba90d98ee1fcb6b06511833495be5ee3638992b482dea07f0e7ad5/electron-v45.2.1-linux-x64.zip');zip_sha=file_sha(zip_path);assert zip_sha=='616efc1ae4784af1a4f3f0e8774e73e7030e7bd1708da9d09bcf543dfa499beb'
with zipfile.ZipFile(zip_path) as z:
    for info in z.infolist():
        p=pathlib.PurePosixPath(info.filename);assert not p.is_absolute() and '..' not in p.parts
    assert z.read('version').decode().strip()=='45.2.1';checks={}
    for src,dst in [('electron','OceanDesktop'),('LICENSE','LICENSE'),('LICENSES.chromium.html','LICENSES.chromium.html')]:
        p=root/'desktop/artifact/OceanDesktop-linux-x64'/dst;assert sha(z.read(src))==file_sha(p);checks[dst]=file_sha(p)
        if dst!='OceanDesktop':licenses['electron/'+dst]={'bytes':p.stat().st_size,'sha256':file_sha(p)}
    electron={'archive':str(zip_path),'bytes':zip_path.stat().st_size,'sha256':zip_sha,'safeEntries':len(z.infolist()),'version':'45.2.1','packagedBytesMatchOfficialArchive':checks,'officialChecksums':'task-17-native-upstream-checksum-verification.json: official API and SHASUMS256 agree','staging':str(root/'desktop/packager-tmp'),'systemElectronNotUsed':True,'desktopGUIExecution':False}
(root/'electron-proof.json').write_text(json.dumps(electron,indent=2)+'\n')
(root/'licenses-proof.json').write_text(json.dumps({'verifiedRawASARAgainstStage':True,'asarDataOffset':offset,'licenses':licenses,'vueGroupVersion':'3.5.44','zodVersion':'4.6.7','electron':'45.2.1','desktopManifestSha256':file_sha(meta)},indent=2)+'\n')
files={}
for p in source.rglob('*'):
    if p.is_file() and 'node_modules' not in p.parts and '.git' not in p.parts and (p.suffix in ['.ts','.vue','.mjs','.json','.yaml','.js','.cjs','.html','.css'] or p.name in ['LICENSE','NOTICE']):files[str(p.relative_to(source))]=file_sha(p)
protected=pathlib.Path('/home/ryltsevmg/Projects/Ocean-stable');frozen={'sourceRevision':revision,'sourceStatus':'','node':subprocess.check_output(['node','--version'],text=True).strip(),'pnpm':subprocess.check_output(['pnpm','--version'],text=True).strip(),'architecture':platform.machine(),'kernel':platform.release(),'lockfileSha256':file_sha(source/'pnpm-lock.yaml'),'rawManifestSha256':sha(raw),'archiveSha256':file_sha(archive),'desktopASARSha256':file_sha(asar),'protectedCurrentHashes':{n:file_sha(protected/n) for n in ['apps/cli/test-fixtures/github-session-rig.ts','apps/cli/src/plugin-catalog-lifetime.test.ts']},'files':files,'qualificationScripts':{p.name:file_sha(p) for p in plan.glob('task-17.3-*') if p.suffix in ['.py','.txt']}}
assert frozen['protectedCurrentHashes']=={'apps/cli/test-fixtures/github-session-rig.ts':'d6ea013e8333688abb36e51c7a09922a077f5a1726f203258bc06f49e642c031','apps/cli/src/plugin-catalog-lifetime.test.ts':'68f28f549e0713f5c21d47950b6db96babdb27a7b9264684268c571b7cde62a3'}
(root/'freeze.json').write_text(json.dumps(frozen,indent=2)+'\n')
(root/'environment.txt').write_text(subprocess.check_output(['uname','-a'],text=True)+subprocess.check_output(['df','-h',str(root),'/tmp'],text=True)+subprocess.check_output(['free','-h'],text=True)+subprocess.check_output(['lscpu'],text=True))
proofs=['archive-proof.json','v1-proof.json','rebind-proof.json','hosts-proof.json','sandbox-proof.json','early-cancel-proof.json','runtime-equivalence.json','electron-proof.json','licenses-proof.json','owned-cleanup-proof.json','gate-ledger.json','freeze.json']
for p in proofs:assert (root/p).is_file(),p
inventory={str(p.relative_to(root)):{'sha256':file_sha(p),'bytes':p.stat().st_size} for p in sorted(root.rglob('*')) if p.is_file() and str(p.relative_to(root))!='logs/freeze.log' and ('logs' in p.relative_to(root).parts or str(p.relative_to(root)) in proofs)}
(root/'evidence-inventory.json').write_text(json.dumps(inventory,indent=2)+'\n')
print(json.dumps({'revision':revision,'archiveSha256':file_sha(archive),'rawManifestSha256':sha(raw),'CLIInventoriedFiles':len(manifest['files']),'desktopASARSha256':file_sha(asar),'desktopFiles':desktop['files'],'desktopBytes':desktop['bytes'],'frozenFiles':len(files),'proofs':proofs},indent=2))
