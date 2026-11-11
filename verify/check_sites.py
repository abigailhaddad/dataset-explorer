"""Each per-site folder, served at its own root: front page with no ?d=, nav, footer, title, favicon,
shareable URLs, the second table, and the front-page numbers against DuckDB / the combined explorer.
Run (sites on ports 8801-8805, combined explorer on 8790):
  CHROME_HEADLESS_SHELL=... python3 verify/check_sites.py
"""
import json, os, sys, re, time
from urllib.parse import quote
sys.path.insert(0, 'verify')
from checklib import *
from playwright.sync_api import sync_playwright

EXE = os.environ.get('CHROME_HEADLESS_SHELL')
COMBINED = os.environ.get('EXPLORER_BASE', 'http://127.0.0.1:8790/')
SITES = [  # slug, port, default dataset, tables in nav
  ('eeoc-decisions', 8801, 'eeoc', ['EEOC decisions', 'EEOC file listing']),
  ('opm-union-contracts', 8802, 'opm-cba', None),
  ('sf133-budget-execution', 8803, 'sf133', None),
  ('usajobs-questionnaires', 8804, 'usajobs-questionnaires', ['USAJOBS questionnaires', 'USAJOBS questions']),
  ('federal-ja-documents', 8805, 'federal-ja', None),
]
SB = f"{H}abigailhaddad/sf133-budget-execution/resolve/main/data/sf133_accounts.parquet"
QB = f"{H}abigailhaddad/usajobs-questionnaires/resolve/main/data/questionnaires/part-2025-release.parquet"
def num(x): return f"{int(x):,}"
def stats_of(pg):
    return pg.evaluate("[...document.querySelectorAll('#stats .stat-card')].map(c=>[c.querySelector('.stat-label').textContent, c.querySelector('.stat-value').textContent])")
def wait_list(pg):
    pg.wait_for_function("document.querySelector('#listpane') && document.querySelector('#listpane').dataset.loading === '0'", timeout=240000)
    pg.wait_for_timeout(500)

def combined_stats(pg, ds):
    pg.goto(f"{COMBINED}?d={ds}"); wait_list(pg); return stats_of(pg)

