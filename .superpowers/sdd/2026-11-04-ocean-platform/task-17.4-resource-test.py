"""Exclusive publication controls on disposable files; original sealed bytes are read-only."""
import importlib.util,json,pathlib,subprocess,sys,unittest,hashlib,shutil,os
from unittest.mock import patch
P=pathlib.Path(__file__).resolve().parent;Q=pathlib.Path(json.loads((P/'task-17.4-location.json').read_text())['root']);F=Q/'fix1';legacy='--legacy' in sys.argv
if legacy:sys.argv.remove('--legacy')
else:
 spec=importlib.util.spec_from_file_location('resources',P/'task-17.4-resources.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class Resources(unittest.TestCase):
 def setUp(self):
  self.root=F/('resource-'+self._testMethodName+('-red-' if legacy else '-green-')+str(os.getpid()));self.root.mkdir(mode=0o700)
 def test_existing_dummy_never_truncated(self):
  target=self.root/'resources-summary.json';target.write_bytes(b'sealed-dummy-input');target.chmod(0o600);before=(target.read_bytes(),target.stat().st_mode)
  if legacy:
   driver=self.root/'legacy-resources.py';shutil.copyfile(F/'inputs/legacy-resources.py',driver);(self.root/'task-17.4-location.json').write_text(json.dumps({'root':str(self.root)}));r=subprocess.run(['python3',str(driver)],capture_output=True,text=True,timeout=10);rejected=r.returncode!=0
  else:
   try:module.publish(self.root);rejected=False
   except FileExistsError:rejected=True
  (self.root/'result.json').write_text(json.dumps({'rejected':rejected,'before':before[0].decode(),'after':target.read_bytes().decode(),'modeUnchanged':target.stat().st_mode==before[1]})+'\n')
  self.assertTrue(rejected);self.assertEqual((target.read_bytes(),target.stat().st_mode),before)
 @unittest.skipIf(legacy,'new exclusive publication case')
 def test_fresh_output_and_second_call_refusal(self):
  module.publish(self.root);target=self.root/'resources-summary.json';self.assertEqual(json.loads(target.read_text()),{});self.assertEqual(target.stat().st_mode&0o777,0o600)
  with self.assertRaises(FileExistsError):module.publish(self.root)
 @unittest.skipIf(legacy,'new exclusive publication case')
 def test_explicit_fresh_owned_output(self):
  parent=self.root/'fix1';parent.mkdir(mode=0o700);target=parent/'followup.json';module.publish(self.root,target);self.assertEqual(json.loads(target.read_text()),{});self.assertFalse((self.root/'resources-summary.json').exists())
 @unittest.skipIf(legacy,'new exclusive publication case')
 def test_symlink_and_outside_refused(self):
  parent=self.root/'fix1';parent.mkdir(mode=0o700);outside=self.root/'outside';outside.mkdir(mode=0o700);(parent/'link').symlink_to(outside,target_is_directory=True)
  for target in [parent/'link/out.json',outside/'out.json',parent/'../out.json']:
   with self.assertRaises(ValueError):module.publish(self.root,target)
  self.assertEqual(list(outside.iterdir()),[])
 @unittest.skipIf(legacy,'new exclusive publication case')
 def test_exclusive_create_race_preserves_competing_bytes(self):
  target=self.root/'resources-summary.json'
  real_open=os.open
  def race(name,flags,*args,**kwargs):
   if flags&os.O_CREAT:target.write_bytes(b'competing-input');target.chmod(0o600)
   return real_open(name,flags,*args,**kwargs)
  with patch.object(module.os,'open',side_effect=race),self.assertRaises(FileExistsError):module.publish(self.root)
  self.assertEqual(target.read_bytes(),b'competing-input');self.assertEqual(target.stat().st_mode&0o777,0o600)
 @unittest.skipIf(legacy,'new exclusive publication case')
 def test_real_sealed_default_refuses_without_mutation(self):
  target=Q/'resources-summary.json';before=(hashlib.sha256(target.read_bytes()).hexdigest(),target.stat().st_mode,target.stat().st_mtime_ns)
  with self.assertRaises(FileExistsError):module.publish(Q)
  self.assertEqual((hashlib.sha256(target.read_bytes()).hexdigest(),target.stat().st_mode,target.stat().st_mtime_ns),before)
if __name__=='__main__':unittest.main(verbosity=2)
