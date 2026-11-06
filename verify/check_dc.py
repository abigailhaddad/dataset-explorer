"""DC procurement site: every stat and chart total against DuckDB on the published tables.
Run:  EXPLORER_BASE=http://127.0.0.1:8798/ CHROME_HEADLESS_SHELL=... python3 verify/check_dc.py [contracts|po|payments|sol ...]
"""
import json, os, sys
sys.path.insert(0, 'verify')
import drive
from checklib import *

B = f"{H}abigailhaddad/dc-procurement/resolve/main/data/"
def T_(name): return f"read_parquet('{B}{name}.parquet')"
def trim(x, d=1):
    s = f"{x:,.{d}f}"
    return s.rstrip('0').rstrip('.') if '.' in s else s
def bil(x): return f"${trim(x/1e9)}B"
def mil(x): return f"${trim(x/1e6)}M"
def pct(x): return f"{trim(x)}%"
def num(x): return f"{int(x):,}"
def one(sql): return c.execute(sql).fetchone()
def top(tbl, label, val, where, n, extra=''):
    w = (where + ' and ' if where else ' where ') + f"({label}) is not null"
    return c.execute(f"select {label} l, {val} v from {tbl}{w} group by 1{extra} order by v desc, l limit {n}").fetchall()

which = set(sys.argv[1:]) or {'contracts', 'po', 'payments', 'sol'}
jobs = []
SPECS = {
 'contracts': ('dc-contracts', ['table', 'agencies', 'vendors', 'time', 'how'],
               [('', ''), ('+fy', 'f.start_fiscal_year=2025'), ('+agency', 'f.agency=Behavioral')]),
 'po': ('dc-purchase-orders', ['table', 'agencies', 'suppliers', 'time', 'commodity'],
        [('', ''), ('+fy', 'f.fiscal_year=2025'), ('+agency', 'f.agency=Education')]),
 'payments': ('dc-payments', ['table', 'agencies', 'vendors', 'time'],
              [('', ''), ('+fy', 'f.fiscal_year=2025'), ('+agency', 'f.agency=Education')]),
 'sol': ('dc-solicitations', ['table', 'agencies', 'time'],
         [('', ''), ('+open', 'f.is_open=true'), ('+agency', 'f.agency=Education')]),
}
FILTER_SQL = {
 'contracts': {'': '', '+fy': ' where start_fiscal_year=2025', '+agency': " where agency ilike '%Behavioral%'"},
 'po': {'': '', '+fy': ' where fiscal_year=2025', '+agency': " where agency ilike '%Education%'"},
 'payments': {'': '', '+fy': ' where fiscal_year=2025', '+agency': " where agency ilike '%Education%'"},
 'sol': {'': '', '+open': ' where is_open', '+agency': " where agency ilike '%Education%'"},
}
for k in sorted(which):
    ds, views, filters = SPECS[k]
    for suf, qs in filters:
        for v in views:
            jobs.append((f'{k}:{v}{suf}', f'd={ds}&v={v}' + ('&' + qs if qs else '')))
out = drive.run(jobs, 'verify/out_dc.json')
print('page errors:', out.get('_errors'))
for k, v in out.items():
    if k != '_errors' and v.get('error'): print('LOAD ERROR', k, v)

def chartrows(view, title): return {x['title']: x for x in view['charts']}[title]['rows']
def cmp_top(label, shown, exp): T.chk(label, [list(x) for x in shown[:len(exp)]], [[l, f] for l, f in exp])

