"""Pivot tables of the three newer datasets against DuckDB (2 per dataset: no filter, filter).
Run:  EXPLORER_BASE=http://127.0.0.1:8790/ CHROME_HEADLESS_SHELL=... python3 verify/check_pivot_new.py
"""
import sys
sys.path.insert(0, 'verify')
import drive
from checklib import *

SB = f"{H}abigailhaddad/sf133-budget-execution/resolve/main/data/sf133_accounts.parquet"
QB = f"{H}abigailhaddad/usajobs-questionnaires/resolve/main/data/"
ACC = f"(select * replace (nullif(agency,'') as agency, nullif(bureau,'') as bureau) from read_parquet('{SB}'))"
QQ = f"(select * replace (nullif(hiring_agency,'') as hiring_agency, nullif(agency,'') as agency) from read_parquet('{QB}questionnaires/part-2025-release.parquet'))"
QS = f"(select * replace (nullif(agency,'') as agency, nullif(section_kind,'') as section_kind, nullif(question_type,'') as question_type) from read_parquet('{QB}questions/part-2025-release.parquet'))"
JOBS = [
 ('sf133', 'd=sf133&v=pivot&pr=agency&pc=financing&pm=resources'),
 ('sf133+f', 'd=sf133&v=pivot&pr=bureau&pc=is_gift_account&pm=unobligated&f.agency=Defense'),
 ('quest', 'd=usajobs-questionnaires&v=pivot&pr=hiring_agency&pc=portal'),
 ('quest+f', 'd=usajobs-questionnaires&v=pivot&pr=open_month&pm=questions&f.agency=Veterans'),
 ('ques', 'd=usajobs-questions&v=pivot&pr=section_kind&pc=question_type'),
 ('ques+f', 'd=usajobs-questions&v=pivot&pr=choices&f.agency=Veterans'),
]
out = drive.run(JOBS, 'verify/pv_new.json')
print('page errors:', out.get('_errors'))

def parse(s, scale=1.0):
    s = s.replace('$', '').replace(',', '').replace('%', '')
    if s.endswith('B'): return float(s[:-1]) * 1e9
    if s.endswith('M'): return float(s[:-1]) * 1e6
    return float(s) if s not in ('', '—') else 0.0
def pretty(v):
    return {'true': 'Yes', 'false': 'No', 'NON-FINANCING ACCOUNTS': 'Non-financing', 'FINANCING ACCOUNTS': 'Financing'}.get(v, v)
def human(v):
    w = str(v).replace('_', ' ')
    return w[:1].upper() + w[1:]
def cells(sql, labels=pretty):
    d = {}
    for r in c.execute(sql).fetchall():
        k = ('(blank)' if r[0] is None else labels(str(r[0])), '' if len(r) < 3 else ('(blank)' if r[1] is None else labels(str(r[1]))))
        d[k] = float(r[-1] or 0)
    return d
def compare(name, got, exp, tol):
    head = got['head']; rows = got['rows']; two = 'Total' in head
    cols = head[1:-1] if two else ['']
    bad = n = 0
    for r in rows:
        lab = r[0]
        tot_e = sum(v for (rl, cl), v in exp.items() if rl == lab)
        tot_s = parse(r[-1] if two else r[1])
        n += 1; bad += abs(tot_s - tot_e) > tol
        if two:
            for cl, v in zip(cols, r[1:-1]):
                if cl == 'Other': continue
                n += 1; e = exp.get((lab, cl), 0.0)
                if abs(parse(v) - e) > tol: bad += 1; print('  BAD cell', lab, cl, v, e)
    T.chk(f'{name}: {len(rows)} rows, {n} numbers compared, mismatches', bad, 0)
    shown_labels = {r[0] for r in rows}
    all_labels = {k[0] for k in exp}
    T.chk(f'{name}: rows shown are real groups', shown_labels <= all_labels, True)
    gt = parse(got['foot'][-1] if two else got['foot'][1])
    T.chk(f'{name}: grand total', abs(gt - sum(exp.values())) <= tol, True)
    print('   shown grand total', got['foot'][-1], 'expected', sum(exp.values()))

compare('sf133 agency x account type (resources, $)', out['sf133']['pivot'],
        cells(f"select agency, financing, sum(total_budgetary_resources) from {ACC} group by 1,2"), 0.06e9)
compare('sf133 bureau x gift (unobligated, agency contains Defense)', out['sf133+f']['pivot'],
        cells(f"select bureau, is_gift_account::varchar, sum(unobligated_balance_end_of_period) from {ACC} where agency ilike '%Defense%' group by 1,2"), 0.06e9)
compare('questionnaires department x portal', out['quest']['pivot'],
        cells(f"select hiring_agency, portal, count(*) from {QQ} group by 1,2", lambda v: {'usastaffing': 'USA Staffing', 'monster': 'Monster'}.get(v, v)), 0.5)
compare('questionnaires open month (questions, agency contains Veterans)', out['quest+f']['pivot'],
        cells(f"select strftime(try_cast(open_date as date), '%Y-%m'), sum(n_questions) from {QQ} where agency ilike '%Veterans%' group by 1"), 0.5)
kinds = {'single_choice': 'Single choice', 'multi_choice': 'Multiple choice', 'free_text': 'Free text', 'dropdown': 'Dropdown'}
compare('questions section kind x answer type', out['ques']['pivot'],
        cells(f"select section_kind, question_type, count(*) from {QS} group by 1,2", lambda v: kinds.get(v, human(v))), 0.5)
compare('questions choices (agency contains Veterans)', out['ques+f']['pivot'],
        cells(f"select cast(try_cast(n_options as integer) as varchar), count(*) from {QS} where agency ilike '%Veterans%' group by 1"), 0.5)
T.done()
