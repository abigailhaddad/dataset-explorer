"""First-open time and phone-width overflow for each DC table. EXPLORER_BASE and CHROME_HEADLESS_SHELL must be set."""
import os, time, json
from playwright.sync_api import sync_playwright
base = os.environ['EXPLORER_BASE']; exe = os.environ['CHROME_HEADLESS_SHELL']
pages = [('dc-contracts', 'table'), ('dc-purchase-orders', 'table'), ('dc-payments', 'table'), ('dc-solicitations', 'table')]
res = {}
with sync_playwright() as p:
    b = p.chromium.launch(executable_path=exe)
    for width in (1280, 390):
        for ds, v in pages:
            ctx = b.new_context(viewport={'width': width, 'height': 900})
            pg = ctx.new_page()
            t = time.time()
            pg.goto(f'{base}?d={ds}&v={v}')
            pg.wait_for_function("document.querySelector('#listpane') && document.querySelector('#listpane').dataset.loading === '0'", timeout=240000)
            secs = round(time.time() - t, 1)
            ov = pg.evaluate("() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]")
            res[f'{ds}@{width}'] = {'seconds': secs, 'scrollWidth': ov[0], 'clientWidth': ov[1]}
            if ds in ('dc-contracts', 'dc-payments'):
                pg.screenshot(path=f'screenshots/dc-{ds[3:]}-{width}.png', full_page=(width == 390 and False))
            ctx.close()
    b.close()
json.dump(res, open('verify/out_dc_load.json', 'w'), indent=1)
for k, v in res.items(): print(k, v)