if 'contracts' in which:
    A = T_('contracts')
    for suf, w in FILTER_SQL['contracts'].items():
        t = out[f'contracts:table{suf}']; st = dict(t['stats'])
        r = one(f"select count(*), count(distinct contract_number), sum(base_amount), count(distinct vendor) from {A}{w}")
        T.chk('C periods'+suf, st['Periods'], num(r[0])); T.chk('C contracts'+suf, st['Contracts'], num(r[1]))
        T.chk('C base total'+suf, st['Base-period total'], mil(r[2])); T.chk('C vendors'+suf, st['Vendors'], num(r[3]))
        cmp_top('C top agencies'+suf, chartrows(t, 'Top agencies, base-period total'), [(l, mil(v)) for l, v in top(A, 'agency', 'sum(base_amount)', w, 5)])
        yr = {a: b for a, b in chartrows(t, 'Contracts by start year')}
        ex = c.execute(f"select cast(start_fiscal_year as varchar), count(distinct contract_number) from {A}{w} group by 1").fetchall()
        T.chk('C contracts by start year'+suf, {k2: yr.get(k2) for k2, _ in ex}, {k2: num(v) for k2, v in ex})
        a = out[f'contracts:agencies{suf}']; st = dict(a['stats'])
        r = one(f"select count(distinct agency), count(distinct contract_number), sum(base_amount) from {A}{w}")
        T.chk('C agencies stat'+suf, st['Agencies'], num(r[0])); T.chk('C agencies contracts'+suf, st['Contracts'], num(r[1])); T.chk('C agencies base'+suf, st['Base-period total'], mil(r[2]))
        cmp_top('C agencies base top5'+suf, chartrows(a, 'Base-period total'), [(l, mil(v)) for l, v in top(A, 'agency', 'sum(base_amount)', w, 5)])
        cmp_top('C agencies contracts top5'+suf, chartrows(a, 'Contracts'), [(l, num(v)) for l, v in top(A, 'agency', 'count(distinct contract_number)', w, 5)])
        vv = out[f'contracts:vendors{suf}']; st = dict(vv['stats'])
        r = one(f"select count(distinct vendor), sum(base_amount) from {A}{w}")
        T.chk('C vendors stat'+suf, st['Vendors'], num(r[0])); T.chk('C vendors base'+suf, st['Base-period total'], mil(r[1]))
        cmp_top('C vendors base top5'+suf, chartrows(vv, 'Base-period total'), [(l, mil(v)) for l, v in top(A, 'vendor', 'sum(base_amount)', w, 5)])
        cmp_top('C vendors contracts top5'+suf, chartrows(vv, 'Contracts'), [(l, num(v)) for l, v in top(A, 'vendor', 'count(distinct contract_number)', w, 5)])
        tm = out[f'contracts:time{suf}']; st = dict(tm['stats'])
        r = one(f"select count(*), count(distinct contract_number) from {A}{w}")
        T.chk('C time periods'+suf, st['Periods'], num(r[0])); T.chk('C time contracts'+suf, st['Contracts'], num(r[1]))
        for title, sql, f in [('Base-period total by start year', 'sum(base_amount)', mil), ('Contracts by start year', 'count(distinct contract_number)', num)]:
            shown = {a: b for a, b in chartrows(tm, title)}
            ex = c.execute(f"select cast(start_fiscal_year as varchar), {sql} from {A}{w} group by 1").fetchall()
            T.chk('C time '+title+suf, {k2: shown.get(k2) for k2, _ in ex}, {k2: f(v) for k2, v in ex})
        shown = {a: b for a, b in chartrows(tm, 'Periods starting, by month')}
        ex = c.execute(f"select strftime(start_date,'%Y-%m'), count(*) from {A}{w} group by 1").fetchall()
        T.chk('C time by month (nonzero months)'+suf, {k2: shown.get(k2) for k2, _ in ex if k2}, {k2: num(v) for k2, v in ex if k2})
        h = out[f'contracts:how{suf}']
        cmp_top('C market type'+suf, chartrows(h, 'Market type'), [(l, num(v)) for l, v in top(A, 'market_type', 'count(distinct contract_number)', w, 5)])
        cmp_top('C contract type'+suf, chartrows(h, 'Contract type'), [(l, num(v)) for l, v in top(A, 'contract_type', 'count(distinct contract_number)', w, 5)])