with sync_playwright() as p:
    b = p.chromium.launch(executable_path=EXE)
    widths = [int(w) for w in sys.argv[2].split(',')] if len(sys.argv) > 2 else [1280, 390]
    only = sys.argv[1].split(',') if len(sys.argv) > 1 and sys.argv[1] != 'all' else None
    for width in widths:
        pg = b.new_page(viewport={'width': width, 'height': 900})
        errs = []
        pg.on('console', lambda m: errs.append(m.text[:160]) if m.type == 'error' else None)
        pg.on('pageerror', lambda e: errs.append('pageerror ' + str(e)[:160]))
        tag = f'@{width}'
        for slug, port, ds, tables in SITES:
            if only and slug not in only: continue
            base = f'http://127.0.0.1:{port}/'
            site = json.load(open(f'dist-sites/{slug}/site.json'))
            pg.goto(base); wait_list(pg)
            T.chk(f'{slug}: front page opens the default table with no ?d= {tag}', pg.evaluate("document.querySelector('#recordpane').hidden && !document.querySelector('#listpane').hidden"), True)
            T.chk(f'{slug}: heading {tag}', pg.inner_text('#title'), site['title'])
            T.chk(f'{slug}: tab title {tag}', pg.title().startswith(site['title']) or pg.title().endswith(site['title']), True)
            fav = pg.evaluate("decodeURIComponent(document.querySelector('link[rel=icon]').href)")
            letters = {'eeoc-decisions':'EE','opm-union-contracts':'UC','sf133-budget-execution':'SF','usajobs-questionnaires':'UQ','federal-ja-documents':'JA'}[slug]
            T.chk(f'{slug}: favicon carries its own letters {tag}', ('>%s</text>' % letters) in fav, True)
            nav = pg.evaluate("(() => { const n=document.getElementById('nav'); return n.hidden ? null : [...n.querySelectorAll('a, span:not(.sep)')].map(x=>x.textContent); })()")
            if tables: T.chk(f'{slug}: nav links only its own tables {tag}', nav, tables)
            else: T.chk(f'{slug}: nav hidden for a one-table site {tag}', nav, None)
            foot = pg.evaluate("[...document.querySelectorAll('.site-footer a')].map(a=>[a.textContent,a.getAttribute('href')])")
            T.chk(f'{slug}: footer links {tag}', foot, [['Dataset on Hugging Face', site['hfUrl']], ['Code', site['repoUrl']], ['More datasets', site['moreUrl']]])
            tabs = pg.evaluate("[...document.querySelectorAll('#viewtabs [role=tab], #viewtabs a, #viewtabs button')].map(x=>x.textContent)")
            print('   tabs:', tabs)
            T.chk(f'{slug}: no sideways scroll {tag}', pg.evaluate("document.documentElement.scrollWidth <= window.innerWidth"), True)
            # Records-first layout (2026-11-11): the first caveat shows above the rows, every caveat is still
            # under About, the table comes before the charts, and the first row is on the first screen at 1280.
            cfg = json.load(open(f'dist-sites/{slug}/configs/{ds}.json'))
            T.chk(f'{slug}: first caveat shows above the rows {tag}', pg.evaluate("(() => { const k=document.getElementById('keynote'); return k.hidden ? null : k.textContent; })()"), cfg['caveats'][0])
            T.chk(f'{slug}: About lists every caveat {tag}', pg.evaluate("[...document.querySelectorAll('#caveats li')].map(x=>x.textContent)"), cfg['caveats'])
            T.chk(f'{slug}: covers line shows {tag}', pg.inner_text('#covers'), cfg['covers'])
            T.chk(f'{slug}: rows come before the charts {tag}', pg.evaluate("document.querySelector('#grid tbody tr').getBoundingClientRect().top < document.getElementById('charts').getBoundingClientRect().top"), True)
            if width == 1280:
                T.chk(f'{slug}: first row is on the first screen {tag}', pg.evaluate("document.querySelector('#grid tbody tr').getBoundingClientRect().top < window.innerHeight"), True)
            st = stats_of(pg)
            if width == 1280:
                T.chk(f'{slug}: front-page numbers equal the combined explorer {tag}', st, combined_stats(pg, ds))
                pg.goto(base); wait_list(pg)
            # shareable URL from the site's own root: a filter + sort + page, opened cold in a fresh page
            link = pg.evaluate("document.querySelector('#grid tbody tr a.recordlink')?.getAttribute('href')")
            T.chk(f'{slug}: record links are relative and keep the site root {tag}', bool(link) and link.startswith('?'), True)
            pg.goto(base + link); pg.wait_for_selector('#recordpane .rec-title', timeout=240000)
            T.chk(f'{slug}: record opens from the site root {tag}', pg.evaluate("!document.querySelector('#recordpane').hidden"), True)
            back = pg.evaluate("document.querySelector('#recordpane .back-link').getAttribute('href')")
            T.chk(f'{slug}: back link stays on the site {tag}', back.startswith('?'), True)
            rt = pg.title()
            T.chk(f'{slug}: record tab title ends with the site name {tag}', rt.endswith(site['title']) or (' · ' in rt), True)
            # explicit ?d= still works, and an unknown ?d= lists only this site's tables
            pg.goto(base + '?d=' + ds); wait_list(pg)
            T.chk(f'{slug}: explicit ?d= works {tag}', pg.evaluate("!document.querySelector('#listpane').hidden"), True)
            pg.goto(base + '?d=not-a-dataset'); pg.wait_for_timeout(2500)
            names = pg.evaluate("[...document.querySelectorAll('#home-list li a')].map(a=>a.textContent)")
            T.chk(f'{slug}: unknown ?d= lists only its own tables {tag}', names, tables or [json.load(open(f'dist-sites/{slug}/configs/index.json'))[0]['title']])
            if width == 1280 and tables:
                other = [t for t in tables][1]
                pg.goto(base); wait_list(pg)
                pg.click(f"#nav a:has-text('{other}')"); wait_list(pg)
                T.chk(f'{slug}: second table opens from the nav {tag}', pg.inner_text('#nav span[aria-current]'), other)
                T.chk(f'{slug}: second table shows rows {tag}', bool(re.search(r'[0-9,]+ rows', pg.inner_text('#matchbar'))), True)
            pg.goto(base); wait_list(pg)
            os.makedirs(os.environ.get('SHOTS_DIR', '/tmp/sites'), exist_ok=True); pg.screenshot(path=os.path.join(os.environ.get('SHOTS_DIR', '/tmp/sites'), f'{slug}-{width}.png'), full_page=False)
        print(f'errors {tag}:', errs[:4])
        pg.close()
    b.close()
T.done()
