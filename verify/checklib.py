import json, duckdb
c=duckdb.connect(); c.execute("install httpfs; load httpfs")
H='https://huggingface.co/datasets/'
def n(s): return int(s.replace(',','').replace('$',''))
class T:
    bad=0; checks=0
    @classmethod
    def chk(cls,label,shown,expect):
        cls.checks+=1; ok=(str(shown)==str(expect))
        if not ok: cls.bad+=1
        print(('OK  ' if ok else 'BAD ')+label,'shown=',shown,'expected=',expect)
    @classmethod
    def done(cls): print('checks',cls.checks,'mismatches',cls.bad)
def chart(view,title): return {x['title']:x for x in view['charts']}[title]
def rows_dict(ch, conv=n): return {r[0]:conv(r[1]) for r in ch['rows']}
