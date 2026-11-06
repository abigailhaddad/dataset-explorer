"""SF-133: every stat, chart and pivot number against DuckDB on the accounts file.
Run:  EXPLORER_BASE=http://127.0.0.1:8790/ CHROME_HEADLESS_SHELL=... python3 verify/check_sf133.py
"""
import json, os, sys
sys.path.insert(0, 'verify')
import drive
from checklib import *

A = f"read_parquet('{H}abigailhaddad/sf133-budget-execution/resolve/main/data/sf133_accounts.parquet')"
res, unob = 'total_budgetary_resources', 'unobligated_balance_end_of_period'
FILTERS = [('', '', ''), ('+fy', 'f.fiscal_year=2025', " where fiscal_year=2025"),
           ('+agency', 'f.agency=Defense', " where agency ilike '%Defense%'")]
views = ['table', 'agencies', 'gifts', 'time']
jobs = []
for suf, qs, _ in FILTERS:
    for v in views:
        jobs.append((v + suf, f'd=sf133&v={v}' + ('&' + qs if qs else '')))
out = drive.run(jobs, 'verify/out_sf133.json')
print('page errors:', out.get('_errors'))

def trim(x, d=1):
    # the page rounds with toLocaleString(maximumFractionDigits: d): 13,536.0 shows as 13,536
    s = f"{x:,.{d}f}"
    return s.rstrip('0').rstrip('.') if '.' in s else s
def bil(x): return f"${trim(x/1e9)}B"
def mil(x): return f"${trim(x/1e6)}M"
def pct(x): return f"{trim(x)}%"
def num(x): return f"{int(x):,}"
def top(label_sql, val_sql, where, n, having=''):
    return c.execute(f"select {label_sql} l, {val_sql} v from {A}{where} group by 1{having} order by v desc, l limit {n}").fetchall()

