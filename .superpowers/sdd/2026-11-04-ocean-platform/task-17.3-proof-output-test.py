"""Proof-output controls mutate only fresh owned dummy artifacts, never sealed real evidence."""
import hashlib,json,os,pathlib,shutil,subprocess,sys,tempfile,unittest
PLAN=pathlib.Path(__file__).resolve().parent;ROOT=pathlib.Path(sys.argv[1]);RED='--name-only-red' in sys.argv;sys.argv=[sys.argv[0]]
class Proof(unittest.TestCase):
    def setUp(self):
        self.root=pathlib.Path(tempfile.mkdtemp(prefix='proof-',dir=ROOT));self.artifact=self.root/'artifact';self.artifact.mkdir(mode=0o700);self.old=self.artifact/'rebind-proof.json';self.old.write_bytes(b'sealed original\n');self.old.chmod(0o600);self.original=self.fingerprint(self.old)
    def tearDown(self):
        try:
            if not RED:self.assertEqual(self.fingerprint(self.old),self.original,'old sealed bytes/mode must survive')
        finally:shutil.rmtree(self.root)
    def fingerprint(self,path):return {'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'mode':path.stat().st_mode&511}
    def node(self,body):
        helper=(PLAN/'task-17.3-proof-output.txt').read_text();code="import fs from 'node:fs';import path from 'node:path';const {prepareProofOutput}=await import('data:text/javascript,'+encodeURIComponent(process.env.HELPER));const artifact=process.env.ARTIFACT;"+body
        result=subprocess.run(['node','--input-type=module','-e',code],env=dict(os.environ,HELPER=helper,ARTIFACT=str(self.artifact)),capture_output=True,text=True,timeout=8)
        self.assertEqual(result.returncode,0,result.stderr);return json.loads(result.stdout)
    def test_name_only_fresh_rehearsal(self):
        if RED:
            raw=(ROOT.parent/'fix1/freeze-final/inputs/current/task-17.3-rebind-probe.txt').read_text();start=raw.index('fs.writeFileSync(path.join(artifact,process.env.OCEAN_QA_REBIND_PROOF');statement=raw[start:].split(';',1)[0]+';'
            code="import fs from 'node:fs';import path from 'node:path';const artifact=process.env.ARTIFACT,proof={synthetic:true};"+statement
            subprocess.run(['node','--input-type=module','-e',code],env=dict(os.environ,ARTIFACT=str(self.artifact),OCEAN_QA_REHEARSAL_NAME='fresh'),check=True)
            self.assertEqual(self.fingerprint(self.old),self.original)
        else:
            result=self.node("const p=prepareProofOutput(artifact,{rehearsal:'fresh'});p.write({synthetic:true});console.log(JSON.stringify({file:path.relative(artifact,p.proofPath),proof:JSON.parse(fs.readFileSync(p.proofPath,'utf8'))}));")
            self.assertEqual(result,{'file':'fresh/proof.json','proof':{'synthetic':True}})
    def refused(self,override,existing=False):
        result=self.node("let refused=false;try{prepareProofOutput(artifact,{rehearsal:'fresh',proof:"+json.dumps(override)+"});}catch(e){refused=true;}console.log(JSON.stringify({refused,created:fs.existsSync(path.join(artifact,'fresh'))}));")
        self.assertEqual(result,{'refused':True,'created':existing})
    def test_explicit_existing_proof(self):self.refused('rebind-proof.json')
    def test_traversal(self):self.refused('../escaped-proof.json');self.assertFalse((self.root/'escaped-proof.json').exists())
    def test_existing_escaping_parent_symlink(self):
        outside=self.root/'outside';outside.mkdir();(self.artifact/'fresh').symlink_to(outside,target_is_directory=True);self.refused('fresh/proof.json',existing=True);self.assertEqual(list(outside.iterdir()),[])
    def test_valid_new_explicit_destination(self):
        result=self.node("const p=prepareProofOutput(artifact,{rehearsal:'fresh',proof:'fresh/new.json'});p.write({valid:true});console.log(JSON.stringify({file:path.relative(artifact,p.proofPath),mode:fs.statSync(p.proofPath).mode&511}));")
        self.assertEqual(result,{'file':'fresh/new.json','mode':0o600})
    def test_exclusive_write_race_preserves_existing_bytes(self):
        result=self.node("const p=prepareProofOutput(artifact,{rehearsal:'fresh'});fs.writeFileSync(p.proofPath,'racer',{mode:384});let refused=false;try{p.write({overwrite:true});}catch(e){refused=true;}console.log(JSON.stringify({refused,body:fs.readFileSync(p.proofPath,'utf8'),mode:fs.statSync(p.proofPath).mode&511}));")
        self.assertEqual(result,{'refused':True,'body':'racer','mode':0o600})
    def test_parent_replacement_symlink_is_refused(self):
        outside=self.root/'outside';outside.mkdir()
        result=self.node("const p=prepareProofOutput(artifact,{rehearsal:'fresh'});fs.renameSync(p.root,p.root+'-held');fs.symlinkSync(path.join(artifact,'..','outside'),p.root);let refused=false;try{p.write({escape:true});}catch(e){refused=true;}console.log(JSON.stringify({refused}));")
        self.assertTrue(result['refused']);self.assertEqual(list(outside.iterdir()),[])
if RED:
    result=unittest.TextTestRunner().run(unittest.TestSuite([Proof('test_name_only_fresh_rehearsal')]));raise SystemExit(not result.wasSuccessful())
unittest.main()
