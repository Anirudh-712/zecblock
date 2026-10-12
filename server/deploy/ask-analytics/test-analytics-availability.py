import importlib.util,pathlib,unittest,json,types
spec=importlib.util.spec_from_file_location('analytics_alerts',pathlib.Path(__file__).with_name('analytics-availability.py'));a=importlib.util.module_from_spec(spec);spec.loader.exec_module(a)
class Probe(unittest.TestCase):
 def runner(self,healthy=True,datasets=True,worker=True):
  def run(args,**kwargs):
   self.assertLessEqual(kwargs['timeout'],20)
   if args[0]=='/usr/bin/python3':return types.SimpleNamespace(stdout=json.dumps({'healthy':healthy}),returncode=0)
   if args[0]=='/usr/bin/psql':
    self.assertIn('BEGIN READ ONLY',args[-1]);self.assertIn("statement_timeout='2s'",args[-1]);return types.SimpleNamespace(stdout=json.dumps({'verified_at':'2026-10-12 00:00:00+00','datasets_ready':datasets}),returncode=0)
   return types.SimpleNamespace(stdout='active' if worker else 'inactive',returncode=0 if worker else 1)
  return run
 def test_admission_datasets_and_worker_all_required(self):
  self.assertEqual(a.probe(self.runner())[0],[])
  for args,code in [({'healthy':False},'analytics_health_failed'),({'datasets':False},'datasets_unavailable'),({'worker':False},'query_worker_unavailable')]:self.assertIn(code,a.probe(self.runner(**args))[0])
 def test_unreadable_probe_is_never_healthy(self):
  def broken(*args,**kwargs):raise RuntimeError('secret fixture is never output')
  errors,_=a.probe(broken);self.assertEqual(errors,['analytics_probe_failed'])
if __name__=='__main__':unittest.main()
