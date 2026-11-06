import json
from urllib.parse import quote
from playwright.sync_api import sync_playwright
import os
EXE=os.environ.get('CHROME_HEADLESS_SHELL')
U='http://127.0.0.1:8769/'
keys=json.load(open('verify/keys.json'))
def ready(pg): pg.wait_for_function("document.querySelector('#listpane') && !document.querySelector('#listpane').hidden && document.querySelector('#listpane').dataset.loading==='0'", timeout=240000)
def rec_ready(pg): pg.wait_for_selector('#recordpane .rec-title', timeout=240000); pg.wait_for_timeout(3500)
with sync_playwright() as p:
    b=p.chromium.launch(executable_path=EXE)
    errs=[]
    for w,tag in [(1280,'desktop'),(390,'phone')]:
        pg=b.new_page(viewport={'width':w,'height':900}); pg.on('pageerror', lambda e: errs.append(str(e)))
        for ds,ks in keys.items():
            key={'eeoc':ks[0],'eeoc-listing':ks[0],'opm-cba':ks[0],'federal-ja':ks[0],'dod-contracts':ks[1]}[ds]
            pg.goto(U+'?d=%s&r=%s'%(ds,quote(key,safe=''))); rec_ready(pg)
            pg.screenshot(path=f'screenshots/record-{ds}-{tag}.png', full_page=True)
        pg.close()
    pg=b.new_page(viewport={'width':1280,'height':900})
    for name,qs in [('table-eeoc','d=eeoc'),('view-eeoc-outcomes','d=eeoc&v=outcomes'),('view-opm-terminations','d=opm-cba&v=terminations'),('view-ja-authority','d=federal-ja&v=authority'),('view-eeoc-listing-coverage','d=eeoc-listing&v=coverage'),('view-dod-branches','d=dod-contracts&v=branches'),('pivot-eeoc','d=eeoc&v=pivot&pr=agency&pc=discrimination_found')]:
        pg.goto(U+'?'+qs); ready(pg); pg.wait_for_timeout(800); pg.screenshot(path=f'screenshots/{name}-desktop.png', full_page=True)
    pg.goto(U+'?d=eeoc-nope'); pg.wait_for_selector('#status .msg'); pg.screenshot(path='screenshots/unknown-id-desktop.png')
    pg.close()
    pg=b.new_page(viewport={'width':390,'height':900}, color_scheme='dark')
    for name,qs in [('view-opm-terminations-dark-phone','d=opm-cba&v=terminations'),('pivot-eeoc-phone','d=eeoc&v=pivot&pr=agency&pc=discrimination_found')]:
        pg.goto(U+'?'+qs); ready(pg); pg.wait_for_timeout(800); pg.screenshot(path=f'screenshots/{name}.png', full_page=True)
    pg.goto(U+'?d=eeoc'); ready(pg); pg.click('#addfilter'); pg.wait_for_timeout(300); pg.screenshot(path='screenshots/filter-popover-phone-dark.png')
    pg.close()
    # J&A attachments on request
    pg=b.new_page(viewport={'width':1280,'height':900})
    pg.goto(U+'?d=federal-ja&r=%s'%keys['federal-ja'][0]); rec_ready(pg)
    pg.click('button:has-text("Load attachments")'); pg.wait_for_selector('.more-item', timeout=240000)
    print('attachments loaded:', pg.eval_on_selector_all('.more-item h3','e=>e.map(x=>x.textContent)'), '| text details:', pg.eval_on_selector_all('.more-item details','e=>e.length'))
    pg.screenshot(path='screenshots/record-ja-attachments-desktop.png', full_page=True)
    print('errors', errs[:3]); b.close()
