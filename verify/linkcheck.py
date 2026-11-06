import json, re, sys, urllib.request, urllib.error
from urllib.parse import quote
import duckdb
keys=json.load(open('verify/keys.json'))
c=duckdb.connect(); c.execute("install httpfs; load httpfs")
def urls_of(src):
    if src.get('discover'):
        d=src['discover']; j=json.load(urllib.request.urlopen(f"https://huggingface.co/api/datasets/{d['hfDataset']}/tree/main/{d['path']}"))
        return ['https://huggingface.co/datasets/%s/resolve/main/%s'%(d['hfDataset'],f['path']) for f in j if f['path'].endswith('.'+src['format'])]
    return src['urls']
def head(u):
    for method in ('HEAD','GET'):
        req=urllib.request.Request(u, method=method, headers={'User-Agent':'Mozilla/5.0 (Macintosh) dataset-explorer-linkcheck','Range':'bytes=0-0'})
        try:
            r=urllib.request.urlopen(req, timeout=30); return r.status
        except urllib.error.HTTPError as e:
            if method=='HEAD' and e.code in (403,405,501): continue
            return e.code
        except Exception as e:
            return type(e).__name__
    return '?'
for ds,ks in keys.items():
    cfg=json.load(open(f'configs/{ds}.json')); fmt=cfg['source']['format']
    def rel(urls):
        l='['+','.join("'"+u+"'" for u in urls)+']'
        return f"read_parquet({l}, union_by_name=true)" if fmt=='parquet' else f"read_csv({l}, header=true, all_varchar=true)"
    frm=rel(urls_of(cfg['source']))+' AS m'
    for i,j in enumerate(cfg.get('joins',[])): frm+=f" LEFT JOIN {rel(j['urls'])} AS j{i} ON m.\"{j['on']}\" = j{i}.\"{j['on']}\""
    sel=[]
    for col in cfg['columns']:
        k=col['key']
        if col.get('expr'): sel.append(f"({col['expr']}) AS \"{k}\""); continue
        ji=[j['id'] for j in cfg.get('joins',[])].index(col['join']) if col.get('join') else -1
        sel.append(('j%d'%ji if ji>=0 else 'm')+'."'+col.get('from',k)+'"'+f' AS "{k}"')
    SQL="select "+", ".join(sel)+" from "+frm
    rec=cfg['record']
    for key in ks:
        cur=c.execute(f"select * from ({SQL}) where cast(\"{rec['key']}\" as varchar)=?",[key]); row=dict(zip([d[0] for d in cur.description],cur.fetchall()[0]))
        for l in rec.get('links',[]):
            si=l.get('showIf')
            if si and 'equals' in si and str(row[si['col']])!=si['equals']: continue
            if si and 'min' in si and not (float(row[si['col']] or 0)>=si['min']): continue
            h=re.sub(r'\{(\w+)(:enc)?\}', lambda m:(quote(str(row[m.group(1)]),safe='') if m.group(2) else ('' if row[m.group(1)] is None else str(row[m.group(1)]))), l['href'])
            if not h: print(f"{ds:14} {l['label'][:28]:28} (empty link, not shown)"); continue
            print(f"{ds:14} {l['label'][:28]:28} {head(h.replace(' ','%20'))}  {h[:80]}")
