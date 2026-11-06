"""DC site pivots against DuckDB. Run with EXPLORER_BASE and CHROME_HEADLESS_SHELL set."""
import sys
sys.path.insert(0, 'verify')
import drive
from checklib import *
B = f"{H}abigailhaddad/dc-procurement/resolve/main/data/"
def T_(n): return f"read_parquet('{B}{n}.parquet')"
def trim(x, d=1):
    s = f"{x:,.{d}f}"; return s.rstrip('0').rstrip('.') if '.' in s else s
mil = lambda x: f"${trim(x/1e6)}M"
num = lambda x: f"{int(x):,}"
jobs = [('c_amt', 'd=dc-contracts&v=pivot&pr=agency&pm=base'), ('c_cnt', 'd=dc-contracts&v=pivot&pr=market_type&pc=period_kind'),
        ('p_amt', 'd=dc-purchase-orders&v=pivot&pr=agency&pm=total'), ('p_cnt', 'd=dc-purchase-orders&v=pivot&pr=fiscal_year'),
        ('y_amt', 'd=dc-payments&v=pivot&pr=agency&pm=paid'), ('y_cnt', 'd=dc-payments&v=pivot&pr=has_contract'),
        ('s_cnt', 'd=dc-solicitations&v=pivot&pr=agency'), ('s_x', 'd=dc-solicitations&v=pivot&pr=market_type&pc=is_open')]
out = drive.run(jobs, 'verify/out_dc_pivot.json'); print('page errors:', out['_errors'])
def g(k): return out[k]['pivot']
def top(tbl, lab, val, n=5):
    return c.execute(f"select {lab} l, {val} v from {tbl} where ({lab}) is not null group by 1 order by v desc, l limit {n}").fetchall()
C, P, Y, S = T_('contracts'), T_('purchase_orders'), T_('payments'), T_('solicitations')
for k, tbl, lab, val, f, tot in [('c_amt', C, 'agency', 'sum(base_amount)', mil, f"select sum(base_amount) from {C}"),
                                 ('p_amt', P, 'agency', 'sum(po_total)', mil, f"select sum(po_total) from {P}"),
                                 ('y_amt', Y, 'agency', 'sum(voucher_amount)', mil, f"select sum(voucher_amount) from {Y}"),
                                 ('s_cnt', S, 'agency', 'count(*)', num, f"select count(*) from {S}")]:
    p = g(k); T.chk(k + ' top5', [[r[0], r[1]] for r in p['rows'][:5]], [[l, f(v)] for l, v in top(tbl, lab, val)])
    T.chk(k + ' All rows', p['foot'][1], f(c.execute(tot).fetchone()[0]))
p = g('c_cnt'); ex = c.execute(f"select market_type, count(*) filter (where period_kind='option'), count(*) filter (where period_kind='base'), count(*) filter (where period_kind='unclear'), count(*) from {C} where market_type is not null group by 1 order by 5 desc, 1 limit 4").fetchall()
T.chk('c_cnt rows', [[r[0]] + [r[1], r[2], r[3], r[4]] for r in p['rows'][:4]] , [[a] + [num(b) if b else '' for b in rest] for a, *rest in ex])
p = g('p_cnt'); ex = c.execute(f"select cast(fiscal_year as varchar), count(*) from {P} group by 1 order by 2 desc, 1 limit 5").fetchall()
T.chk('p_cnt top5', [[r[0], r[1]] for r in p['rows'][:5]], [[a, num(b)] for a, b in ex]); T.chk('p_cnt All rows', p['foot'][1], num(c.execute(f"select count(*) from {P}").fetchone()[0]))
p = g('y_cnt'); ex = c.execute(f"select case when contract_number is not null and contract_number<>'' then 'Yes' else 'No' end, count(*) from {Y} group by 1 order by 2 desc").fetchall()
T.chk('y_cnt rows', [[r[0], r[1]] for r in p['rows'][:2]], [[a, num(b)] for a, b in ex])
p = g('s_x'); ex = c.execute(f"select market_type, count(*) filter (where is_open), count(*) filter (where not is_open), count(*) from {S} where market_type is not null group by 1 order by 4 desc, 1 limit 3").fetchall()
print('s_x head', p['head'], 'rows', p['rows'][:3], 'expected(open,closed,total)', ex)
T.done()
