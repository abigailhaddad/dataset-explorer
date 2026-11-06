import json, re
from checklib import *
def num(s):
    s=s.replace('$','').replace(',','').replace('%','')
    return float(s) if s not in ('','—') else 0.0
def compare(name, got, exp, tol=0.5):
    """got: pivot json; exp: dict (rowlabel,collabel)->value, collabel '' when no column field"""
    head=got['head']; rows=got['rows']
    two = 'Total' in head
    cols = head[1:-1] if two else ['']
    rowtot={}; colerr=0; cells=0
    for r in rows:
        lab=r[0]
        if two:
            for cl,v in zip(cols, r[1:-1]):
                if cl=='Other': continue
                cells+=1
                e=exp.get((lab,cl),0)
                if abs(num(v)-e)>tol: colerr+=1; print('  cell BAD',name,lab,cl,v,e)
            tot=num(r[-1])
        else:
            tot=num(r[1])
        e_tot=sum(v for (rl,cl),v in exp.items() if rl==lab)
        T.chk(f'{name} row total [{lab[:30]}]', round(tot), round(e_tot)) if len(rows)<=3 or rows.index(r)<3 else None
        if abs(tot-e_tot)>tol: T.bad+=1; print('  total BAD',name,lab,tot,e_tot)
    T.chk(f'{name}: {len(rows)} rows, {cells} cells compared, cell mismatches', colerr, 0)
    grand=sum(exp.values()); gt=num(got['foot'][-1] if not two else got['foot'][-1])
    if not two: gt=num(got['foot'][1])
    T.chk(f'{name} grand total', round(gt), round(grand))
def cells(sql):
    return {(('(blank)' if r[0] is None else str(r[0])),('' if len(r)<3 else ('(blank)' if r[1] is None else str(r[1])))):float(r[-1] or 0) for r in c.execute(sql).fetchall()}
# EEOC
D=f"read_parquet('{H}abigailhaddad/eeoc-appellate-decisions/resolve/main/extracted/decisions.parquet')"
pv=json.load(open('verify/pv_eeoc.json'))
compare('eeoc',pv['eeoc']['pivot'],cells(f"select agency, case when discrimination_found then 'Yes' else 'No' end, count(*) from {D} group by 1,2"))
compare('eeoc+filter',pv['eeoc+f']['pivot'],cells(f"select agency, case when discrimination_found then 'Yes' else 'No' end, count(*) from {D} where agency in ('United States Postal Service','Department of Veterans Affairs') group by 1,2"))
# listing
L=f"read_parquet('{H}abigailhaddad/eeoc-appellate-decisions/resolve/main/listing.parquet')"
pv=json.load(open('verify/pv_listing.json'))
Y="nullif(substr(posted_folder_date,1,4),'')"
compare('listing',pv['listing']['pivot'],cells(f"select {Y}, nullif(ext,''), count(*) from {L} group by 1,2"))
compare('listing+filter',pv['listing+f']['pivot'],cells(f"select {Y}, ext, count(*) from {L} where ext in ('.pdf','.txt') group by 1,2"))
# cba
A=f"read_csv('{H}abigailhaddad/opm-cba-agreements/resolve/main/agreements.csv',header=true,all_varchar=true)"
G="case when termination_flag in ('confirmed','confirmed_secondary') then 'Confirmed' when termination_flag='confirmed_then_reinstated' then 'Reinstated' when termination_flag='inferred' then 'Inferred' when termination_flag like 'uncertain%' then 'Uncertain' when termination_flag like 'not_flagged%' then 'Not flagged' end"
pv=json.load(open('verify/pv_cba.json'))
compare('cba',pv['cba']['pivot'],cells(f"select agencyName, {G}, count(*) from {A} group by 1,2"))
compare('cba+filter (pages sum)',pv['cba+f']['pivot'],cells(f"select laborUnionName, sum(try_cast(pages as double)) from {A} where {G}='Inferred' group by 1"))
# ja
B=f"{H}abigailhaddad/federal-ja-documents/resolve/main/"
J=f"read_parquet('{B}data/notices.parquet') n left join read_parquet('{B}analysis/extractions.parquet') x on n.notice_id=x.notice_id"
pv=json.load(open('verify/pv_ja.json'))
compare('ja (distinct matched awards by agency x matched)',pv['ja']['pivot'],cells(f"select n.agency, case when n.usaspending_matched then 'Yes' else 'No' end, count(distinct n.usaspending_award_key) from {J} group by 1,2"),tol=0)
compare('ja+filter (stated by authority)',pv['ja+f']['pivot'],cells(f"select x.authority_plain, sum(x.estimated_value_usd) from {J} where n.agency='VETERANS AFFAIRS, DEPARTMENT OF' group by 1"),tol=1)
# dod
base=f"{H}abigailhaddad/dod-daily-contracts/resolve/main/data/"
Dd="read_parquet(["+",".join(f"'{base}shard-0000{i}.parquet'" for i in range(3))+"])"
pv=json.load(open('verify/pv_dod.json'))
compare('dod',pv['dod']['pivot'],cells(f"select substr(date,1,4), agency, count(*) from {Dd} group by 1,2"))
ST="nullif(regexp_extract(place, ',\\s*([^,]+)$', 1), '')"
compare('dod+filter',pv['dod+f']['pivot'],cells(f"select {ST}, count(*) from {Dd} where agency='NAVY' group by 1"))
T.done()
