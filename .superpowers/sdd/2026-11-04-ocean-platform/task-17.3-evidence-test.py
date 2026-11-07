"""Negative checks operate only on copied evidence, never candidate/runtime/profile files."""
import json,pathlib,runpy,shutil,sys,tempfile,unittest
PLAN=pathlib.Path(__file__).resolve().parent;api=runpy.run_path(str(PLAN/'task-17.3-evidence-validate.py'))
ROOT=pathlib.Path(sys.argv[1]).resolve();OUTPUT=pathlib.Path(sys.argv[2]).resolve();ANCHOR=sys.argv[3];sys.argv=[sys.argv[0]]
INVENTORY=api['load'](OUTPUT/'evidence-inventory.json')
class Evidence(unittest.TestCase):
    def setUp(self):
        self.root=pathlib.Path(tempfile.mkdtemp(prefix='negative-',dir=ROOT/'fix1'));self.output=self.root/OUTPUT.relative_to(ROOT)
        for name in INVENTORY['files']:
            target=self.root/name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(ROOT/name,target)
        for name in ['seal.json','evidence-inventory.json','stdout.log','stderr.log','invocation.json']:
            target=self.output/name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(OUTPUT/name,target)
    def tearDown(self):shutil.rmtree(self.root)
    def check(self):return api['validate_chain'](self.root,self.output,ANCHOR)
    def test_actual_seal_and_every_listed_file(self):
        self.assertGreater(self.check()['files'],60)
    def test_actual_tty_screen_tamper_invalidates_chain(self):
        path=self.root/'rebind-rehearsal/tty-confirm.json';path.write_bytes(path.read_bytes()+b'\nchanged')
        with self.assertRaisesRegex(ValueError,'evidence content changed'):self.check()
    def test_command_ledger_omission_even_from_both_manifest_lists_is_refused(self):
        inventory=json.loads(json.dumps(INVENTORY));name='rebind-rehearsal/commands.json';del inventory['files'][name];inventory['requiredFiles'].remove(name)
        with self.assertRaisesRegex(ValueError,'omission'):api['validate_inventory'](self.root,self.output,inventory)
    def test_shared_private_runner_tamper_invalidates_chain(self):
        path=self.output/'inputs/run-private.py';path.write_bytes(path.read_bytes()+b'\n#changed')
        with self.assertRaisesRegex(ValueError,'evidence content changed'):self.check()
    def test_freeze_stdout_tamper_invalidates_seal(self):
        (self.output/'stdout.log').write_text('changed\n')
        with self.assertRaisesRegex(ValueError,'sidecar changed'):self.check()
    def test_rehashed_tty_with_wrong_displayed_digest_is_refused(self):
        path=self.root/'rebind-rehearsal/tty-confirm.json';tty=api['load'](path);tty['preview']=tty['preview'].replace(tty['stdout']['data']['bindingDigest'],'0'*64);path.write_text(json.dumps(tty))
        inventory=json.loads(json.dumps(INVENTORY));inventory['files']['rebind-rehearsal/tty-confirm.json']={'sha256':api['sha'](path),'bytes':path.stat().st_size}
        with self.assertRaisesRegex(ValueError,'TTY card/digest mismatch'):api['validate_inventory'](self.root,self.output,inventory)
    def test_incidental_scratch_git_logs_are_not_selected(self):
        path=self.root/'scratch/.git/logs/HEAD';path.parent.mkdir(parents=True);path.write_text('unrelated scratch reflog')
        self.assertNotIn('scratch/.git/logs/HEAD',INVENTORY['files']);self.assertTrue(self.check()['actualTTYCardBound'])
unittest.main()
