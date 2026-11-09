#!/usr/bin/env python3
"""Write one deploy-ready folder per dataset site under dist-sites/<slug>/.

Each folder holds the shared engine (index.html, app.js, style.css), site.json, and only that
site's config(s). Upload a folder to any static host, at its own root.

    python3 scripts/build_sites.py            # all sites
    python3 scripts/build_sites.py sf133-budget-execution

The combined explorer (index.html at the repo root, ./build-dist.sh) is unchanged.
"""
import html
import json
import os
import re
import shutil
import sys
import urllib.parse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'dist-sites')

# The adoption page, which links to every dataset. It is the only place this address lives.
MORE_DATASETS_URL = 'https://adopt.abigailhaddad.com'

GITHUB = 'https://github.com/'
HF = 'https://huggingface.co/datasets/'

SITES = [
    {'slug': 'eeoc-decisions', 'title': 'EEOC appellate decisions', 'default': 'eeoc',
     'datasets': ['eeoc', 'eeoc-listing'], 'hf': 'abigailhaddad/eeoc-appellate-decisions',
     'repo': 'abigailhaddad/eeoc-appellate-decisions', 'favicon': 'EE'},
    {'slug': 'opm-union-contracts', 'title': 'OPM union contracts', 'default': 'opm-cba',
     'datasets': ['opm-cba'], 'hf': 'abigailhaddad/opm-cba-agreements',
     'repo': 'abigailhaddad/opm-cba-archive', 'favicon': 'UC'},
    {'slug': 'sf133-budget-execution', 'title': 'SF-133 budget execution', 'default': 'sf133',
     'datasets': ['sf133'], 'hf': 'abigailhaddad/sf133-budget-execution',
     'repo': 'abigailhaddad/sf133-budget-execution', 'favicon': 'SF'},
    {'slug': 'usajobs-questionnaires', 'title': 'USAJOBS questionnaires', 'default': 'usajobs-questionnaires',
     'datasets': ['usajobs-questionnaires', 'usajobs-questions'], 'hf': 'abigailhaddad/usajobs-questionnaires',
     'repo': 'abigailhaddad/usajobs-questionnaires', 'favicon': 'UQ'},
    {'slug': 'federal-ja-documents', 'title': 'Federal J&A documents', 'default': 'federal-ja',
     'datasets': ['federal-ja'], 'hf': 'abigailhaddad/federal-ja-documents',
     'repo': 'abigailhaddad/federal-ja-documents', 'favicon': 'JA'},
    {'slug': 'dc-procurement', 'title': 'DC procurement', 'default': 'dc-contracts',
     'datasets': ['dc-contracts', 'dc-purchase-orders', 'dc-payments', 'dc-solicitations'],
     'hf': 'abigailhaddad/dc-procurement', 'repo': 'abigailhaddad/dc-software-procurement', 'favicon': 'DC'},
    {'slug': 'mspb-decisions', 'title': 'MSPB decisions', 'default': 'mspb',
     'datasets': ['mspb'], 'hf': 'abigailhaddad/mspb-decisions',
     'repo': 'abigailhaddad/mspb-decisions', 'favicon': 'MS'},
    {'slug': 'oira-meetings', 'title': 'OIRA EO 12866 meetings', 'default': 'oira',
     'datasets': ['oira'], 'hf': 'abigailhaddad/oira-eo12866-meetings',
     'repo': 'abigailhaddad/oira-meetings', 'favicon': 'OI'},
]


def favicon(text):
    svg = ("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><rect width='16' height='16' rx='3' fill='#2d6a4f'/>"
           "<text x='8' y='11.2' font-size='%s' font-family='sans-serif' font-weight='700' text-anchor='middle' fill='white'>%s</text></svg>"
           % ('8' if len(text) <= 2 else '6', html.escape(text)))
    return 'data:image/svg+xml,' + urllib.parse.quote(svg, safe="/:='")


def replace_once(text, old, new):
    assert text.count(old) == 1, 'expected one %r in index.html, found %d' % (old[:50], text.count(old))
    return text.replace(old, new)


def build(site):
    out = os.path.join(OUT, site['slug'])
    shutil.rmtree(out, ignore_errors=True)
    os.makedirs(os.path.join(out, 'configs'))
    index = json.load(open(os.path.join(ROOT, 'configs', 'index.json')))
    entries = [e for e in index if e['id'] in site['datasets']]
    assert [e['id'] for e in entries] == site['datasets'], 'index.json is missing a dataset for ' + site['slug']
    assert site['default'] in site['datasets']
    default_entry = next(e for e in entries if e['id'] == site['default'])

    for name in ('app.js', 'style.css'):
        shutil.copy(os.path.join(ROOT, name), out)
    page = open(os.path.join(ROOT, 'index.html')).read()
    t = html.escape(site['title'])
    page = replace_once(page, '<title>Dataset Explorer</title>', '<title>%s</title>' % t)
    page = re.sub(r'<link rel="icon" href="[^"]+">', '<link rel="icon" href="%s">' % favicon(site['favicon']), page, count=1)
    page = replace_once(page, '<h1 id="title">Dataset Explorer</h1>', '<h1 id="title">%s</h1>' % t)
    page = replace_once(page, 'Public records, read from Hugging Face.', html.escape(default_entry['blurb']))
    page = replace_once(page, '<body>', '<body data-site="1">')
    open(os.path.join(out, 'index.html'), 'w').write(page)

    ids = set(site['datasets'])
    for ds in site['datasets']:
        src = open(os.path.join(ROOT, 'configs', ds + '.json')).read()
        # a link from this site's configs must stay inside the site
        for m in re.findall(r'\?d=([a-z0-9-]+)', src) + re.findall(r'"link": "([a-z0-9-]+)"', src):
            assert m in ids, '%s links to %s, which is not in the %s site' % (ds, m, site['slug'])
        json.loads(src)
        open(os.path.join(out, 'configs', ds + '.json'), 'w').write(src)
    json.dump(entries, open(os.path.join(out, 'configs', 'index.json'), 'w'), indent=1)
    json.dump({
        'title': site['title'], 'pageTitle': site['title'], 'default': site['default'], 'datasets': site['datasets'],
        'hfUrl': HF + site['hf'], 'repoUrl': GITHUB + site['repo'],
        'moreLabel': 'More datasets', 'moreUrl': MORE_DATASETS_URL,
    }, open(os.path.join(out, 'site.json'), 'w'), indent=1)

    files = []
    for dp, _, fs in os.walk(out):
        for f in fs:
            p = os.path.join(dp, f)
            files.append((os.path.relpath(p, out), os.path.getsize(p)))
    files.sort()
    total = sum(s for _, s in files)
    print('%s: %d files, %.0f KB' % (site['slug'], len(files), total / 1024))
    for f, s in files:
        print('   %-42s %7.1f KB' % (f, s / 1024))


if __name__ == '__main__':
    want = sys.argv[1:]
    for s in SITES:
        if not want or s['slug'] in want:
            build(s)
