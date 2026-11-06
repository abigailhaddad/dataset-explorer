import json
from checklib import *
L=f"read_parquet('{H}abigailhaddad/eeoc-appellate-decisions/resolve/main/listing.parquet')"
out=json.load(open('verify/out_eeoc-listing.json'))
for suf,w in [('',''),('+filter'," where ext='.pdf'")]:
    cov=out['coverage'+suf]; st=dict(cov['stats'])
    tot,dated=c.execute(f"select count(*), count(try_cast(posted_folder_date as date)) from {L}{w}").fetchone()
    T.chk('Files'+suf,n(st['Files']),tot); T.chk('Dated'+suf,n(st['Dated']),dated); T.chk('Undated'+suf,n(st['Undated']),tot-dated)
    ex=dict(c.execute(f"select substr(posted_folder_date,1,4) y,count(*) from {L}{w} group by 1 having y is not null and y<>''").fetchall())
    sh=rows_dict(chart(cov,'Files by year'))
    T.chk('Files by year 2021'+suf, sh.get('2021'), ex.get('2021')); T.chk('Files by year 2025 (gap)'+suf, sh.get('2025'), ex.get('2025',0))
    st_ch=chart(cov,'Files by month and type')
    tot_col=st_ch['head'].index('Total')
    mon={r[0]:n(r[tot_col]) for r in st_ch['rows']}
    exm=dict(c.execute(f"select substr(posted_folder_date,1,7) m,count(*) from {L}{w} group by 1 having m is not null and m<>''").fetchall())
    k=sorted(exm)[len(exm)//2]
    T.chk('Files by month '+k+suf, mon.get(k), exm[k]); T.chk('Months with zero files shown as 0'+suf, sum(1 for v in mon.values() if v==0)>0, True)
    items=rows_dict(chart(cov,'Dated and undated'))
    T.chk('Dated items'+suf, items['Dated'], dated)
    cr=out['crawl'+suf]
    fs=rows_dict(chart(cr,'First seen by month'))
    exf=dict(c.execute(f"select substr(first_seen,1,7) m,count(*) from {L}{w} group by 1 having m is not null and m<>''").fetchall())
    k=sorted(exf)[-1]; T.chk('First seen month '+k+suf, fs.get(k), exf[k])
T.done()
