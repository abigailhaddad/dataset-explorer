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

## 2026-11-06: SF-133 and USAJOBS questionnaires

Checked against DuckDB (Python) reading the same published files, with and without a filter. Run one at a time on a local server.

| What | Script | Checks | Mismatches |
|---|---|---|---|
| SF-133: Accounts, By agency, Gift accounts, Over time (no filter, fiscal year 2025, agency contains Defense) | `check_sf133.py` | 72 | 0 |
| USAJOBS questionnaires: Questionnaires, By agency, Over time, Reading (no filter, agency contains Veterans, department Defense) | `check_questionnaires.py` | 57 | 0 |
| USAJOBS questions: Questions, Common questions, By agency, Kinds (no filter, agency, section kind, a search) | `check_questions.py` | 68 | 0 |
| Pivots, 6 (2 per dataset) | `check_pivot_new.py` | 18 | 0 |
| Record pages, 5 rows per dataset (every field, title, subtitle, text, source links) | `reccheck.py` with `keys_new.json` | SF-133 110, questionnaires 115, questions 75 | 0 |
| Questionnaire outline (5 questionnaires: questions, order, options, section headings) and the lazy "same wording" count | `check_outline.py` | 24 | 0 |
| Each per-site folder served at its own root (front page with no `?d=`, heading, tab title, favicon letters, nav, footer links, record page and back link, explicit and unknown `?d=`, second table, no sideways scroll; front-page numbers equal the combined explorer's) | `check_sites.py` | desktop 74, phone (390 px) 65 | 0 |

Things the checks found:

- Chart labels on code columns showed raw codes (`ok`, `monster_not_parsed`, `single_choice`). The new configs use plain-word labels in the chart's own expression.
- A chart over `n_options` labelled its bars `2.0`. The label now casts to a whole number.
- "Top 25 of 19,999" under the most-repeated-wordings chart: the chart reads at most 20,000 groups, so the note now says "more than 19,999".
- An "average length" chart said "0.01 blank, not shown", the average of the blank group. `"blank": false` turns the note off for averages.
- Check artifacts, not page errors: a currency amount ending in .50 rounds up in the page and to even in Python; Python printed `3.0` for a number the page prints as `3`; the page treats an empty string as blank, so one empty question text is not counted as a distinct wording (156,120 on the page, 156,121 with the empty string).

Not checked: Firefox and Safari; source links for every row (the OMB and Hugging Face links were not fetched); hover tooltips.

Per-site folders (`dist-sites/<slug>/`, from `scripts/build_sites.py`): run one site at a time (`python3 verify/check_sites.py <slug> 1280` or `390`) with the folders served on ports 8801 to 8805 in the order eeoc-decisions, opm-union-contracts, sf133-budget-execution, usajobs-questionnaires, federal-ja-documents, and the combined explorer on 8790. The J&A front page showed 20,019 notices on this run; the dataset updates daily, so the number moves.
