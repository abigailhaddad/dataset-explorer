from playwright.sync_api import sync_playwright
import os
EXE=os.environ.get('CHROME_HEADLESS_SHELL')  # path to a Playwright chrome-headless-shell
U='http://127.0.0.1:8769/'
def ready(pg): pg.wait_for_function("document.querySelector('#listpane') && !document.querySelector('#listpane').hidden && document.querySelector('#listpane').dataset.loading==='0'", timeout=240000)
with sync_playwright() as p:
    b=p.chromium.launch(executable_path=EXE); pg=b.new_page(viewport={'width':1280,'height':900})
    errs=[]; pg.on('pageerror', lambda e: errs.append(str(e))); pg.on('console', lambda m: errs.append(m.text) if m.type=='error' else None)
    pg.goto(U+'?d=eeoc'); ready(pg)
    # popover filter
    pg.click('#addfilter'); print('popover open:', not pg.eval_on_selector('#filterpop','e=>e.hidden'), '| aria-expanded', pg.get_attribute('#addfilter','aria-expanded'), '| focus in popover:', pg.evaluate("document.getElementById('filterpop').contains(document.activeElement)"))
    pg.press('#fdcol','Escape'); print('Escape closes:', pg.eval_on_selector('#filterpop','e=>e.hidden'), '| focus back on button:', pg.evaluate("document.activeElement.id"))
    pg.click('#addfilter'); pg.select_option('#fdcol','agency'); pg.fill('#fdnarrow','Veterans')
    pg.check('#fdbody .opts label:not([hidden]) input'); pg.click('#fdapply'); ready(pg); pg.wait_for_timeout(500)
    print('after apply: chips', pg.eval_on_selector_all('.filter-chip','e=>e.map(x=>x.textContent)'), '| match', pg.inner_text('#matchbar'), '| url', pg.url.split('?')[1])
    # click outside closes
    pg.click('#addfilter'); pg.click('h1'); print('click outside closes:', pg.eval_on_selector('#filterpop','e=>e.hidden'))
    # tab switching is soft (engine stays)
    pg.evaluate("window.__marker=1"); pg.click('button[data-view="outcomes"]'); ready(pg); pg.wait_for_timeout(500)
    print('soft tab switch (same document):', pg.evaluate("window.__marker===1"), '| url', pg.url.split('?')[1], '| stats', pg.eval_on_selector_all('#stats .stat-card','e=>e.map(x=>x.innerText.replace(/\\n/g," "))'))
    pg.keyboard.press('Tab')
    # pager
    pg.click('button[data-view="table"]'); ready(pg)
    pg.click('#pager button[data-page="2"]'); ready(pg); print('pager to page 2 url', pg.url.split('?')[1], '| current', pg.inner_text('#pager .current'))
    pg.select_option('#pagesize','100'); ready(pg); print('size 100 -> rows', pg.eval_on_selector_all('#grid tbody tr','e=>e.length'), '| url', pg.url.split('?')[1])
    pg.click('#pager button:has-text("Last")'); ready(pg); print('last page:', pg.inner_text('#pager .current'), '| rows', pg.eval_on_selector_all('#grid tbody tr','e=>e.length'))
    # pivot sort
    pg.click('button[data-view="pivot"]'); ready(pg); pg.wait_for_timeout(500)
    first=pg.eval_on_selector('#pvresult tbody tr td','e=>e.textContent'); pg.click('#pvresult th[data-sort="__row"]'); pg.wait_for_timeout(300)
    asc=pg.eval_on_selector_all('#pvresult tbody tr td:first-child','e=>e.map(x=>x.textContent)')
    print('pivot sort by row asc sorted:', asc==sorted(asc, key=lambda s:s.lower()) , asc[:3], '| url', pg.url.split('?')[1])
    pg.select_option('#pvcol','representation'); ready(pg); pg.wait_for_timeout(500)
    print('pivot col added; headers', pg.eval_on_selector_all('#pvresult thead th','e=>e.map(x=>x.textContent)'), '| heat style on a cell:', pg.eval_on_selector('#pvresult tbody td.num','e=>e.style.background')[:60])
    print('errors', errs[:4])
    b.close()
