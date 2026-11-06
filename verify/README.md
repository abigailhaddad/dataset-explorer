# What was checked

Every number the explorer shows was compared with an independent read of the same Hugging Face files, using DuckDB in Python (not the browser's DuckDB-WASM), with and without a filter. These scripts are the check. They were run on 2026-11-05 and 2026-11-06 against the files as published then, so counts will drift as the pipelines run.

| What | Script | Checks | Mismatches |
|---|---|---|---|
| EEOC decisions: Outcomes, Bases & issues, Over time | `check_eeoc.py` | 26 | 0 |
| EEOC file listing: Coverage, Crawl | `check_listing.py` | 18 | 0 |
| OPM union contracts: Terminations, Expirations, Documents | `check_cba.py` | 28 | 0 |
| J&A: Authority, Value, Vendors, Matched | `check_ja.py` | 36 | 0 |
| DoD: Branches, Companies, Places | `check_dod.py` | 18 | 0 |
| Pivot tables, 10 (2 per dataset: no filter, filter) | `check_pivot.py` | 49 | 0 |
| Record pages, 3 rows per dataset (every displayed field, title, subtitle, long text, source links) | `reccheck.py` | EEOC 105, listing 42, union contracts 93, J&A 102, DoD 39 | 0 |
| Related counts, 13 | inline, see the commit message | 13 | 0 |
| Previous/next, Back to results, bad keys | `navtest.py` | 6 | 0 |
| Popover, tabs, pager, page size, pivot sort | `uitest.py` | all behaved | |
| Source links resolve for the sample rows | `linkcheck.py` | see below | |

Mismatches that showed up on the way, all the check's mistake and not the page's:

- EEOC "Dated": two decisions have an empty-string date. The page treats it as blank (5,742 dated), my first check counted the empty string (5,744).
- Listing pivot: nine files have an empty extension and no date. The page shows them as "(blank)"; my check kept `''` and NULL apart.
- Union contracts "Flags by agency": Treasury and Transportation tie at 27. The page and DuckDB order the tie differently. The numbers match.
- Links: "File on OPM's site" and USAspending links returned 404 or an error to my HEAD request with a range header. A plain GET with a browser user agent returns 200.

Real bugs the checks found, fixed before commit:

- An empty link template (a J&A notice with no USAspending page) resolved to the current page's own address. Empty links are now dropped.
- A DoD section called "Source" collided with the links card of the same name. Renamed to "Article".
- "Saved files on Hugging Face" gave a 404 for a J&A notice with no attachments. It now shows only when the notice lists at least one.
- Stack-chart colors followed the series' rank, so a filter could repaint the series that were left. Colors now belong to the series name (`seriesOrder`).

Limits:

- Source links were fetched for the 3 sample rows per dataset, not for every row.
- Hugging Face throttles at times. When several browsers loaded at once during testing, a few page loads stalled for over a minute. A single page loads in 3 to 14 seconds. These runs were done one at a time.
- Chromium (headless) only. Not Firefox or Safari.

To rerun: `uv run --with playwright --with duckdb python verify/<script>.py`, with `CHROME_HEADLESS_SHELL` set to a Playwright `chrome-headless-shell` and the explorer served on port 8769 (`python3 -m http.server 8769`). Some scripts read `verify/keys.json` (the sample rows) and write their output next to it; run `drive.py <dataset> "<filter params>"` first for the `check_*` scripts.

## 2026-11-06 follow-up fixes

- Long lists are text filters with suggestions: EEOC agency (64 values), union (99), NAICS (686), J&A authority (205), DoD agency header (84). A text filter matches by contains, so a typed value can match several agencies. Counts were checked against DuckDB: EEOC "Veterans" 1,160 rows (49 found, 117 relief, 86 changed), union "American Federation" 584, NAICS "541" 3,625, authority "only one" 9,464, DoD "NAVY" 15,870.
- A range with From after To shows "From is after To" in the popover and on the page, and runs no query.
- Download CSV has a Raw values / Labels choice. EEOC filtered to Veterans Affairs and race: 389 rows in both modes, same file hashes as DuckDB, 0 field mismatches in raw, 0 Yes/No mismatches in labels.
- `uitest.py` now checks the narrow box (none on 2 options, present on 12) and the text filter with 64 suggestions. `uitest.py` and `navtest.py` pass. The data-view check scripts read output files that are not in the repo, so I did not rerun them; the paths they cover did not change.
