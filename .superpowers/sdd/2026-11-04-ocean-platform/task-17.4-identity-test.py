"""Copied actual samples and exact legacy predicate regression; no model execution."""
import copy,importlib.util,json,pathlib,sys,unittest,textwrap
P=pathlib.Path(__file__).resolve().parent;Q=pathlib.Path(json.loads((P/'task-17.4-location.json').read_text())['root']);F=Q/'fix1'
legacy='--legacy' in sys.argv
if legacy:sys.argv.remove('--legacy')
else:
    spec=importlib.util.spec_from_file_location('identities',P/'task-17.4-identities.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
def rows(phase):return [json.loads(x) for x in (F/'inputs'/phase/'samples.jsonl').read_text().splitlines()]
OFF=rows('offline-acceptance4');ON=rows('online-mixed');NET='net:[4026532987]';OUTER='net:[4026531833]'
HOST={'uid':1000,'CapEff':'0000000000000000','CapBnd':'000001ffffffffff','NoNewPrivs':'0'}
def evaluate(samples,policy='native-offline'):
    if legacy:
        if policy=='mixed-online':return {'ok':True}
        seen={(v['pid'],v['starttime']):v for row in samples for v in row['processes']};record={};network={'namespace':NET}
        source=(F/'inputs/legacy-supervise.py').read_text();code=source[source.index("    actual=[v for v in seen.values()"):source.index('# The listening address')]
        exec(textwrap.dedent(code),{'seen':seen,'network':network,'record':record})
        return {'ok':record['backendClientNamespacesMatch']}
    return module.validate(samples,policy,NET if policy!='mixed-online' else OUTER,OUTER,HOST)
def mutate(samples,predicate,field,value,once=False):
    result=copy.deepcopy(samples);done=False
    for row in result:
        for p in row['processes']:
            if predicate(p) and (not once or not done):p[field]=value;done=True
    assert done;return result
class Identities(unittest.TestCase):
    def test_offline_complete_actual_roles(self):self.assertTrue(evaluate(OFF)['ok'])
    def test_online_complete_actual_normal_policy(self):self.assertTrue(evaluate(ON,'mixed-online')['ok'])
    def test_missing_node_clients_refused(self):self.assertFalse(evaluate([dict(r,processes=[p for p in r['processes'] if p['name'] not in ['node','node-MainThread']])for r in OFF])['ok'])
    def test_missing_history_client_refused(self):self.assertFalse(evaluate([dict(r,processes=[p for p in r['processes'] if '/launch.js history ' not in p.get('argv','')])for r in OFF])['ok'])
    def test_missing_runner_refused(self):self.assertFalse(evaluate([dict(r,processes=[p for p in r['processes'] if p['name']!='llama-server'])for r in OFF])['ok'])
    def test_wrong_runner_namespace_refused(self):self.assertFalse(evaluate(mutate(OFF,lambda p:p['name']=='llama-server','netns',OUTER))['ok'])
    def test_transient_wrong_client_namespace_refused(self):self.assertFalse(evaluate(mutate(OFF,lambda p:p['name']=='node-MainThread','netns',OUTER,True))['ok'])
    def test_wrong_client_capability_refused(self):self.assertFalse(evaluate(mutate(OFF,lambda p:p['name']=='node-MainThread','CapEff','0000000000202000'))['ok'])
    def test_wrong_runner_bounding_refused(self):self.assertFalse(evaluate(mutate(OFF,lambda p:p['name']=='llama-server','CapBnd','000001ffffffffff'))['ok'])
    def test_wrong_no_new_privileges_refused(self):self.assertFalse(evaluate(mutate(OFF,lambda p:p['name']=='llama-server','NoNewPrivs','0'))['ok'])
    def test_online_wrong_capability_refused(self):self.assertFalse(evaluate(mutate(ON,lambda p:p['name']=='node-MainThread','CapEff','0000000000002000'),'mixed-online')['ok'])
    def test_online_wrong_nnp_refused(self):self.assertFalse(evaluate(mutate(ON,lambda p:p['name']=='node-MainThread','NoNewPrivs','1'),'mixed-online')['ok'])
    def test_invalid_identity_refused(self):self.assertFalse(evaluate(mutate(OFF,lambda p:p['name']=='llama-server','starttime',''))['ok'])
    def test_metadata_requires_backend_and_driver_not_runner(self):
        subset=[dict(r,processes=[p for p in r['processes'] if p['name']=='ollama' or (p['name']=='node-MainThread' and '--input-type=module' in p.get('argv',''))])for r in OFF]
        self.assertTrue(evaluate(subset,'metadata-offline')['ok'])
        self.assertFalse(evaluate(subset)['ok'])
if __name__=='__main__':unittest.main(verbosity=2)
