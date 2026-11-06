import json
from checklib import *
B=f"{H}abigailhaddad/federal-ja-documents/resolve/main/"
N=f"read_parquet('{B}data/notices.parquet')"; X=f"read_parquet('{B}analysis/extractions.parquet')"
J=f"{N} n left join {X} x on n.notice_id=x.notice_id"
out=json.load(open('verify/out_federal-ja.json'))
for suf,w in [('',''),('+filter'," where n.agency='VETERANS AFFAIRS, DEPARTMENT OF'")]:
    a=out['authority'+suf]; st=dict(a['stats'])
    r=c.execute(f"select count(*), count(*) filter(where x.status='extracted'), count(x.authority_plain) from {J}{w}").fetchone()
    T.chk('Notices'+suf,n(st['Notices']),r[0]); T.chk('Read'+suf,n(st['Read']),r[1]); T.chk('Authority found'+suf,n(st['Authority found']),r[2])
    top=rows_dict(chart(a,'Authority cited'))
    ex=c.execute(f"select x.authority_plain,count(*) from {J}{w} group by 1 having x.authority_plain is not null order by 2 desc,1 limit 8").fetchall()
    T.chk('Authority top 3'+suf,list(top.items())[:3],ex[:3])
    sc=chart(a,'Authority by agency'); tc=sc['head'].index('Total')
    T.chk('Authority by agency top total (authority read only)'+suf,(sc['rows'][0][0],n(sc['rows'][0][tc])), c.execute(f"select n.agency,count(*) from {J}{w}{' and' if w else ' where'} x.authority_plain is not null group by 1 order by 2 desc,1 limit 1").fetchone())
    v=out['value'+suf]; vs=dict(v['stats'])
    r=c.execute(f"select count(x.estimated_value_usd), count(*) filter(where x.value_redacted), median(x.estimated_value_usd) from {J}{w}").fetchone()
    T.chk('Stated'+suf,n(vs['Stated']),r[0]); T.chk('Redacted'+suf,n(vs['Redacted']),r[1]); T.chk('Median stated'+suf,n(vs['Median stated']),round(r[2]) if r[2] else None)
    items=rows_dict(chart(v,'Value found'))
    r2=c.execute(f"select count(*) filter(where x.status='extracted' and x.estimated_value_usd is null and not coalesce(x.value_redacted,false)) from {J}{w}").fetchone()[0]
    T.chk('Value found: neither'+suf,items['Read, neither'],r2)
    byag=chart(v,'Stated value by agency')['rows'][0]
    ex=c.execute(f"select n.agency, sum(x.estimated_value_usd) s from {J}{w} group by 1 having s is not null order by s desc,1 limit 1").fetchone()
    T.chk('Stated value by agency top'+suf,(byag[0],n(byag[1])),(ex[0],round(ex[1])))
    ve=out['vendors'+suf]; vv=dict(ve['stats'])
    r=c.execute(f"select count(x.vendor), count(distinct x.vendor) from {J}{w}").fetchone()
    T.chk('Vendors named'+suf,n(vv['Named']),r[0]); T.chk('Vendors distinct'+suf,n(vv['Distinct']),r[1])
    tv=rows_dict(chart(ve,'Top vendors'))
    ex=c.execute(f"select x.vendor,count(*) from {J}{w} group by 1 having x.vendor is not null order by 2 desc,1 limit 15").fetchall()
    T.chk('Top vendors first 3'+suf,list(tv.items())[:3],ex[:3])
    m=out['matched'+suf]; ms=dict(m['stats'])
    r=c.execute(f"select count(*) filter(where n.usaspending_matched), round(100.0*count(*) filter(where n.usaspending_matched)/count(*),1), count(distinct n.usaspending_award_key) from {J}{w}").fetchone()
    T.chk('Matched'+suf,n(ms['Matched']),r[0]); T.chk('Matched share'+suf,ms['Share'],f"{r[1]:g}%"); T.chk('Distinct awards'+suf,n(ms['Distinct awards']),r[2])
    mc=chart(m,'Matched by month'); hi=mc['head'].index('Matched'); 
    mm={row[0]:n(row[hi]) for row in mc['rows']}
    k=sorted(mm)[len(mm)//2]
    ex=c.execute(f"select count(*) filter(where n.usaspending_matched) from {J}{w}{' and' if w else ' where'} substr(cast(n.posted_date as varchar),1,7)='{k}'").fetchone()[0]
    T.chk('Matched in '+k+suf,mm[k],ex)
    sh=chart(m,'Matched share by agency')['rows'][0]
    ex=c.execute(f"select n.agency, round(100.0*count(*) filter(where n.usaspending_matched)/count(*),1) s from {J}{w} group by 1 having count(*)>=50 order by s desc,1 limit 1").fetchone()
    T.chk('Matched share top agency'+suf,(sh[0],sh[1]),(ex[0],f"{ex[1]:g}%"))
T.done()
