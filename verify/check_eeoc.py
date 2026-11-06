import json, duckdb
c=duckdb.connect(); c.execute("install httpfs; load httpfs")
H='https://huggingface.co/datasets/abigailhaddad/eeoc-appellate-decisions/resolve/main/'
D=f"read_parquet('{H}extracted/decisions.parquet')"
out=json.load(open('.scratch/out_eeoc.json'))
def n(s): return int(s.replace(',',''))
bad=0; checks=0
def chk(label, shown, expect):
    global bad, checks
    checks+=1
    ok = (str(shown)==str(expect))
    if not ok: bad+=1
    print(('OK  ' if ok else 'BAD ')+label, 'shown=',shown,'expected=',expect)
for suffix,where in [('',''),('+filter'," where agency='United States Postal Service'")]:
    q=lambda s: c.execute(s.replace('T',D+where)).fetchone()
    o=out['outcomes'+suffix]
    found,relief,changed,total=q("select count(*) filter(where discrimination_found), count(*) filter(where complainant_got_relief), count(*) filter(where commission_changed_result), count(*) from T")
    stats=dict(o['stats'])
    chk('outcomes Decisions'+suffix, n(stats['Decisions']), total)
    chk('outcomes Found'+suffix, n(stats['Found']), found)
    chk('outcomes Relief'+suffix, n(stats['Relief']), relief)
    chk('outcomes Result changed'+suffix, n(stats['Result changed']), changed)
    ch={x['title']:x for x in o['charts']}
    items={r[0]:n(r[1]) for r in ch['Outcomes']['rows']}
    chk('Outcomes chart found'+suffix, items['Discrimination found'], found)
    chk('Outcomes chart changed'+suffix, items['Commission changed result'], changed)
    top=ch['Found by agency']['rows'][0]
    ex=c.execute(f"select agency, count(*) filter(where discrimination_found) v from {D}{where} group by 1 order by v desc, agency limit 1").fetchone()
    chk('Found by agency top'+suffix, (top[0], n(top[1])), ex)
    yr={r[0]:n(r[1]) for r in ch['Found by year']['rows']}
    exy=dict(c.execute(f"select substr(decision_date,1,4), count(*) filter(where discrimination_found) from {D}{where} group by 1 having substr(decision_date,1,4) is not null and substr(decision_date,1,4)<>''").fetchall())
    chk('Found by year 2026'+suffix, yr.get('2026'), exy.get('2026'))
    b=out['bases'+suffix]; bc={x['title']:x for x in b['charts']}
    bases={r[0]:n(r[1]) for r in bc['Bases']['rows']}
    exb=c.execute(f"select count(*) filter(where basis_race), count(*) filter(where basis_reprisal), count(*) filter(where basis_race or basis_sex or basis_disability or basis_age or basis_reprisal) from {D}{where}").fetchone()
    chk('Bases race'+suffix, bases['Race'], exb[0]); chk('Bases reprisal'+suffix, bases['Reprisal'], exb[1])
    chk('Any basis'+suffix, n(dict(b['stats'])['Any basis']), exb[2])
    rate={r[0]:r[1] for r in bc['Found, by basis']['rows']}
    exr=c.execute(f"select round(100.0*count(*) filter(where basis_race and discrimination_found)/nullif(count(*) filter(where basis_race),0),1) from {D}{where}").fetchone()[0]
    chk('Found rate race'+suffix, rate['Race'], f"{exr:g}%")
    t=out['time'+suffix]; tc={x['title']:x for x in t['charts']}
    exd=c.execute(f"select count(try_cast(decision_date as date)) from {D}{where}").fetchone()[0]
    chk('Dated'+suffix, n(dict(t['stats'])['Dated']), exd)
print('checks',checks,'mismatches',bad)
