#!/usr/bin/python3
"""Fixed, read-only new-host checks. Journal-only: no external alert delivery."""
import datetime,json,os,stat,subprocess,sys

def command(args):
    return subprocess.run(args,check=True,capture_output=True,text=True,timeout=8).stdout.strip()

report={'observed_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'checks':{},'alerts':[]}
try:
    md=open('/proc/mdstat',encoding='utf8').read()
    arrays=[line for line in md.splitlines() if 'blocks super' in line]
    report['checks']['mirrors_healthy']=len(arrays)==4 and all('[UU]' in line for line in arrays)
    report['checks']['mirror_sync_pending']=any(word in md for word in ('resync =','recovery =','reshape =','check ='))
    disk=os.statvfs('/srv')
    free=disk.f_bavail*disk.f_frsize
    total=disk.f_blocks*disk.f_frsize
    report['checks']['data_free_bytes']=free
    report['checks']['data_capacity_ok']=free>=128*1024**3 and free/total>=0.15
    sql="""BEGIN READ ONLY; SET LOCAL statement_timeout='2s'; SET LOCAL lock_timeout='200ms';
SELECT json_build_object('database',current_database(),'directory',current_setting('data_directory'),
 'listener_private',current_setting('listen_addresses')='',
 'socket_private',current_setting('unix_socket_permissions')='0700',
 'subscriptions',(SELECT count(*) FROM pg_subscription),
 'ready',(SELECT ready FROM analytics_public.coverage),
 'state',(SELECT state FROM analytics_public.coverage),
 'reader_dormant',(SELECT NOT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls FROM pg_roles WHERE rolname='ask_public_reader'),
 'reader_memberships',(SELECT count(*) FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='ask_public_reader')));
ROLLBACK;"""
    raw=command(['/usr/bin/psql','-X','-w','-At','-v','ON_ERROR_STOP=1','-d','ask_analytics','-c',sql])
    db=json.loads(next(line for line in raw.splitlines() if line.startswith('{')))
    report['checks']['database']=db
    report['checks']['bootstrap_database_boundary_ok']=all((db['database']=='ask_analytics',db['directory']=='/srv/analytics/postgresql/16/main',db['listener_private'],db['socket_private'],db['reader_dormant'],db['reader_memberships']==0))
    report['checks']['transport_active']=command(['/usr/bin/systemctl','is-active','zecblock-ask-source-transport.service'])=='active'
    sock=os.stat('/run/ask-source-transport/.s.PGSQL.15432')
    report['checks']['transport_socket_private']=stat.S_ISSOCK(sock.st_mode) and stat.S_IMODE(sock.st_mode)==0o660 and sock.st_gid==os.getgid()
    # This monitor is explicitly for the dormant bootstrap stage. A future launch
    # needs a reviewed policy/unit update rather than silent role activation.
    if db['subscriptions'] or db['ready'] or db['state']!='uninitialized':
        report['alerts'].append('bootstrap_stage_changed_review_monitor_policy')
    for key in ('mirrors_healthy','data_capacity_ok','bootstrap_database_boundary_ok','transport_active','transport_socket_private'):
        if report['checks'][key] is not True: report['alerts'].append(key)
except Exception as error:
    # Do not emit arbitrary SQL, credential-bearing messages or subprocess stderr.
    report['alerts'].append('probe_failed:'+type(error).__name__)
report['healthy']=not report['alerts']
report['external_alert_delivery']=False
print(json.dumps(report,sort_keys=True))
sys.exit(0 if report['healthy'] else 1)
