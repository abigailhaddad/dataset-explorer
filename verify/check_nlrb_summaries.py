"""NLRB record pages and the weekly summary join, against an independent read of summaries.parquet.

  python3 verify/check_nlrb_summaries.py https://<preview>.nlrb-decisions.pages.dev/

Opens a matched record (Ralphs Grocery, 375 NLRB No. 25) and checks that its record page shows the card
"NLRB weekly summary (not the decision)" with the summary text from summaries.parquet, and links the week
page. Opens a record with no summary and checks there is no such card. Checks the list page's entry count
is unchanged by the join (a join with repeated keys would add rows). Fails on any console error.
"""
import sys
import pandas as pd
from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8811/"
HF = "https://huggingface.co/datasets/abigailhaddad/nlrb-decisions/resolve/main/"
dec = pd.read_parquet(HF + "decisions.parquet")
sm = pd.read_parquet(HF + "summaries.parquet")
LABEL = "NLRB weekly summary (not the decision)"
bad = []


def chk(label, got, want):
    ok = got == want
    print(("OK  " if ok else "BAD ") + f"{label}: got {got!r}" + ("" if ok else f", want {want!r}"))
    if not ok:
        bad.append(label)


def open_record(pg, rid):
    pg.goto(BASE + "?r=" + rid.replace("|", "%7C"))
    pg.wait_for_selector("#recordpane:not([hidden])", timeout=120000)
    pg.wait_for_timeout(2000)
    return pg.inner_text("#recordpane")


ralphs = dec[dec["citation"] == "375 NLRB No. 25"]
assert len(ralphs) == 1
rid = ralphs.iloc[0]["record_id"]
srow = sm[sm["record_id"] == rid]
chk("summaries.parquet has one entry for Ralphs 375 NLRB No. 25", len(srow), 1)
matched_ids = set(sm["record_id"].dropna())
unmatched = dec[(dec["issuance_date"] >= "2020") & ~dec["record_id"].isin(matched_ids)].sort_values("record_id").iloc[0]

with sync_playwright() as p:
    b = p.chromium.launch()
    for width in (1280, 390):
        pg = b.new_page(viewport={"width": width, "height": 900})
        errs = []
        pg.on("console", lambda m: errs.append(m.text[:200]) if m.type == "error" else None)
        pg.on("pageerror", lambda e: errs.append("pageerror " + str(e)[:200]))
        pg.goto(BASE)
        pg.wait_for_function("document.querySelector('#listpane') && document.querySelector('#listpane').dataset.loading === '0'", timeout=240000)
        pg.wait_for_timeout(500)
        st = dict(pg.evaluate("[...document.querySelectorAll('#stats .stat-card')].map(c=>[c.querySelector('.stat-label').textContent.trim(), c.querySelector('.stat-value').textContent.trim()])"))
        chk(f"entries unchanged by the join @{width}", st.get("Entries"), f"{len(dec):,}")

        body = open_record(pg, rid)
        chk(f"Ralphs record shows the summary card label @{width}", LABEL in body, True)
        text = srow.iloc[0]["summary_text"]
        shown = pg.evaluate("[...document.querySelectorAll('#recordpane pre.longtext')].map(e=>e.textContent)")
        chk(f"Ralphs record shows the summary text exactly @{width}", any(text in x for x in shown), True)
        chk(f"Ralphs record shows the summary header @{width}", any(srow.iloc[0]["header"] in x for x in shown), True)
        links = pg.evaluate("[...document.querySelectorAll('#recordpane a')].map(a=>a.href)")
        chk(f"Ralphs record links the week page @{width}", srow.iloc[0]["week_url"] in links, True)
        pg.screenshot(path=f"screenshots/nlrb-summary-{width}.png", full_page=True)

        body = open_record(pg, unmatched["record_id"])
        chk(f"unmatched record {unmatched['record_id']} shows its case name @{width}", unmatched["case_name"][:30] in body, True)
        chk(f"unmatched record has no summary card @{width}", LABEL in body, False)
        chk(f"unmatched record has no week-page link @{width}",
            any("weekly-summaries-decisions" in h for h in pg.evaluate("[...document.querySelectorAll('#recordpane a')].map(a=>a.href)")), False)
        chk(f"console errors @{width}", errs, [])
    b.close()
print("FAILED: " + "; ".join(bad) if bad else "all checks passed")
sys.exit(1 if bad else 0)
