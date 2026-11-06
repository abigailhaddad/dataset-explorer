import json, re
from urllib.parse import quote, urlparse, parse_qs, unquote
import duckdb
from playwright.sync_api import sync_playwright
import os
EXE=os.environ.get('CHROME_HEADLESS_SHELL')  # path to a Playwright chrome-headless-shell
H='https://huggingface.co/datasets/abigailhaddad/eeoc-appellate-decisions/resolve/main/'
c=duckdb.connect(); c.execute("install httpfs; load httpfs")
D=f"read_parquet('{H}extracted/decisions.parquet')"
list_qs='f.agency=Department%20of%20Veterans%20Affairs&sort=decision_date&dir=desc&page=2&size=25'
with sync_playwright() as p:
    b=p.chromium.launch(executable_path=EXE); pg=b.new_page(viewport={'width':1280,'height':900})
    errs=[]; pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto('http://127.0.0.1:8769/?d=eeoc&'+list_qs)
    pg.wait_for_function("document.querySelector('#listpane').dataset.loading==='0'", timeout=120000)
    rows=pg.evaluate("[...document.querySelectorAll('#grid tbody tr')].map(r=>r.dataset.key)")
    print('list rows on page', len(rows), 'url', pg.url.split('?')[1][:90])
    exp=[r[0] for r in c.execute(f"select sha256 from {D} where agency='Department of Veterans Affairs' order by decision_date desc nulls last, sha256 limit 25 offset 25").fetchall()]
    print('page-2 order matches independent query:', rows==exp)
    # click the first row's link (soft navigation)
    pg.click('#grid tbody tr:nth-child(3) a.recordlink')
    pg.wait_for_selector('#recordpane .rec-title', timeout=60000); pg.wait_for_timeout(2500)
    u=pg.url; q=parse_qs(urlparse(u).query)
    print('record url has r=', q['r'][0]==rows[2], '| back=', q['back'][0])
    prev_href=pg.evaluate("[...document.querySelectorAll('.rec-sib a')].map(a=>[a.textContent,a.getAttribute('href')])")
    print('prev/next links:', [(t, parse_qs(urlparse(h).query)['r'][0][:12]) for t,h in prev_href])
    allv=[r[0] for r in c.execute(f"select sha256 from {D} where agency='Department of Veterans Affairs' order by decision_date desc nulls last, sha256").fetchall()]
    i=allv.index(rows[2])
    print('independent prev/next:', allv[i-1][:12], allv[i+1][:12])
    got={t:parse_qs(urlparse(h).query)['r'][0] for t,h in prev_href}
    print('prev ok:', got.get('← Previous')==allv[i-1], '| next ok:', got.get('Next →')==allv[i+1])
    # follow Next, then Back to results
    pg.click('.rec-sib a:has-text("Next")'); pg.wait_for_function("location.search.includes('r=%s')"%quote(allv[i+1],safe=''), timeout=30000); pg.wait_for_timeout(2500)
    pg.click('a.back-link'); pg.wait_for_function("document.querySelector('#listpane') && !document.querySelector('#listpane').hidden && document.querySelector('#listpane').dataset.loading==='0'", timeout=120000)
    print('back url:', pg.url.split('?')[1])
    st=pg.evaluate("({q:document.getElementById('q').value, chips:[...document.querySelectorAll('.filter-chip')].map(x=>x.textContent), pageinfo:document.querySelector('#pager .current')&&document.querySelector('#pager .current').textContent, size:document.getElementById('pagesize').value, sort:document.querySelector('#grid th[aria-sort]').textContent, keys:[...document.querySelectorAll('#grid tbody tr')].map(r=>r.dataset.key)})")
    print('restored:', {k:v for k,v in st.items() if k!='keys'}, '| same rows:', st['keys']==rows)
    # bad keys
    for bad in ['does-not-exist','']:
        pg.goto('http://127.0.0.1:8769/?d=eeoc&r='+bad); pg.wait_for_selector('#recordpane .rec-missing', timeout=60000)
        print('missing key', repr(bad), '->', pg.inner_text('#recordpane').replace('\n',' | ')[:160])
    pg.goto('http://127.0.0.1:8769/?d=eeoc'); pg.wait_for_function("document.querySelector('#listpane').dataset.loading==='0'", timeout=120000)
    print('errors', errs[:3])
    b.close()
