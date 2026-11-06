import sys, json
from urllib.parse import quote
from playwright.sync_api import sync_playwright
import os
EXE=os.environ.get('CHROME_HEADLESS_SHELL')  # path to a Playwright chrome-headless-shell
base='http://127.0.0.1:8769/'
def run(jobs, outpath, width=1280, shots=None):
    res={}
    with sync_playwright() as p:
        b=p.chromium.launch(executable_path=EXE)
        pg=b.new_page(viewport={'width':width,'height':900})
        errs=[]
        pg.on('console', lambda m: errs.append(m.text) if m.type=='error' else None)
        pg.on('pageerror', lambda e: errs.append('pageerror '+str(e)))
        for name,qs in jobs:
            pg.goto(base+'?'+qs)
            try:
                pg.wait_for_function("document.querySelector('#listpane') && document.querySelector('#listpane').dataset.loading === '0'", timeout=180000)
            except Exception as e:
                res[name]={'error':'timeout','status':pg.inner_text('#status')[:300]}; continue
            pg.wait_for_timeout(300)
            data=pg.evaluate("""() => {
              const stats=[...document.querySelectorAll('#stats .stat-card')].map(c=>[c.querySelector('h3').textContent, c.querySelector('.stat-value').textContent]);
              const charts=[...document.querySelectorAll('#charts .chart-card')].map(c=>({title:c.querySelector('h3').textContent, foot:c.querySelector('.chart-foot').textContent,
                 head:[...c.querySelectorAll('table thead th')].map(x=>x.textContent),
                 rows:[...c.querySelectorAll('table tbody tr')].map(r=>[...r.children].map(x=>x.textContent))}));
              const pv=document.querySelector('#pvresult table');
              const pivot=pv?{head:[...pv.querySelectorAll('thead th')].map(x=>x.textContent), rows:[...pv.querySelectorAll('tbody tr')].map(r=>[...r.children].map(x=>x.textContent)), foot:[...pv.querySelectorAll('tfoot td')].map(x=>x.textContent), note:document.getElementById('pvnote').textContent}:null;
              return {stats,charts,pivot,match:document.getElementById('matchbar').textContent,heading:document.getElementById('blurb').textContent};
            }""")
            res[name]=data
            if shots and name in shots: pg.screenshot(path=shots[name], full_page=True)
        res['_errors']=errs[:10]
        b.close()
    json.dump(res, open(outpath,'w'), indent=1)
    return res
if __name__=='__main__':
    ds=sys.argv[1]; filt=sys.argv[2] if len(sys.argv)>2 else ''
    cfg=json.load(open(f'configs/{ds}.json'))
    jobs=[]
    for v in cfg['views']:
        jobs.append((v['id'], f'd={ds}&v={v["id"]}'))
        if filt: jobs.append((v['id']+'+filter', f'd={ds}&v={v["id"]}&{filt}'))
    r=run(jobs, f'verify/out_{ds}.json')
    print(json.dumps({k:(v if k=='_errors' else (v.get('error') or 'ok')) for k,v in r.items()}))
