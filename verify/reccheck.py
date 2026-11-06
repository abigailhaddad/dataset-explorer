import sys, json, re
from urllib.parse import quote
import duckdb
from playwright.sync_api import sync_playwright
import os
EXE=os.environ.get('CHROME_HEADLESS_SHELL')  # path to a Playwright chrome-headless-shell
ds=sys.argv[1]; keys=sys.argv[2:]
cfg=json.load(open(f'configs/{ds}.json'))
c=duckdb.connect(); c.execute("install httpfs; load httpfs")
def urls_of(src):
    if src.get('discover'):
        import urllib.request
        d=src['discover']; j=json.load(urllib.request.urlopen(f"https://huggingface.co/api/datasets/{d['hfDataset']}/tree/main/{d['path']}"))
        return ['https://huggingface.co/datasets/%s/resolve/main/%s'%(d['hfDataset'],f['path']) for f in j if f['path'].endswith('.'+src['format'])]
    return src['urls']
fmt=cfg['source']['format']
def rel(urls):
    l='['+','.join("'"+u+"'" for u in urls)+']'
    return f"read_parquet({l}, union_by_name=true)" if fmt=='parquet' else f"read_csv({l}, header=true, all_varchar=true)"
main=rel(urls_of(cfg['source']))
frm=main+' AS m'
for i,j in enumerate(cfg.get('joins',[])):
    frm+=f" LEFT JOIN {rel(j['urls'])} AS j{i} ON m.\"{j['on']}\" = j{i}.\"{j['on']}\""
sel=[]
for col in cfg['columns']:
    k=col['key']
    if col.get('expr'): sel.append(f"({col['expr']}) AS \"{k}\""); continue
    ji=[j['id'] for j in cfg.get('joins',[])].index(col['join']) if col.get('join') else -1
    src=('j%d'%ji if ji>=0 else 'm')+'."'+col.get('from',k)+'"'
    t=col['type']
    sel.append({'number':f'try_cast({src} as double)','date':f'try_cast({src} as date)','bool':f'try_cast({src} as boolean)'}.get(t, f"nullif(cast({src} as varchar), '')")+f' AS "{k}"')
SQL="select "+", ".join(sel)+" from "+frm
colmap={x['key']:x for x in cfg['columns']}
def fmtv(col,v):
    if v is None or v=='': return '—'
    t=col['type']
    if t=='bool': return 'Yes' if v else 'No'
    if col.get('format')=='code':
        vl=col.get('valueLabels',{})
        if str(v) in vl: return vl[str(v)]
        w=str(v).replace('_',' '); return w[:1].upper()+w[1:]
    if t=='number':
        if col.get('format')=='currency': return '$'+f"{v:,.0f}"
        s=f"{v:,.2f}".rstrip('0').rstrip('.')
        return s
    return str(v)
