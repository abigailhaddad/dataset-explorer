"""USAJOBS questionnaires and questions: stats, charts and pivots against DuckDB on the published files.
Run:  EXPLORER_BASE=http://127.0.0.1:8790/ CHROME_HEADLESS_SHELL=... python3 verify/check_questionnaires.py
"""
import os, sys
sys.path.insert(0, 'verify')
import drive
from checklib import *

B = f"{H}abigailhaddad/usajobs-questionnaires/resolve/main/data/"
# Every published part file, not the explorer's trimmed copy, so this checks the page against the record.
import json, urllib.request
QPARTS = ', '.join(f"'{H}abigailhaddad/usajobs-questionnaires/resolve/main/{f['path']}'" for f in json.load(urllib.request.urlopen(
    'https://huggingface.co/api/datasets/abigailhaddad/usajobs-questionnaires/tree/main/data/questionnaires')) if f['path'].endswith('.parquet'))
QQ = f"(select * replace (nullif(position_title,'') as position_title, nullif(agency,'') as agency, nullif(hiring_agency,'') as hiring_agency, nullif(announcement_number,'') as announcement_number, nullif(occupation_series,'') as occupation_series) from read_parquet([{QPARTS}], union_by_name=true))"
def num(x): return f"{int(x):,}"
def med(x): return f"{x:,.2f}".rstrip('0').rstrip('.') if x is not None else '—'

F1 = [('', '', ''), ('+agency', 'f.agency=Veterans', " where agency ilike '%Veterans%'"), ('+kind', 'f.hiring_agency=Department%20of%20Defense', " where hiring_agency='Department of Defense'")]
jobs = []
for suf, qs, _ in F1:
    for v in ['table', 'agencies', 'time', 'quality']:
        jobs.append((v + suf, f'd=usajobs-questionnaires&v={v}' + ('&' + qs if qs else '')))
out = drive.run(jobs, 'verify/out_usajobs-questionnaires.json')
print('page errors:', out.get('_errors'))
for suf, _, w in F1:
    and_ = ' and' if w else ' where'
    t = out['table' + suf]; st = dict(t['stats'])
    r = c.execute(f"select count(*), sum(n_questions), count(distinct agency), median(n_questions) from {QQ}{w}").fetchone()
    T.chk('Questionnaires' + suf, st['Questionnaires'], num(r[0])); T.chk('Questions' + suf, st['Questions'], num(r[1]))
    T.chk('Agencies' + suf, st['Agencies'], num(r[2])); T.chk('Median length' + suf, st['Median length'], med(r[3]))
    ch = {x['title']: x for x in t['charts']}
    ex = c.execute(f"select agency, count(*) v from {QQ}{w} group by 1 having agency is not null order by v desc, 1 limit 5").fetchall()
    T.chk('Top agencies first 5' + suf, ch['Top agencies']['rows'][:5], [[l, num(v)] for l, v in ex])
    ex = c.execute(f"select parse_status, count(*) v from {QQ}{w} group by 1 order by v desc, 1 limit 6").fetchall()
    labels = {'ok':'Questions read','ok_missing_header':'Questions read, no header','no_questions':'Empty questionnaire','html_shell':'Blank page','login_page':'Login page','monster_not_parsed':'Monster, raw text only'}
    T.chk('Read as' + suf, ch['Read as']['rows'][:6], [[labels[l], num(v)] for l, v in ex])
    a = out['agencies' + suf]; st = dict(a['stats']); ch = {x['title']: x for x in a['charts']}
    r = c.execute(f"select count(distinct agency), count(distinct hiring_agency) from {QQ}{w}").fetchone()
    T.chk('By agency: agencies' + suf, st['Agencies'], num(r[0])); T.chk('By agency: departments' + suf, st['Departments'], num(r[1]))
    ex = c.execute(f"select agency, sum(n_questions) v from {QQ}{w} group by 1 having agency is not null order by v desc, 1 limit 5").fetchall()
    T.chk('By agency: questions top 5' + suf, ch['Questions']['rows'][:5], [[l, num(v)] for l, v in ex])
    ex = c.execute(f"select agency, avg(n_questions) v from {QQ}{w} group by 1 having agency is not null and count(*) >= 20 order by v desc, 1 limit 5").fetchall()
    T.chk('By agency: average length top 5 (min 20)' + suf, ch['Average length']['rows'][:5], [[l, f"{v:,.2f}".rstrip('0').rstrip('.')] for l, v in ex])
    ex = c.execute(f"select hiring_agency, count(*) v from {QQ}{w} group by 1 having hiring_agency is not null order by v desc, 1 limit 5").fetchall()
    T.chk('By agency: departments top 5' + suf, ch['Departments']['rows'][:5], [[l, num(v)] for l, v in ex])
    tm = out['time' + suf]; st = dict(tm['stats']); ch = {x['title']: x for x in tm['charts']}
    r = c.execute(f"select count(*) filter(where try_cast(open_date as date) is not null), count(*) filter(where try_cast(open_date as date) is null) from {QQ}{w}").fetchone()
    T.chk('Over time: with a date' + suf, st['With a date'], num(r[0])); T.chk('Over time: no date' + suf, st['No date'], num(r[1]))
    for title, sql, f in [('Opened, by month', "count(*)", num), ('Questions, by month', "sum(n_questions)", num)]:
        shown = {a_: b for a_, b in ch[title]['rows']}
        ex = c.execute(f"select strftime(try_cast(open_date as date), '%Y-%m') m, {sql} from {QQ}{w} group by 1 having m is not null").fetchall()
        T.chk(f'Over time: {title} (months with data)' + suf, {k: shown.get(k) for k, _ in ex}, {k: f(v) for k, v in ex})
    shown = {a_: b for a_, b in ch['Opened, by year']['rows']}
    ex = c.execute(f"select strftime(try_cast(open_date as date), '%Y') y, count(*) from {QQ}{w} group by 1 having y is not null").fetchall()
    T.chk('Over time: by year' + suf, {k: shown.get(k) for k, _ in ex}, {k: num(v) for k, v in ex})
    q = out['quality' + suf]; st = dict(q['stats']); ch = {x['title']: x for x in q['charts']}
    r = c.execute(f"select count(*) filter(where parse_status in ('ok','ok_missing_header')), count(*) filter(where parse_status in ('html_shell','login_page')), count(*) filter(where portal='monster') from {QQ}{w}").fetchone()
    T.chk('Reading: questions read' + suf, st['Questions read'], num(r[0])); T.chk('Reading: blank or login' + suf, st['Blank or login'], num(r[1])); T.chk('Reading: Monster' + suf, st['Monster'], num(r[2]))
T.done()