if 'po' in which:
    A = T_('purchase_orders'); N = T_('nigp_classes')
    for suf, w in FILTER_SQL['po'].items():
        t = out[f'po:table{suf}']; st = dict(t['stats'])
        r = one(f"select count(*), sum(po_total), count(distinct supplier), count(distinct agency) from {A}{w}")
        T.chk('PO orders'+suf, st['Orders'], num(r[0])); T.chk('PO total'+suf, st['Total'], bil(r[1]))
        T.chk('PO suppliers'+suf, st['Suppliers'], num(r[2])); T.chk('PO agencies'+suf, st['Agencies'], num(r[3]))
        cmp_top('PO top agencies'+suf, chartrows(t, 'Top agencies, total'), [(l, mil(v)) for l, v in top(A, 'agency', 'sum(po_total)', w, 5)])
        yr = {a: b for a, b in chartrows(t, 'Orders by fiscal year')}
        ex = c.execute(f"select cast(fiscal_year as varchar), count(*) from {A}{w} group by 1").fetchall()
        T.chk('PO orders by fiscal year'+suf, {k2: yr.get(k2) for k2, _ in ex if k2}, {k2: num(v) for k2, v in ex if k2})
        a = out[f'po:agencies{suf}']
        cmp_top('PO agencies total'+suf, chartrows(a, 'Total'), [(l, mil(v)) for l, v in top(A, 'agency', 'sum(po_total)', w, 5)])
        cmp_top('PO agencies orders'+suf, chartrows(a, 'Orders'), [(l, num(v)) for l, v in top(A, 'agency', 'count(*)', w, 5)])
        s = out[f'po:suppliers{suf}']
        cmp_top('PO suppliers total'+suf, chartrows(s, 'Total'), [(l, mil(v)) for l, v in top(A, 'supplier', 'sum(po_total)', w, 5)])
        cmp_top('PO suppliers orders'+suf, chartrows(s, 'Orders'), [(l, num(v)) for l, v in top(A, 'supplier', 'count(*)', w, 5)])
        tm = out[f'po:time{suf}']
        for title, sql, f in [('Total by fiscal year', 'sum(po_total)', bil), ('Orders by fiscal year', 'count(*)', num)]:
            shown = {a: b for a, b in chartrows(tm, title)}
            ex = c.execute(f"select cast(fiscal_year as varchar), {sql} from {A}{w} group by 1").fetchall()
            T.chk('PO time '+title+suf, {k2: shown.get(k2) for k2, _ in ex if k2}, {k2: f(v) for k2, v in ex if k2})
        cm = out[f'po:commodity{suf}']; st = dict(cm['stats'])
        T.chk('PO commodity classes'+suf, st['Classes'], num(one(f"select count(distinct nigp_class) from {A}{w}")[0]))
        j = f"(select p.*, n.description nigp_class_name from {A} p left join {N} n using (nigp_class)){w}"
        ex = c.execute(f"select nigp_class_name l, sum(po_total) v from {j}{' and' if w else ' where'} nigp_class_name is not null group by 1 order by v desc, l limit 5").fetchall()
        cmp_top('PO commodity top5'+suf, chartrows(cm, 'Total by commodity class'), [(l, mil(v)) for l, v in ex])

