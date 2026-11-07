"""Exact installed artifact rehearsal; synthetic profiles and disposable prefix only."""
import contextlib, hashlib, json, os, pathlib, shutil, sqlite3, subprocess, sys, tarfile
ROOT = pathlib.Path(sys.argv[1]).resolve()
NODE = shutil.which('node')
LOG = ROOT / 'logs/installed-commands.jsonl'
def run(args, codes=(0,), **kwargs):
    result = subprocess.run(list(map(str, args)), text=True, capture_output=True, timeout=45, **kwargs)
    with LOG.open('a') as f:
        f.write(json.dumps({'argv':list(map(str,args)), 'cwd':str(kwargs.get('cwd',ROOT)), 'exit':result.returncode,'stdout':result.stdout,'stderr':result.stderr})+'\n')
    assert result.returncode in codes, (args,result.returncode,result.stdout,result.stderr)
    return result.stdout

@contextlib.contextmanager
def database(path):
    connection=sqlite3.connect(path)
    try:
        with connection: yield connection
    finally: connection.close()
def digest(path): return hashlib.sha256(path.read_bytes()).hexdigest()
def inventory(root):
    return {str(p.relative_to(root)):{'sha256':digest(p),'mode':p.stat().st_mode & 0o777,'size':p.stat().st_size,'mtime_ns':p.stat().st_mtime_ns} for p in sorted(root.rglob('*')) if p.is_file()}
def verify(archive, expected):
    assert digest(archive)==expected
    with tarfile.open(archive) as t:
        members=t.getmembers()
        for m in members:
            p=pathlib.PurePosixPath(m.name)
            assert not p.is_absolute() and '..' not in p.parts and m.isfile()
        raw_manifest=t.extractfile('manifest.json').read();manifest=json.loads(raw_manifest)
        names={m.name:m for m in members}
        assert set(names)==set(manifest['files'])|{'manifest.json'}
        for n,v in manifest['files'].items():
            assert hashlib.sha256(t.extractfile(n).read()).hexdigest()==v['sha256']
            assert names[n].mode==v['mode']
        assert {'LICENSE','NOTICE'} <= set(names)
    return {'archive':str(archive),'sha256':expected,'bytes':archive.stat().st_size,'canonicalManifestJsonSha256':hashlib.sha256(json.dumps(manifest,sort_keys=True).encode()).hexdigest(),'rawManifestSha256':hashlib.sha256(raw_manifest).hexdigest(),'manifest':manifest}

oldroot=pathlib.Path('/home/ryltsevmg/Projects/Ocean-artifacts/1.1.0-rc.2/cli')
old=oldroot/'ocean-1.1.0-rc.2-linux-x64.tar.gz'
new=ROOT/'cli/ocean-1.1.0-rc.3-linux-x64.tar.gz'
evidence={'old':verify(old,old.with_suffix('.gz.sha256').read_text().split()[0]),'new':verify(new,new.with_suffix('.gz.sha256').read_text().split()[0])}
assert evidence['old']['manifest']['revision']=='5e10ec32179063be78a55f6835866a1a864991ac'
assert evidence['new']['manifest']['revision']==subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT/'source',text=True).strip()
prefix=ROOT/'prefix'
installer=ROOT/'cli/ocean-install.mjs'
def install(archive,sha):
    run([NODE,installer,'--archive',archive,'--sha256',sha,'--prefix',prefix])
    return os.readlink(prefix/'lib/ocean/current')
def cli(profile,*args,codes=(0,)):
    out=run([prefix/'bin/ocean',*args,'--profile',profile,'--json'],codes)
    return json.loads(out)
RUN=ROOT/'archive-rehearsal'; RUN.mkdir(mode=0o700)
workspace=RUN/'workspace'; workspace.mkdir(mode=0o700)
profiles=RUN/'profiles'; profiles.mkdir(mode=0o700)
profile=profiles/'rc2'
evidence['switches']=[install(old,evidence['old']['sha256'])]
assert run([prefix/'bin/ocean','--version']).strip()=='ocean 1.1.0-rc.2'
cli(profile,'init','--workspace',workspace)
cli(profile,'bot','add','--handle','dev','--name','Dev','--role','Synthetic offline')
room=cli(profile,'room','direct','--bot','dev')['data']['data']['id']
# Seed only synthetic history in the actual RC2 database, preserving its schema.
with database(profile/'runtime.sqlite') as db:
    assert db.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()[0]=='18'
    bot=db.execute('SELECT id FROM ocean_bots').fetchone()[0]
    db.execute("INSERT INTO ocean_messages (id,workspace_id,room_id,seq,author,target_bot_id,body,created_at,author_bot_id,turn_id) VALUES ('old-msg','ws_ocean',?,1,'user',?,'archived RC2 synthetic history','2026-11-01T00:00:00.000Z',NULL,NULL)",(room,bot))
