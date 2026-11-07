"""One gated, independently time-bounded orphan and mocked negative retirement paths."""
import importlib.util,json,os,pathlib,unittest
from unittest.mock import patch
P=pathlib.Path(__file__).resolve().parent

def load(name):
    spec=importlib.util.spec_from_file_location(name,P/('task-17.4-'+name+'.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
module=load('orphan-fixture')
class Scope(unittest.TestCase):
    def test_one_owned_orphan_after_verified_admission(self):
        root=pathlib.Path(os.environ['OCEAN_QA_FIX_RUN'])/'bounded-orphan'
        def body(proof,handle):
            self.assertLess(proof['ownershipVerifiedAt'],proof['orphan']['forkedAt']);self.assertEqual(proof['launcherExit'],0);self.assertTrue(proof['populatedAfterLauncher']['populated'])
            result=module.scope.retire(handle,term_seconds=.2,kill_seconds=2);proof['testedRetirement']=result;self.assertTrue(result['confirmed']);self.assertEqual([s['signal']for s in result['signals']],['TERM','KILL'])
        proof=module.run_case(root,'gated',body)
        self.assertIsNone(proof['originalError']);self.assertTrue(proof['cleanup']['confirmed']);self.assertTrue(proof['pidIdentityCheck']['confirmedGone']);self.assertTrue(proof['scopeEmpty'])
    def test_observation_failure_never_certifies_cleanup(self):
        def unavailable(_):raise OSError('synthetic observation unavailable')
        result=module.scope.retire({'unit':'not-targeted'},term_seconds=0,kill_seconds=0,observe=unavailable)
        self.assertFalse(result['confirmed']);self.assertTrue(result['errors']);self.assertEqual(result['signals'],[])
    def test_identity_verification_failure_never_signals(self):
        with patch.object(module.scope,'verify',side_effect=OSError('wrong InvocationID')):
            result=module.scope.retire({'unit':'not-targeted'},term_seconds=0,kill_seconds=0,observe=lambda _:{'gone':False,'populated':True,'procs':[123]})
        self.assertFalse(result['confirmed']);self.assertEqual(result['signals'],[])
if __name__=='__main__':unittest.main(verbosity=2)
