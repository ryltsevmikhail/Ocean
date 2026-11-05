"""Actual v1.0.0 schema5 initializer and format1 backup; entirely synthetic data."""
import hashlib,json,os,pathlib,subprocess,sys
ROOT=pathlib.Path(sys.argv[1]); REPO=pathlib.Path('/home/ryltsevmg/Projects/Ocean-stable'); old=ROOT/'v1-historical-final';old.mkdir(mode=0o700)
commit=subprocess.check_output(['git','rev-parse','v1.0.0'],cwd=REPO,text=True).strip();assert commit=='4417c38ae6c9474cb0c35e9d64ca7f327ac812bd'
store=['schema','conversation-schema','chat-schema','group-schema','review-schema','rows','ownership','transaction','tool-journal','maintenance']
paths=['packages/store-sqlite/src/'+n+'.ts' for n in store]+['apps/cli/src/ocean/snapshots.ts','apps/cli/src/ocean/private-files.ts','apps/cli/src/version.ts']
records=[]
for name in paths:
    body=subprocess.check_output(['git','show',commit+':'+name],cwd=REPO)
    target=old/'captured'/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(body)
    output=old/(name.replace('packages/store-sqlite/src','node_modules/@runnets/store-sqlite/dist').replace('apps/cli/src','apps/cli/dist').removesuffix('.ts')+'.js')
    output.parent.mkdir(parents=True,exist_ok=True)
    records.append({'path':name,'sha256':hashlib.sha256(body).hexdigest(),'captured':str(target),'compiled':str(output)})
(old/'package.json').write_text('{"type":"module"}\n')
(old/'node_modules/@runnets/store-sqlite/package.json').write_text('{"name":"@runnets/store-sqlite","type":"module","exports":{".":{"import":"./dist/index.js"}}}\n')
(old/'node_modules/@runnets/store-sqlite/dist/index.js').write_text("export {inspectDatabase,snapshotDatabase} from './maintenance.js';\n")
(old/'apps/cli/package.json').write_bytes(subprocess.check_output(['git','show',commit+':apps/cli/package.json'],cwd=REPO))
script="""import fs from 'node:fs';import ts from TYPESCRIPT;const records=JSON.parse(process.argv[1]);for(const r of records){const source=fs.readFileSync(r.captured,'utf8');const result=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ES2022,target:ts.ScriptTarget.ES2023}});fs.writeFileSync(r.compiled,result.outputText);}""".replace('TYPESCRIPT',repr((ROOT/'source/node_modules/typescript/lib/typescript.js').as_uri()))
subprocess.run(['node','--input-type=module','-e',script,json.dumps(records)],check=True)
for r in records:r['compiledSha256']=hashlib.sha256(pathlib.Path(r['compiled']).read_bytes()).hexdigest()
profile=old/'profile';profile.mkdir(mode=0o700);backup=old/'backup';restored=old/'restored'
seed="""import assert from 'node:assert/strict';import fs from 'node:fs';import {openDatabase} from SCHEMA;import {SqliteToolJournal} from JOURNAL;import {acquireOwnership} from OWNER;import {backupProfile} from BACKUP;
const profile=process.argv[1],backup=process.argv[2];const db=openDatabase(profile+'/runtime.sqlite',5000);new SqliteToolJournal(db);const release=acquireOwnership(db,{id:'synthetic-v1-owner',pid:process.pid},()=>false);release();
assert.equal(db.prepare(\"SELECT value FROM meta WHERE key='schema_version'\").get().value,'5');
db.prepare('INSERT INTO ocean_workspace VALUES(1,?,?)').run('ws_ocean',process.argv[3]);db.prepare('INSERT INTO ocean_bots VALUES(?,?,?,?,?,?,?,?)').run('v1-bot','ws_ocean','dev','Dev','Synthetic v1.0.0','deepseek','deepseek-chat',1);db.prepare('INSERT INTO ocean_rooms VALUES(?,?,?,?,?,?)').run('v1-room','ws_ocean','direct','v1-bot',null);"""
# Keep values explicit; historical rooms have five columns, not a modern shape.
seed=seed.replace("VALUES(?,?,?,?,?,?)').run('v1-room'", "VALUES(?,?,?,?,?)').run('v1-room'")
seed+="""db.prepare('INSERT INTO ocean_members VALUES(?,?,?)').run('ws_ocean','v1-room','v1-bot');db.prepare('INSERT INTO ocean_messages VALUES(?,?,?,?,?,?,?,?,?,?,?)').run('v1-message','ws_ocean','v1-room',1,'user','v1-bot','actual schema5 synthetic history','2026-11-01T00:00:00.000Z',null,null);"""
seed=seed.replace("ocean_messages VALUES(?,?,?,?,?,?,?,?,?,?,?)", "ocean_messages VALUES(?,?,?,?,?,?,?,?,?,?)")
seed+="""assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0);db.close();fs.chmodSync(profile+'/runtime.sqlite',0o600);const manifest=await backupProfile(profile,backup);assert.equal(manifest.format,1);assert.equal(manifest.summary.schema,5);console.log(JSON.stringify(manifest));"""
for token,p in [('SCHEMA',old/'node_modules/@runnets/store-sqlite/dist/schema.js'),('JOURNAL',old/'node_modules/@runnets/store-sqlite/dist/tool-journal.js'),('OWNER',old/'node_modules/@runnets/store-sqlite/dist/ownership.js'),('BACKUP',old/'apps/cli/dist/ocean/snapshots.js')]:seed=seed.replace(token,repr(p.as_uri()))
ledger=[]
def run(args,codes=(0,)):
    r=subprocess.run(list(map(str,args)),capture_output=True,text=True,timeout=30)
    ledger.append({'argv':list(map(str,args)),'exit':r.returncode,'stdout':r.stdout,'stderr':r.stderr});(ROOT/'logs/v1-commands.json').write_text(json.dumps(ledger,indent=2)+'\n')
    assert r.returncode in codes,(r.returncode,r.stdout,r.stderr)
    return json.loads(r.stdout)