for suf, _, w in FILTERS:
    and_ = ' and' if w else ' where'
    t = out['table' + suf]; st = dict(t['stats'])
    r = c.execute(f"select count(*), count(distinct agency), sum({res}), count(*) filter(where is_gift_account) from {A}{w}").fetchone()
    T.chk('Account-years' + suf, st['Account-years'], num(r[0]))
    T.chk('Agencies' + suf, st['Agencies'], num(r[1]))
    T.chk('Resources, summed' + suf, st['Resources, summed'], bil(r[2]))
    T.chk('Gift account-years' + suf, st['Gift accounts'], num(r[3]))
    ch = {x['title']: x for x in t['charts']}
    ex = top('agency', f'sum({res})', w, 12)
    T.chk('Top agencies (first 5)' + suf, [(a, b) for a, b in ch['Top agencies']['rows'][:5]], [(l, bil(v)) for l, v in ex[:5]])
    yr = {a: b for a, b in ch['Resources by year']['rows']}
    exy = c.execute(f"select cast(fiscal_year as varchar), sum({res}) from {A}{w} group by 1").fetchall()
    T.chk('Resources by year (all years shown)' + suf, {k: yr.get(k) for k, _ in exy}, {k: bil(v) for k, v in exy})

    a = out['agencies' + suf]; st = dict(a['stats'])
    r = c.execute(f"select count(distinct agency), sum({res}), sum({unob}), 100*sum({unob})/nullif(sum({res}),0) from {A}{w}").fetchone()
    T.chk('By agency: Agencies' + suf, st['Agencies'], num(r[0]))
    T.chk('By agency: Resources' + suf, st['Resources, summed'], bil(r[1]))
    T.chk('By agency: Unobligated' + suf, st['Unobligated, summed'], bil(r[2]))
    T.chk('By agency: Share' + suf, st['Share unobligated'], pct(r[3]))
    ch = {x['title']: x for x in a['charts']}
    T.chk('By agency: Resources top 5' + suf, ch['Resources']['rows'][:5], [[l, bil(v)] for l, v in top('agency', f'sum({res})', w, 5)])
    T.chk('By agency: Unobligated top 5' + suf, ch['Unobligated']['rows'][:5], [[l, bil(v)] for l, v in top('agency', f'sum({unob})', w, 5)])
    ex = top('agency', f"100*sum({unob})/nullif(sum({res}),0)", w, 5, having=' having count(*) >= 20')
    T.chk('By agency: Share top 5 (min 20 rows)' + suf, ch['Share unobligated']['rows'][:5], [[l, pct(v)] for l, v in ex])

    g = out['gifts' + suf]; st = dict(g['stats'])
    r = c.execute(f"select count(distinct tafs) filter(where is_gift_account), sum({unob}) filter(where is_gift_account) from {A}{w}").fetchone()
    T.chk('Gifts: accounts' + suf, st['Gift accounts'], num(r[0]))
    T.chk('Gifts: unobligated' + suf, st['Balances, summed'], mil(r[1]) if r[1] is not None else '—')
    ch = {x['title']: x for x in g['charts']}
    latest = c.execute(f"select max(fiscal_year) from {A}").fetchone()[0]
    ex = c.execute(f"select tafs, sum({unob}) v from {A}{w}{and_} is_gift_account and fiscal_year={latest} group by 1 order by v desc nulls last, 1 limit 5").fetchall()
    T.chk('Gifts: largest in latest year, top 5' + suf, ch['Largest, latest year']['rows'][:5], [[l, mil(v)] for l, v in ex if v is not None][:len(ch['Largest, latest year']['rows'][:5])])
    gy = {a: b for a, b in ch['Unobligated by year']['rows']}
    exy = c.execute(f"select cast(fiscal_year as varchar), sum({unob}) from {A}{w}{and_} is_gift_account group by 1").fetchall()
    T.chk('Gifts: unobligated by year' + suf, {k: gy.get(k) for k, _ in exy}, {k: mil(v) for k, v in exy})
    gc = {a: b for a, b in ch['Gift accounts by year']['rows']}
    exy = c.execute(f"select cast(fiscal_year as varchar), count(distinct tafs) from {A}{w}{and_} is_gift_account group by 1").fetchall()
    T.chk('Gifts: accounts by year' + suf, {k: gc.get(k) for k, _ in exy}, {k: num(v) for k, v in exy})

    tm = out['time' + suf]; st = dict(tm['stats'])
    r = c.execute(f"select count(distinct fiscal_year), count(distinct tafs) from {A}{w}").fetchone()
    T.chk('Over time: fiscal years' + suf, st['Fiscal years'], num(r[0])); T.chk('Over time: accounts' + suf, st['Accounts'], num(r[1]))
    ch = {x['title']: x for x in tm['charts']}
    for title, sql, f in [('Resources', f'sum({res})', bil), ('Unobligated', f'sum({unob})', bil), ('Accounts', 'count(*)', num)]:
        shown = {a: b for a, b in ch[title]['rows']}
        exy = c.execute(f"select cast(fiscal_year as varchar), {sql} from {A}{w} group by 1").fetchall()
        T.chk('Over time: ' + title + suf, {k: shown.get(k) for k, _ in exy}, {k: f(v) for k, v in exy})
    stk = ch['Resources by account type']; hd = stk['head']
    exy = {(y, f): v for y, f, v in c.execute(f"select cast(fiscal_year as varchar), case when financing='FINANCING ACCOUNTS' then 'Financing' else 'Non-financing' end, sum({res}) from {A}{w} group by 1,2").fetchall()}
    bad = cells = 0
    for row in stk['rows']:
        for col, name in enumerate(hd):
            if name in ('Non-financing', 'Financing'):
                cells += 1
                bad += (row[col] != bil(exy.get((row[0], name), 0)))
    T.chk('Over time: stack by account type, cells compared / mismatching' + suf, (cells > 0, bad), (True, 0))
T.done()
