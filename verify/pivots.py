import sys, json
sys.path.insert(0,'.scratch')
from drive import run
jobs=[
 ('eeoc', 'd=eeoc&v=pivot&pr=agency&pc=discrimination_found'),
 ('eeoc+f', 'd=eeoc&v=pivot&pr=agency&pc=discrimination_found&f.agency=United%20States%20Postal%20Service&f.agency=Department%20of%20Veterans%20Affairs'),
 ('listing', 'd=eeoc-listing&v=pivot&pr=posted_year&pc=ext'),
 ('listing+f', 'd=eeoc-listing&v=pivot&pr=posted_year&pc=ext&f.ext=.pdf&f.ext=.txt'),
 ('cba', 'd=opm-cba&v=pivot&pr=agencyName&pc=flag_group'),
 ('cba+f', 'd=opm-cba&v=pivot&pr=laborUnionName&pm=pages&f.flag_group=Inferred'),
 ('ja', 'd=federal-ja&v=pivot&pr=agency&pc=usaspending_matched&pm=awards'),
 ('ja+f', 'd=federal-ja&v=pivot&pr=authority_plain&pm=stated&f.agency=VETERANS%20AFFAIRS%2C%20DEPARTMENT%20OF'),
 ('dod', 'd=dod-contracts&v=pivot&pr=year&pc=agency'),
 ('dod+f', 'd=dod-contracts&v=pivot&pr=state&f.agency=NAVY'),
]
which=sys.argv[1]
sel=[j for j in jobs if j[0].split('+')[0]==which]
r=run(sel, f'verify/pv_{which}.json')
print(which, {k:(v.get('error') or 'ok') if isinstance(v,dict) else v for k,v in r.items()})
