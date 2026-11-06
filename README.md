# Dataset Explorer

A static page for searching, filtering, charting and downloading tables that live on Hugging Face. No server, no build step: `index.html`, `app.js`, `style.css`, and one JSON config per dataset.

The browser runs [DuckDB-WASM](https://duckdb.org/docs/api/wasm/overview.html) and queries the Parquet or CSV file at its Hugging Face URL. The page holds no copy of the data, so it shows what is published now. The look follows the USAJOBS data site.

## Run it

Browsers block `file:` pages from fetching data, so serve the folder:

```bash
python3 -m http.server 8770
# open http://127.0.0.1:8770/
```

`?d=<id>` picks a dataset (`?d=eeoc`). With no `d`, or an unknown one, you get the list. Aliases work too: `?d=eeoc-decisions` opens `eeoc`.

## What it does

- **Views.** Tabs under the title. Each dataset has a table view, a few purpose-built chart views, and a generic "Pivot & counts" view. Filters, search and the "+ Add Filter" chips apply to every view, and every number recomputes for them.
- **Table.** Sort, page numbers with a page-size choice, CSV export (up to 250,000 rows).
- **Filters.** "+ Add Filter" opens a small popover under the toolbar (pick-list, contains, number or date range). Escape closes it.
- **Pivot.** Pick a row field, an optional column field and a measure (a row count, or a sum the config defines). Click a heading to sort, download the table as CSV. Heat tint scales with the cell value. It shows the top 200 rows and top 12 columns (the rest under Other); "All rows" always counts everything.
- **Record pages.** Click a row (or its first-column link) to open that record on its own page, with sections, source links, long text with a Copy button, related rows, and previous/next within the results you came from. Records load without the table.
- Copy Link, light and dark, and a card layout under 640 px. Every view and record is a URL.

URLs:

```
list    ?d=eeoc&v=outcomes&q=postal&f.agency=A&f.agency=B&f.decision_date.min=2026-01-01&sort=decision_date&dir=desc&page=2&size=100
pivot   ?d=eeoc&v=pivot&pr=agency&pc=discrimination_found&pm=<measure id>&ps=<sort key>&pd=asc|desc
record  ?d=eeoc&r=<record key>&back=<the list query to return to>
```

A blank in a pick-list is `__blank__`. Bad values in a link are ignored with a note. Unknown or missing record keys show a short message with a link back.

## Add a dataset

1. Copy `configs/eeoc.json` to `configs/<id>.json` (lowercase letters, digits, hyphens).
2. Add `{ "id", "title", "blurb", "aliases" }` to `configs/index.json`.
3. Fill in the config.

| Field | Meaning |
|---|---|
| `title`, `blurb` | Heading and subtitle. |
| `hfDataset` | `owner/name`. The "Updated" date comes from the Hugging Face API. |
| `source.format` | `parquet` or `csv`. |
| `source.urls` | One or more `resolve` URLs, read as one table. |
| `source.discover` | `{ "hfDataset", "path" }`. Lists the files under that folder when the page loads, following the API's paging, instead of fixed `urls`. |
| `source.materialize` | `true` loads the files into memory once, for list pages. Record pages skip it. |
| `source.csvOptions` | Extra `read_csv` options. CSVs are read as text, then cast per column. |
| `joins` | `[{ "id", "on", "urls" }]`: another Parquet file, left-joined to the main table on column `on`. Columns that come from it set `"join": "<id>"` (and `"from"` if the source column has a different name). A joined file must have one row per `on` value. |
| `key` | A column unique per row. Used for sort ties and record URLs. |
| `covers`, `caveats`, `links` | The collapsed "About this data". Keep to three short caveats. Put column notes in `help`. |
| `searchColumns`, `defaultSort`, `pageSize` | Search columns (text), `{ "col", "dir" }`, 1 to 500. |
| `columns` | One per column (below). Only listed columns are read. |
| `views` | A list. The first is the table view (`table` is forced on). Each: `{ "id", "label", "subtitle", "experimental", "stats", "charts" }`. A subtitle is at most about 10 words. `experimental: true` adds a badge. |
| `pivot` | `{ "default": "<column>", "columns": [...], "measures": [{ "id", "label", "expr", "format" }] }`. A measure `expr` must be an additive aggregate such as `sum(pages)`. The page adds the "Pivot & counts" tab when this exists. |
| `record` | The record page (below). Required. |

**Stats** are `{ "label", "expr", "hint", "format" }`: `expr` is a SQL aggregate over `t`; `format` is `currency` (whole dollars), `billions` or `millions` (the value is in dollars, shown as `$1.2B` or `$3.4M`) or `percent`. Labels are 1 to 3 words.

**Charts** are `{ "type", "title", "unit", "format", "limit", ... }`. `label` and `x` are SQL expressions over `t`; `value` defaults to `count(*)`.

- `month` and `year`: `label` must give `YYYY-MM` or `YYYY`. Periods with no rows are drawn as zero, so a gap shows as a gap.
- `top`: the `limit` biggest groups (max 50) as horizontal bars. `min` keeps groups with at least that many rows.
- `items`: a bar per `{ "label", "expr" }` item, each a SQL aggregate. For flag counts and rates.
- `stack`: `x` and `series` expressions. `kind` is `month`, `year` or `category` (default). Categories are the top `limit` by total; the biggest `seriesLimit` (default 5) series get their own color, the rest fold into Other. Series colors are the first five slots of the data-viz default palette.

Blank labels are left out of the bars and counted in a note under the chart. Set `"blank": false` on a chart whose value is an average or a ratio, where that note means nothing. When a chart groups more than 20,000 values, the note says "more than". Every chart has a "Table" with its numbers.

**Columns**: `key`, `label`, `type` (`text`, `number`, `date`, `bool`), and optionally `filter` (`select`, `text`, `range`; use `text` with `suggest: true` for a column with more than about 50 values, which gives a contains box with a suggestion list instead of a checkbox list), `show: false`, `format: "currency"`, `link`, `help` (hover text), `expr` (a SQL expression for a derived column; in a config with `joins`, write main-table columns as `m.<col>`), `join`, `from`.

**Record** (`record`):

| Field | Meaning |
|---|---|
| `key` | The record key column (same as the top-level `key` in these configs). |
| `title`, `subtitle` | Templates. `title` can be a list; the first that fills in wins. |
| `sections` | `[{ "title", "columns": [...] }]`: the fields shown, in cards. |
| `text` | `[{ "label", "column" }]`: long text in a readable block with a Copy button. |
| `links` | `[{ "label", "href", "showIf": { "col", "equals" } }]`: shown in a "Source" card. |
| `related` | `[{ "label", "cols": [...], "title", "sub", "limit", "lazy", "button" }]`: other rows with the same value in all of `cols`, with links to their own record pages. `"lazy": true` waits for a click (with `button` as its text), for a table too big to scan on every record. |
| `more` | Extra tables loaded on request, for large files (the J&A attachments). |
| `outline` | An ordered list of questions for one record, read from a questions file when the record opens: `{ "label", "discover", "where", "value", "columns": { block, section, kind, ordinal, number, text, type, options, trailing, id }, "intros": { discover, block, text }, "link", "empty" }`. `discover` is `{ hfDataset, path }`; `where` is the column in that file that matches the record's `value` column; `link` is the dataset id that question ids open in; `empty` is the message when nothing is stored. Used for questionnaires. |

Templates use `{column}` for the value and `{column:enc}` for a URL-encoded one. Links must be http or https, and an empty link is dropped. The page checks the config on load and stops with a plain message if a column is missing from the file or a template names an unknown column.

## One site per dataset

The same engine can run as a site for one dataset. `python3 scripts/build_sites.py` writes a folder per site under `dist-sites/<slug>/` (`index.html`, `app.js`, `style.css`, `site.json`, and only that site's configs). Upload a folder at the root of any static host; nothing in it refers to the other sites.

| Folder | Tables |
|---|---|
| `eeoc-decisions` | EEOC decisions (opens first), EEOC file listing |
| `opm-union-contracts` | OPM union contracts |
| `sf133-budget-execution` | SF-133 budget execution |
| `usajobs-questionnaires` | USAJOBS questionnaires (opens first), USAJOBS questions |
| `federal-ja-documents` | J&A documents |

In a site folder, `?d=` is optional: the default table opens without it, and `?d=<id>` still picks another table of the same site. The heading, tab title, favicon letters and subtitle are the site's own. The nav lists only that site's tables (it is hidden when there is one), and an unknown `?d=` lists only those tables. The footer links to the dataset on Hugging Face, the code and "More datasets". That last link is the constant `MORE_DATASETS_URL` in `scripts/build_sites.py`, a placeholder until the adoption page has an address.

`site.json`: `{ "title", "pageTitle", "default", "datasets", "hfUrl", "repoUrl", "moreLabel", "moreUrl" }`. Without it (the repo root and `./build-dist.sh`), the explorer behaves as the combined list of datasets. To add a site, add an entry to `SITES` in the script; the build stops if a config links to a dataset the site does not hold.

## Host it

Any static host works: upload the folder as is (the repo root for the combined explorer, `./build-dist.sh` for `dist/`, or one folder from `dist-sites/`). Visitors need to reach `cdn.jsdelivr.net` (DuckDB-WASM 1.29.0 and Chart.js 4.4.0, both pinned), Google Fonts and `huggingface.co`. Hugging Face allows cross-origin range requests, which is what lets the browser read parts of a Parquet file. Datasets must be public.

## Limits

- First open downloads the database engine, then reads the table's metadata. Measured on a fast connection: EEOC decisions 2.3 s, DoD (3 files) 4.2 s, SF-133 accounts 6 s, USAJOBS questionnaires 12 s, J&A and the EEOC listing a few seconds. The USAJOBS questions table (949,370 rows) is read into memory once, about 13 s the first time and 7 to 9 s for each later page load. The same DoD table as 87 small files took 37 s, so fewer, larger files matter.
- SF-133 amounts are summed over the rows shown. A row is one account in one fiscal year, so pick a fiscal year before reading a total.
- Pick-list counts cover the whole table, not the current filters.
- Hugging Face can throttle many fast requests (HTTP 429). The page says so. We did not see it in testing.
- Charts use Chart.js: one color for single series, the data-viz default palette (with a legend) for stacked ones. Long labels are shortened on narrow screens; the Table under each chart and the hover tooltip have the full text.

## Checked

Stat cards, chart tables, pivot tables, record pages and related counts were compared with an independent DuckDB (Python) read of the same files, with and without a filter. The scripts, the sample rows, what matched and what the first checks got wrong are in `verify/README.md`. Screenshots are in `screenshots/`. There is no automated test suite.

## Deploying

Each dataset site is its own Cloudflare Pages project, named after its slug (`eeoc-decisions`,
`opm-union-contracts`, `sf133-budget-execution`, `usajobs-questionnaires`, `federal-ja-documents`).
`.github/workflows/deploy-sites.yml` builds `dist-sites/` and deploys all five whenever the engine
(`index.html`, `app.js`, `style.css`), a config or `scripts/build_sites.py` changes on `main`. It needs two
repository secrets: `CLOUDFLARE_API_TOKEN` (Account > Cloudflare Pages > Edit) and `CLOUDFLARE_ACCOUNT_ID`.
Without them the run builds the sites and skips the deploy with a notice. The data is read from Hugging
Face when a page loads, so the sites never need a data refresh.