rec=cfg['record']
bad=0; total=0
with sync_playwright() as p:
    b=p.chromium.launch(executable_path=EXE)
    pg=b.new_page(viewport={'width':1280,'height':900})
    errs=[]; pg.on('pageerror', lambda e: errs.append(str(e)))
    for key in keys:
        row=c.execute(f"select * from ({SQL}) where cast(\"{rec['key']}\" as varchar) = ?",[key]).fetchall()
        names=[d[0] for d in c.description]
        if not row: print('KEY NOT FOUND in source:',key); bad+=1; continue
        row=dict(zip(names,row[0]))
        pg.goto('http://127.0.0.1:8769/?d=%s&r=%s'%(ds,quote(key,safe='')))
        pg.wait_for_selector('#recordpane .rec-title', timeout=240000)
        pg.wait_for_timeout(2500)
        got=pg.evaluate("""()=>{
          const cards=[...document.querySelectorAll('#recordpane .rec-card')].map(c=>({title:c.querySelector('h2').textContent,
            fields:[...c.querySelectorAll('dl.fields')].length? [...c.querySelector('dl.fields').children].reduce((a,x,i,arr)=>{ if(x.tagName==='DT') a.push([x.textContent, arr[i+1].textContent]); return a;},[]):[],
            pre:[...c.querySelectorAll('pre.longtext')].map(x=>x.textContent),
            links:[...c.querySelectorAll('ul.rel-list a')].map(a=>[a.textContent,a.getAttribute('href')]),
            h3:[...c.querySelectorAll('h3')].map(x=>x.textContent)}));
          return {title:document.querySelector('#recordpane .rec-title').textContent, sub:(document.querySelector('#recordpane p.site-subtitle')||{}).textContent||'', cards, back:document.querySelector('#recordpane .back-link').getAttribute('href')};
        }""")
        print('\n== %s key=%s'%(ds,key[:60]))
        def tpl(t):
            return re.sub(r'\{(\w+)(:enc)?\}', lambda m:(quote(str(row[m.group(1)]),safe='') if m.group(2) else ('' if row[m.group(1)] is None else (str(row[m.group(1)])))), t)
        exp_title=next((t for t in (tpl(x).strip() for x in ([rec['title']] if isinstance(rec['title'],str) else rec['title'])) if t), str(row[rec['key']]))
        total+=1
        ok=got['title']==exp_title; bad+=0 if ok else 1; print(('OK  ' if ok else 'BAD ')+'title',repr(got['title'][:70]))
        if rec.get('subtitle'):
            es=re.sub(r'^[\s·]+|[\s·]+$','',tpl(rec['subtitle'])); total+=1
            ok=got['sub']==es; bad+=0 if ok else 1; print(('OK  ' if ok else 'BAD ')+'subtitle',repr(got['sub'][:70]), '' if ok else 'expected '+repr(es))
        shown={}
        for card in got['cards']:
            for lab,val in card['fields']: shown[(card['title'],lab)]=val
        n_ok=0
        for sec in rec['sections']:
            for k in sec['columns']:
                col=colmap[k]; exp=fmtv(col,row[k]); total+=1
                g=shown.get((sec['title'],col['label']))
                if g==exp: n_ok+=1
                else:
                    bad+=1; print('BAD field',sec['title'],'/',col['label'],'shown=',repr(g)[:80],'expected=',repr(exp)[:80])
        print('fields matching: %d'%n_ok)
        for t in rec.get('text',[]):
            col=colmap[t['column']]; v=row[t['column']]; total+=1
            card=[x for x in got['cards'] if x['title']==t['label']]
            g=card[0]['pre'][0] if card and card[0]['pre'] else '—'
            exp=str(v) if v not in (None,'') else '—'
            ok=g==exp; bad+=0 if ok else 1; print(('OK  ' if ok else 'BAD ')+'text '+t['label'], len(g),'chars')
        src=[x for x in got['cards'] if x['title']=='Source' and x['links']]
        exp_links=[]
        for l in rec.get('links',[]):
            si=l.get('showIf')
            if si and 'equals' in si and str(row[si['col']])!=si['equals']: continue
            if si and 'min' in si and not (float(row[si['col']] or 0)>=si['min']): continue
            h=tpl(l['href'])
            if h: exp_links.append((l['label'],h))
        gl=[(a,h.replace('%20',' ')) for a,h in (src[0]['links'] if src else [])]
        exp_links=[(a,h.replace('%20',' ')) for a,h in exp_links]  # the source data may hold the URL with or without %20
        total+=1; ok=gl==exp_links; bad+=0 if ok else 1
        print(('OK  ' if ok else 'BAD ')+'source links', gl if not ok else len(gl), '' if ok else 'expected %s'%exp_links)
        rel=[x for x in got['cards'] if x['title']=='Related']
        print('related:', [(h, ) for h in (rel[0]['h3'] if rel else [])])
        got_links={'src':gl}
        json.dump(got_links, open('verify/_l.json','w'))
    print('\nerrors:',errs[:3]); print('TOTAL checks',total,'mismatches',bad)
    b.close()