pre=RUN/'preupgrade-backup'
cli(profile,'backup','--to',pre)
prebytes=inventory(pre)
migrated=profiles/'migrated'; shutil.copytree(profile,migrated)
before=inventory(profile)
evidence['switches'].append(install(new,evidence['new']['sha256']))
assert inventory(profile)==before
assert run([prefix/'bin/ocean','--version']).strip()=='ocean 1.1.0-rc.3'
cli(migrated,'bot','list')
with database(migrated/'runtime.sqlite') as db: assert db.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()[0]=='23'
# Real schema18 implementation must refuse schema23 without any retained mutation.
oldentry=prefix/'lib/ocean/releases/1.1.0-rc.2/launch.js'
prior=inventory(migrated)
refusal=run([NODE,oldentry,'bot','list','--profile',migrated,'--json'],codes=(2,3,4))
assert json.loads(refusal)['error']['code']=='invalid_input'
oldstore=oldentry.parent/'node_modules/@runnets/store-sqlite/dist/index.js'
reason=run([NODE,'--input-type=module','-e',"const m=await import(process.argv[1]);try{m.openSqliteStore({path:process.argv[2]});process.exitCode=9}catch(e){console.log(e.message)}",oldstore.as_uri(),migrated/'runtime.sqlite'])
assert 'schema version 23 is newer than the supported version 18' in reason
refusal_after=inventory(migrated);assert refusal_after==prior
assert inventory(pre)==prebytes
newentry=prefix/'lib/ocean/releases/1.1.0-rc.3'
cli(migrated,'doctor')
assert cli(migrated,'send',room,'--text','offline candidate',codes=(4,))['error']['code']=='provider_unavailable'
assert cli(migrated,'history',room)['data'][0]['body']=='archived RC2 synthetic history'
# Installer rollback changes only a disposable prefix; restore compatible backup to a NEW target.
evidence['switches'].append(install(old,evidence['old']['sha256']))
rollback=profiles/'rollback'
cli(rollback,'restore','--from',pre)
cli(rollback,'doctor')
assert cli(rollback,'history',room)['data'][0]['body']=='archived RC2 synthetic history'
assert inventory(pre)==prebytes
with database(rollback/'runtime.sqlite') as db: assert db.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()[0]=='18'
evidence['switches'].append(install(new,evidence['new']['sha256']))
# Additional schema14/format2 fixture is RC1-era, separate from genuine schema5 v1.0.0.
legacy=profiles/'additional-schema14'; shutil.copytree(profile,legacy)
with database(legacy/'runtime.sqlite') as db:
    for table in ['ocean_provider_receipts','ocean_provider_connections']: db.execute('DROP TABLE IF EXISTS '+table)
    db.execute("UPDATE meta SET value='14' WHERE key='schema_version'")
legacybackup=RUN/'additional-schema14-backup'; cli(legacy,'backup','--to',legacybackup)
restored=profiles/'additional-schema14-restored'; cli(restored,'restore','--from',legacybackup)
assert cli(restored,'doctor')['data']['restored'] is True
assert cli(restored,'history',room)['data'][0]['body']=='archived RC2 synthetic history'
evidence.update({'refusal':json.loads(refusal),'refusalInventoryBefore':prior,'refusalInventoryAfter':refusal_after,'preupgradeBackupInventory':prebytes,'refusalStoreError':reason.strip(),'refusalNoByteOrMetadataChange':True,'preupgradeBackupUnchanged':True,'rollbackSchema':18,'migratedSchema':23,'additionalRC1EraSchema':14,'prefix':str(prefix),'installedRoot':str(newentry),'room':room})
(ROOT/'archive-proof.json').write_text(json.dumps(evidence,indent=2)+'\n')
print(json.dumps({k:v for k,v in evidence.items() if k not in ['old','new']},indent=2))
