import json
from checklib import *
base=f"{H}abigailhaddad/dod-daily-contracts/resolve/main/data/"
D="read_parquet(["+",".join(f"'{base}shard-0000{i}.parquet'" for i in range(3))+"])"
out=json.load(open('verify/out_dod-contracts.json'))
for suf,w in [('',''),('+filter'," where agency='NAVY'")]:
    b=out['branches'+suf]; st=dict(b['stats'])
    T.chk('Awards'+suf, n(st['Awards']), c.execute(f"select count(*) from {D}{w}").fetchone()[0])
    T.chk('Branches'+suf, n(st['Branches']), c.execute(f"select count(distinct agency) from {D}{w}").fetchone()[0])
    top=rows_dict(chart(b,'Awards by branch'))
    exb=dict(c.execute(f"select agency,count(*) from {D}{w} group by 1 order by 2 desc, 1 limit 12").fetchall())
    T.chk('Awards by branch'+suf, top, exb)
    mix=chart(b,'Branch mix by year'); tc=mix['head'].index('Total'); mm={r[0]:n(r[tc]) for r in mix['rows']}
    exy=dict(c.execute(f"select substr(date,1,4),count(*) from {D}{w} group by 1").fetchall())
    T.chk('Branch mix year 2020 total'+suf, mm.get('2020'), exy.get('2020'))
    co=out['companies'+suf]; cs=dict(co['stats'])
    T.chk('Name read'+suf, n(cs['Name read']), c.execute(f"select count(company) from {D}{w}").fetchone()[0])
    tcomp=rows_dict(chart(co,'Top companies'))
    exc=c.execute(f"select company,count(*) from {D}{w}{' and' if w else ' where'} company is not null group by 1 order by 2 desc, 1 limit 15").fetchall()
    T.chk('Top companies'+suf, list(tcomp.items())[:3], exc[:3])
    pl=out['places'+suf]; ps=dict(pl['stats'])
    ST="nullif(regexp_extract(place, ',\\s*([^,]+)$', 1), '')"
    T.chk('Place read'+suf, n(ps['Place read']), c.execute(f"select count(place) from {D}{w}").fetchone()[0])
    T.chk('States'+suf, n(ps['States']), c.execute(f"select count(distinct {ST}) from {D}{w}").fetchone()[0])
    ts=rows_dict(chart(pl,'Top states'))
    exs=c.execute(f"select {ST} s,count(*) from {D}{w} group by 1 having s is not null order by 2 desc, 1 limit 15").fetchall()
    T.chk('Top states'+suf, list(ts.items())[:3], exs[:3])
T.done()
