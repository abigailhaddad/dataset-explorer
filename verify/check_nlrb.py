"""The NLRB decisions site against an independent read of the same Hugging Face file.

Serve a built site folder (python3 scripts/build_sites.py nlrb-decisions), or pass a deployed URL:
  python3 -m http.server 8811 --bind 127.0.0.1 --directory dist-sites/nlrb-decisions
  python3 verify/check_nlrb.py http://127.0.0.1:8811/

Compares the stat cards (all rows, then a listing filter, then a search) and one record page with pandas
reading the parquet straight from Hugging Face, and fails on any console error.
"""
import sys
import pandas as pd
from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8811/"
URL = "https://huggingface.co/datasets/abigailhaddad/nlrb-decisions/resolve/main/decisions.parquet"
df = pd.read_parquet(URL)
bad = []


def chk(label, got, want):
    ok = got == want
    print(("OK  " if ok else "BAD ") + f"{label}: got {got!r}" + ("" if ok else f", want {want!r}"))
    if not ok:
        bad.append(label)


def stats(pg):
    return dict(pg.evaluate("[...document.querySelectorAll('#stats .stat-card')].map(c=>[c.querySelector('.stat-label').textContent.trim(), c.querySelector('.stat-value').textContent.trim()])"))


def wait_list(pg):
    pg.wait_for_function("document.querySelector('#listpane') && document.querySelector('#listpane').dataset.loading === '0'", timeout=240000)
    pg.wait_for_timeout(500)


def expect(sub):
    return {"Entries": f"{len(sub):,}", "Board decisions": f"{(sub['listing'] == 'board').sum():,}",
            "ALJ decisions": f"{(sub['listing'] == 'alj').sum():,}", "Newest": sub["issuance_date"].max()}


with sync_playwright() as p:
    b = p.chromium.launch()
    for width in (1280, 390):
        pg = b.new_page(viewport={"width": width, "height": 900})
        errs = []
        pg.on("console", lambda m: errs.append(m.text[:200]) if m.type == "error" else None)
        pg.on("pageerror", lambda e: errs.append("pageerror " + str(e)[:200]))
        pg.goto(BASE)
        wait_list(pg)
        chk(f"heading @{width}", pg.inner_text("#title"), "NLRB decisions")
        chk(f"stats, all rows @{width}", stats(pg), expect(df))
        pg.goto(BASE + "?f.listing_title=Administrative+Law+Judge+Decisions")
        wait_list(pg)
        chk(f"stats, ALJ filter @{width}", stats(pg), expect(df[df["listing_title"] == "Administrative Law Judge Decisions"]))
        pg.goto(BASE + "?q=tesla")
        wait_list(pg)
        cols = ["case_name", "case_number", "citation", "jd_number"]
        hit = df[cols].fillna("").apply(lambda c: c.str.lower().str.contains("tesla", regex=False)).any(axis=1)
        chk(f"stats, search 'tesla' @{width}", stats(pg), expect(df[hit]))
        r = df[df["citation"] == "375 NLRB No. 68"].iloc[0]
        pg.goto(BASE + "?r=" + r["record_id"].replace("|", "%7C"))
        pg.wait_for_selector("#recordpane:not([hidden])", timeout=120000)
        pg.wait_for_timeout(1500)
        body = pg.inner_text("#recordpane")
        for v in (r["case_name"], r["case_number"], r["citation"], r["issuance_date"]):
            chk(f"record page shows {v!r} @{width}", v in body, True)
        links = pg.evaluate("[...document.querySelectorAll('#recordpane a')].map(a=>a.href)")
        chk(f"record page links the document @{width}", r["document_url"] in links, True)
        pg.screenshot(path=f"screenshots/nlrb-{width}.png", full_page=False)
        chk(f"console errors @{width}", errs, [])
    b.close()
print("FAILED: " + "; ".join(bad) if bad else "all checks passed")
sys.exit(1 if bad else 0)
