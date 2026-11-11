"""Checks on the template and the built site folders that need no network and no browser.
Run:  python3 scripts/build_sites.py && python3 scripts/test_build_sites.py
"""
import html, json, os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'scripts'))
from build_sites import SITES

bad = []


def chk(label, ok):
    print(('OK  ' if ok else 'BAD ') + label)
    if not ok:
        bad.append(label)


def read(*parts):
    return open(os.path.join(ROOT, *parts)).read()


# Every element app.js looks up by id exists in the template, once.
template = read('index.html')
ids_in_page = re.findall(r'\bid="([^"]+)"', template)
chk('no id appears twice in index.html', len(ids_in_page) == len(set(ids_in_page)))
script = read('app.js')
made_in_script = set(re.findall(r"\.id = '([A-Za-z0-9_-]+)'", script))   # the filter editor builds its own inputs
static_ids = set(re.findall(r"\bel\('([A-Za-z0-9_-]+)'\)", script)) - made_in_script
for i in sorted(static_ids):
    chk("app.js el('%s') exists in index.html" % i, i in ids_in_page)

# The list page keeps its order: toolbar, filter chips, views, totals, rows, charts, pivot.
order = ['id="keynote"', 'id="q"', 'id="chips"', 'id="viewtabs"', 'id="stats"', 'id="matchbar"',
         'id="tablesection"', 'id="charts"', 'id="pivotsection"']
at = [template.find(x) for x in order]
chk('list page order: ' + ' < '.join(x[4:-1] for x in order), -1 not in at and at == sorted(at))

for site in SITES:
    slug = site['slug']
    out = os.path.join(ROOT, 'dist-sites', slug)
    if not os.path.isdir(out):
        chk('%s: built folder exists (run scripts/build_sites.py first)' % slug, False)
        continue
    page = read('dist-sites', slug, 'index.html')
    index = json.loads(read('dist-sites', slug, 'configs', 'index.json'))
    blurb = html.escape([e for e in index if e['id'] == site['default']][0]['blurb'])
    chk('%s: meta description is the default table blurb' % slug, '<meta name="description" content="%s">' % blurb in page)
    chk('%s: og:description is the default table blurb' % slug, '<meta property="og:description" content="%s">' % blurb in page)
    chk('%s: og:title is the site title' % slug, '<meta property="og:title" content="%s">' % html.escape(site['title']) in page)
    chk('%s: no template placeholder text left' % slug, 'Dataset Explorer' not in page and 'Public records, read from Hugging Face.' not in page)
    chk('%s: 404.html exists and names the site' % slug, os.path.exists(os.path.join(out, '404.html')) and html.escape(site['title']) in read('dist-sites', slug, '404.html'))
    for ds in site['datasets']:
        cfg = json.loads(read('dist-sites', slug, 'configs', ds + '.json'))
        chk('%s/%s: has a covers line and at least one caveat' % (slug, ds), bool(cfg.get('covers')) and len(cfg.get('caveats') or []) >= 1)
    redirects = site.get('redirects')
    has_file = os.path.exists(os.path.join(out, '_redirects'))
    chk('%s: _redirects exists only when the site lists redirects' % slug, has_file == bool(redirects))
    if redirects:
        lines = [l.split() for l in read('dist-sites', slug, '_redirects').splitlines() if l.strip()]
        chk('%s: every redirect line is "from to 302"' % slug, all(len(l) == 3 and l[2] == '302' and l[0].startswith('/') for l in lines))
        chk('%s: each old address is listed with and without .html' % slug,
            sorted(l[0] for l in lines) == sorted(['/' + k for k in redirects] + ['/%s.html' % k for k in redirects]))
        targets = set(l[1] for l in lines)
        chk('%s: redirects point at the home page or one of the site\'s own tables' % slug,
            all(t == '/' or (t.startswith('/?d=') and t[4:] in site['datasets']) for t in targets))

print('checks failed:', len(bad))
sys.exit(1 if bad else 0)
