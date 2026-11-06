"""Questionnaire outline on record pages, and the lazy 'same wording' list on question pages, against DuckDB.
Run:  EXPLORER_BASE=http://127.0.0.1:8790/ CHROME_HEADLESS_SHELL=... python3 verify/check_outline.py
"""
import json, os, sys, time
from urllib.parse import quote
sys.path.insert(0, 'verify')
from checklib import *
from playwright.sync_api import sync_playwright

B = f"{H}abigailhaddad/usajobs-questionnaires/resolve/main/data/"
QS = f"read_parquet('{B}questions/part-2025-release.parquet')"
SE = f"read_parquet('{B}sections/part-2025-release.parquet')"
base = os.environ.get('EXPLORER_BASE', 'http://127.0.0.1:8769/')
keys = json.load(open('verify/keys_new.json'))
qids = keys['usajobs-questionnaires']
EXE = os.environ.get('CHROME_HEADLESS_SHELL')
with sync_playwright() as p:
    b = p.chromium.launch(executable_path=EXE)
    pg = b.new_page(viewport={'width': 1280, 'height': 900})
    errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)[:200]))
    for qid in qids:
        rows = c.execute(f"select block_index, section, question_ordinal, question_number, question_text, question_type, coalesce(list_transform(options, o -> coalesce(o.letter || '. ', '') || o.\"text\"), []) opts, trailing_text from {QS} where questionnaire_id=? order by block_index, question_ordinal", [qid]).fetchall()
        intros = {r[0]: r[1] for r in c.execute(f"select block_index, intro_text from {SE} where questionnaire_id=?", [qid]).fetchall() if r[1]}
        pg.goto(f"{base}?d=usajobs-questionnaires&r={quote(qid)}")
        pg.wait_for_selector('#recordpane .rec-title', timeout=240000)
        t0 = time.time()
        pg.wait_for_function("(() => { const o=document.querySelector('#recordpane .outline'); return o && !o.textContent.startsWith('Reading the questions'); })()", timeout=180000)
        got = pg.evaluate("""() => {
          const o=document.querySelector('#recordpane .outline');
          const secs=[...o.querySelectorAll('h3.outline-section')].map(h=>h.childNodes[0].textContent);
          const qs=[...o.querySelectorAll('ol.outline-list > li')].map(li=>({n:li.value, text:li.querySelector('a.outline-q').textContent,
             type:(li.querySelector(':scope > span.tag')||{}).textContent||'',
             opts:[...li.querySelectorAll('ul.outline-options > li')].map(x=>x.textContent),
             href:li.querySelector('a.outline-q').getAttribute('href')}));
          return {secs, qs, text:o.textContent.slice(0,200)};
        }""")
        n_exp = len(rows)
        T.chk(f'{qid}: questions shown', len(got['qs']), n_exp)
        if n_exp:
            T.chk(f'{qid}: question texts in order', [q['text'] for q in got['qs']], [r[4] or '(no text)' for r in rows])
            T.chk(f'{qid}: options per question', [q['opts'] for q in got['qs']], [list(r[6]) for r in rows])
            T.chk(f'{qid}: question numbers (where the file has one)', [q['n'] for q, r in zip(got['qs'], rows) if r[3] is not None], [r[3] for r in rows if r[3] is not None])
            T.chk(f'{qid}: links go to question pages', all(q['href'] and q['href'].startswith('?d=usajobs-questions&r=') for q in got['qs']), True)
            seen = []
            for r in rows:
                if not seen or seen[-1][0] != r[0]: seen.append((r[0], r[1] or 'Questions'))
            T.chk(f'{qid}: section headings', got['secs'], [s for _, s in seen])
        else:
            T.chk(f'{qid}: empty message shown', 'No questions are stored' in got['text'], True)
    # the lazy "same wording" list
    for qk in [keys['usajobs-questions'][0], keys['usajobs-questions'][4]]:
        txt = c.execute(f"select question_text from {QS} where question_id=?", [qk]).fetchone()[0]
        n_exp = c.execute(f"select count(*) from {QS} where question_text=? and question_id<>?", [txt, qk]).fetchone()[0]
        pg.goto(f"{base}?d=usajobs-questions&r={quote(qk)}")
        pg.wait_for_selector('#recordpane .rec-title', timeout=240000)
        btn = pg.wait_for_selector('#recordpane .rel-lazy button', timeout=60000)
        before = pg.evaluate("document.querySelectorAll('#recordpane .rel-list li').length")
        t0 = time.time(); btn.click()
        pg.wait_for_function("(() => [...document.querySelectorAll('#recordpane h3')].some(h=>/with this exact wording/.test(h.textContent)))()", timeout=240000)
        el = round(time.time() - t0, 1)
        head = pg.evaluate("[...document.querySelectorAll('#recordpane h3')].find(h=>/with this exact wording/.test(h.textContent)).textContent")
        shown = int(head.split('(')[1].split(')')[0].replace(',', ''))
        T.chk(f'{qk}: questionnaires with this exact wording (lazy, {el}s)', shown, n_exp)
    print('page errors:', errs[:3])
    b.close()
T.done()
