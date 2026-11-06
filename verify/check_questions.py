"""USAJOBS questions (949k rows): stats, charts against DuckDB.
Run:  EXPLORER_BASE=http://127.0.0.1:8790/ CHROME_HEADLESS_SHELL=... python3 verify/check_questions.py
"""
import os, sys
sys.path.insert(0, 'verify')
import drive
from checklib import *

B = f"{H}abigailhaddad/usajobs-questionnaires/resolve/main/data/"
# the page reads an empty string as blank, so the independent count does too
QS = f"(select * replace (nullif(question_text,'') as question_text, nullif(agency,'') as agency, nullif(section,'') as section, nullif(section_kind,'') as section_kind, nullif(question_type,'') as question_type, nullif(announcement_number,'') as announcement_number) from read_parquet('{B}questions/part-2025-release.parquet'))"
def num(x): return f"{int(x):,}"
F1 = [('', '', ''), ('+agency', 'f.agency=Veterans', " where agency ilike '%Veterans%'"), ('+kind', 'f.section_kind=assessment', " where section_kind='assessment'"), ('+search', 'q=veterans%20preference', " where (question_text ilike '%veterans%' or agency ilike '%veterans%' or announcement_number ilike '%veterans%') and (question_text ilike '%preference%' or agency ilike '%preference%' or announcement_number ilike '%preference%')")]
jobs = []
for suf, qs, _ in F1:
    for v in ['table', 'common', 'agencies', 'types']:
        jobs.append((v + suf, f'd=usajobs-questions&v={v}' + ('&' + qs if qs else '')))
out = drive.run(jobs, 'verify/out_usajobs-questions.json')
print('page errors:', out.get('_errors'))
kinds = {'single_choice':'Single choice','multi_choice':'Multiple choice','free_text':'Free text','dropdown':'Dropdown'}
def hc(v): return str(v).replace('_',' ').capitalize()
for suf, _, w in F1:
    and_ = ' and' if w else ' where'
    t = out['table' + suf]; st = dict(t['stats']); ch = {x['title']: x for x in t['charts']}
    r = c.execute(f"select count(*), count(distinct question_text), count(distinct questionnaire_id), count(distinct agency) from {QS}{w}").fetchone()
    T.chk('Questions' + suf, st['Questions'], num(r[0])); T.chk('Distinct wordings' + suf, st['Distinct wordings'], num(r[1]))
    T.chk('Questionnaires' + suf, st['Questionnaires'], num(r[2])); T.chk('Agencies' + suf, st['Agencies'], num(r[3]))
    ex = c.execute(f"select section_kind, count(*) v from {QS}{w} group by 1 having section_kind is not null order by v desc, 1 limit 6").fetchall()
    T.chk('Section kind' + suf, ch['Section kind']['rows'], [[hc(l), num(v)] for l, v in ex][:len(ch['Section kind']['rows'])])
    ex = c.execute(f"select question_type, count(*) v from {QS}{w} group by 1 having question_type is not null order by v desc, 1 limit 6").fetchall()
    T.chk('Answer type' + suf, ch['Answer type']['rows'], [[kinds.get(l, hc(l)), num(v)] for l, v in ex][:len(ch['Answer type']['rows'])])
    cm = out['common' + suf]; st = dict(cm['stats']); ch = {x['title']: x for x in cm['charts']}
    T.chk('Common: distinct wordings' + suf, st['Distinct wordings'], num(r[1])); T.chk('Common: questions' + suf, st['Questions'], num(r[0]))
    ex = c.execute(f"select question_text, count(*) v from {QS}{w} group by 1 having question_text is not null order by v desc, 1 limit 5").fetchall()
    T.chk('Common: most repeated top 5' + suf, [[a_, b] for a_, b in ch['Most repeated wordings']['rows'][:5]], [[l, num(v)] for l, v in ex])
    ex = c.execute(f"select question_text, count(*) v from {QS}{w}{and_} question_type='free_text' group by 1 having question_text is not null order by v desc, 1 limit 5").fetchall()
    T.chk('Common: most repeated free text top 5' + suf, [[a_, b] for a_, b in ch['Most repeated free-text']['rows'][:5]], [[l, num(v)] for l, v in ex][:len(ch['Most repeated free-text']['rows'][:5])])
    ag = out['agencies' + suf]; st = dict(ag['stats']); ch = {x['title']: x for x in ag['charts']}
    r2 = c.execute(f"select count(distinct agency), count(distinct questionnaire_id) from {QS}{w}").fetchone()
    T.chk('By agency: agencies' + suf, st['Agencies'], num(r2[0])); T.chk('By agency: questionnaires' + suf, st['Questionnaires'], num(r2[1]))
    ex = c.execute(f"select agency, count(*) v from {QS}{w} group by 1 having agency is not null order by v desc, 1 limit 5").fetchall()
    T.chk('By agency: questions top 5' + suf, ch['Questions']['rows'][:5], [[l, num(v)] for l, v in ex])
    sk = ch['Section kind by agency']; tc = sk['head'].index('Total') if 'Total' in sk['head'] else None
    if tc is not None:
        exa = dict(c.execute(f"select agency, count(*) v from {QS}{w} group by 1 having agency is not null order by v desc, 1 limit 10").fetchall())
        T.chk('By agency: stacked totals (top 10 set)' + suf, {a_: int(b.replace(',', '')) for a_, b in [(rw[0], rw[tc]) for rw in sk['rows']]}, exa)
    ty = out['types' + suf]; st = dict(ty['stats']); ch = {x['title']: x for x in ty['charts']}
    r3 = c.execute(f"select count(*) filter(where question_type='free_text'), count(*) filter(where section_kind='assessment') from {QS}{w}").fetchone()
    T.chk('Kinds: free text' + suf, st['Free text'], num(r3[0])); T.chk('Kinds: assessment' + suf, st['Assessment'], num(r3[1]))
    ex = c.execute(f"select n_options, count(*) v from {QS}{w} group by 1 having n_options is not null order by v desc, 1 limit 15").fetchall()
    T.chk('Kinds: choices per question top 5' + suf, ch['Choices per question']['rows'][:5], [[str(int(l)) if l is not None else l, num(v)] for l, v in ex][:5])
T.done()
