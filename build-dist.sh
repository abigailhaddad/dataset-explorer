#!/bin/sh
# Copy only what the site needs into dist/. Upload that folder to any static host.
set -e
cd "$(dirname "$0")"
rm -rf dist
mkdir -p dist/configs
cp index.html app.js style.css dist/
cp configs/*.json dist/configs/
# sanity: every config in the index exists, every file in configs/ parses
python3 - <<'PY'
import json, os
idx = json.load(open('dist/configs/index.json'))
for e in idx:
    assert os.path.exists('dist/configs/%s.json' % e['id']), 'missing config ' + e['id']
for f in os.listdir('dist/configs'):
    json.load(open('dist/configs/' + f))
print('dist/ ok:', len(idx), 'datasets')
PY
find dist -type f | sort
du -sh dist