if 'payments' in which:
    A = T_('payments')
    for suf, w in FILTER_SQL['payments'].items():
        t = out[f'payments:table{suf}']; st = dict(t['stats'])
        r = one(f"select count(*), sum(voucher_amount), count(distinct vendor), 100.0*count(*) filter (where contract_number is not null and contract_number<>'')/nullif(count(*),0) from {A}{w}")
        T.chk('P lines'+suf, st['Lines'], num(r[0])); T.chk('P paid'+suf, st['Paid'], bil(r[1]))
        T.chk('P vendors'+suf, st['Vendors'], num(r[2])); T.chk('P with contract'+suf, st['With contract'], pct(r[3]))
        cmp_top('P top vendors'+suf, chartrows(t, 'Top vendors, amount'), [(l, mil(v)) for l, v in top(A, 'vendor', 'sum(voucher_amount)', w, 5)])
        yr = {a: b for a, b in chartrows(t, 'Paid by fiscal year')}
        ex = c.execute(f"select cast(fiscal_year as varchar), sum(voucher_amount) from {A}{w} group by 1").fetchall()
        T.chk('P paid by fiscal year'+suf, {k2: yr.get(k2) for k2, _ in ex if k2}, {k2: bil(v) for k2, v in ex if k2})
        a = out[f'payments:agencies{suf}']
        cmp_top('P agencies paid'+suf, chartrows(a, 'Paid'), [(l, mil(v)) for l, v in top(A, 'agency', 'sum(voucher_amount)', w, 5)])
        cmp_top('P agencies lines'+suf, chartrows(a, 'Lines'), [(l, num(v)) for l, v in top(A, 'agency', 'count(*)', w, 5)])
        vv = out[f'payments:vendors{suf}']
        cmp_top('P vendors paid'+suf, chartrows(vv, 'Paid'), [(l, mil(v)) for l, v in top(A, 'vendor', 'sum(voucher_amount)', w, 5)])
        cmp_top('P vendors lines'+suf, chartrows(vv, 'Lines'), [(l, num(v)) for l, v in top(A, 'vendor', 'count(*)', w, 5)])
        tm = out[f'payments:time{suf}']
        shown = {a: b for a, b in chartrows(tm, 'Paid by month')}
        ex = c.execute(f"select strftime(payment_date,'%Y-%m'), sum(voucher_amount) from {A}{w} group by 1").fetchall()
        T.chk('P paid by month (nonzero)'+suf, {k2: shown.get(k2) for k2, _ in ex if k2}, {k2: mil(v) for k2, v in ex if k2})

if 'sol' in which:
    A = T_('solicitations')
    for suf, w in FILTER_SQL['sol'].items():
        t = out[f'sol:table{suf}']; st = dict(t['stats'])
        r = one(f"select count(*), count(*) filter (where is_open), count(distinct agency) from {A}{w}")
        T.chk('S solicitations'+suf, st['Solicitations'], num(r[0])); T.chk('S open'+suf, st['Open now'], num(r[1])); T.chk('S agencies'+suf, st['Agencies'], num(r[2]))
        cmp_top('S top agencies'+suf, chartrows(t, 'Top agencies'), [(l, num(v)) for l, v in top(A, 'agency', 'count(*)', w, 5)])
        yr = {a: b for a, b in chartrows(t, 'Solicitations by closing year')}
        ex = c.execute(f"select strftime(closing_date,'%Y'), count(*) from {A}{w} group by 1").fetchall()
        T.chk('S by closing year'+suf, {k2: yr.get(k2) for k2, _ in ex if k2}, {k2: num(v) for k2, v in ex if k2})
        a = out[f'sol:agencies{suf}']
        cmp_top('S agencies'+suf, chartrows(a, 'Solicitations'), [(l, num(v)) for l, v in top(A, 'agency', 'count(*)', w, 5)])
        cmp_top('S market type'+suf, chartrows(a, 'Market type'), [(l, num(v)) for l, v in top(A, 'market_type', 'count(*)', w, 5)])
        tm = out[f'sol:time{suf}']
        shown = {a2: b for a2, b in chartrows(tm, 'By closing month')}
        ex = c.execute(f"select strftime(closing_date,'%Y-%m'), count(*) from {A}{w} group by 1").fetchall()
        T.chk('S by closing month (nonzero)'+suf, {k2: shown.get(k2) for k2, _ in ex if k2}, {k2: num(v) for k2, v in ex if k2})
T.done()
