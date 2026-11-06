import json
from checklib import *
A=f"read_csv('{H}abigailhaddad/opm-cba-agreements/resolve/main/agreements.csv',header=true,all_varchar=true)"
out=json.load(open('verify/out_opm-cba.json'))
G="case when termination_flag in ('confirmed','confirmed_secondary') then 'Confirmed' when termination_flag='confirmed_then_reinstated' then 'Reinstated' when termination_flag='inferred' then 'Inferred' when termination_flag like 'uncertain%' then 'Uncertain' when termination_flag like 'not_flagged%' then 'Not flagged' end"
for suf,w in [('',''),('+filter'," where agencyName='Department of Defense'")]:
    t=out['terminations'+suf]; st=dict(t['stats'])
    ex=dict(c.execute(f"select {G} g,count(*) from {A}{w} group by 1").fetchall())
    for k in ['Confirmed','Inferred','Uncertain','Not flagged','Reinstated']:
        T.chk(k+suf, n(st[k]), ex.get(k,0))
    sc=chart(t,'Flags by agency'); tc=sc['head'].index('Total')
    shown={r[0]:n(r[tc]) for r in sc['rows']}
    exa=dict(c.execute(f"select agencyName,count(*) from {A}{w} group by 1 order by 2 desc, 1 limit 10").fetchall())
    T.chk('Flags by agency top total (same set, tie order ignored)'+suf, shown==exa, True)
    ii=sc['head'].index('Inferred') if 'Inferred' in sc['head'] else None
    if ii is not None:
        exi=dict(c.execute(f"select agencyName,count(*) from {A}{w} {'and' if w else 'where'} {G}='Inferred' group by 1").fetchall())
        T.chk('Inferred by agency (top row)'+suf, n(sc['rows'][0][ii]), exi.get(sc['rows'][0][0],0))
    e=out['expirations'+suf]; es=dict(e['stats'])
    ex2=c.execute(f"select count(*) filter(where try_cast(expirationDate as date) < current_date), count(*) filter(where try_cast(expirationDate as date) is null) from {A}{w}").fetchone()
    T.chk('Expired'+suf, n(es['Expired']), ex2[0]); T.chk('No date'+suf, n(es['No date']), ex2[1])
    yr=rows_dict(chart(e,'Expiring by year'))
    exy=dict(c.execute(f"select substr(expirationDate,1,4) y,count(*) from {A}{w} group by 1 having y<>'' ").fetchall())
    T.chk('Expiring 2027'+suf, yr.get('2027'), exy.get('2027'))
    d=out['documents'+suf]; ds=dict(d['stats'])
    ex3=c.execute(f"select count(*) filter(where download_status='ok'), count(*) filter(where text_status='text'), sum(try_cast(pages as double)), sum(try_cast(words as double)) from {A}{w}").fetchone()
    T.chk('Downloaded'+suf, n(ds['Downloaded']), ex3[0]); T.chk('With text'+suf, n(ds['With text']), ex3[1]); T.chk('Pages'+suf, n(ds['Pages']), int(ex3[2])); T.chk('Words'+suf, n(ds['Words']), int(ex3[3]))
T.done()