manifest=run(['node','--input-type=module','-e',seed,profile,backup,old]);
def snap(root):return {str(p.relative_to(root)):{'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'mode':p.stat().st_mode&511,'mtime_ns':p.stat().st_mtime_ns} for p in root.rglob('*') if p.is_file()}
sourcebefore=snap(profile);backupbefore=snap(backup);entry=ROOT/'prefix/bin/ocean'
def cli(*args,codes=(0,)):return run([entry,*args,'--profile',restored,'--json'],codes)
assert cli('restore','--from',backup)['data']['format']==1
history=cli('history','v1-room');assert history['data'][0]['body']=='actual schema5 synthetic history'
assert cli('doctor')['data']['database']['summary']['schema']==23
assert cli('runtime','start',codes=(4,))['error']['code']=='restore_restricted'
assert cli('send','v1-room','--text','must stay inert',codes=(4,))['error']['code']=='restore_restricted'
check="""import {DatabaseSync} from 'node:sqlite';import assert from 'node:assert/strict';const db=new DatabaseSync(process.argv[1],{readOnly:true});assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0);const rows=db.prepare('SELECT payload FROM ocean_model_connections').all().map(r=>JSON.parse(r.payload));assert.ok(rows.every(r=>r.intent==='unconfigured'&&r.configuredAfterRestore===false&&r.secretRef===null&&r.pendingRequest===null&&r.lastCheck===null));console.log(JSON.stringify({foreignKeys:0,unconfiguredLegacyConnections:rows.length,schema:db.prepare(\"SELECT value FROM meta WHERE key='schema_version'\").get().value}));db.close();"""
checked=run(['node','--input-type=module','-e',check,restored/'runtime.sqlite']);assert snap(profile)==sourcebefore;assert snap(backup)==backupbefore
proof={'tag':'v1.0.0','commit':commit,'capturedClosure':records,'compiler':'TypeScript5.9.3 transpileModule; original initializer and backup logic unchanged','historicalBridge':'public store-sqlite exports only original inspectDatabase/snapshotDatabase','sourceSchema':5,'format':1,'manifest':manifest,'restoredSchema':23,'historyPreserved':True,'sourceAndBackupUnchanged':True,'runtimeAndSendInert':True,**checked};(ROOT/'v1-proof.json').write_text(json.dumps(proof,indent=2)+'\n');print(json.dumps(proof,indent=2))
