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

- Search, "+ Add Filter" chips (pick-list, contains, number or date range), sort, paging in SQL.
- Stat cards and charts that recompute for the current filters. Each chart has a "Table" under it with the numbers.
- Row detail panel with links to the source documents.
- Copy Link and Download CSV (up to 250,000 rows). Every view is in the URL; bad values in a link are ignored with a note.
- Light and dark, and a card layout under 640 px.

URL form: `?d=eeoc&q=postal&f.agency=A&f.agency=B&f.decision_date.min=2026-01-01&sort=decision_date&dir=desc&page=2&open=<key>`. A blank in a pick-list is `__blank__`.

## Add a dataset

1. Copy `configs/eeoc.json` to `configs/<id>.json` (lowercase letters, digits, hyphens).
2. Add `{ "id", "title", "blurb", "aliases" }` to `configs/index.json`. `aliases` are other names that should open it, such as the Hugging Face dataset name.
3. Fill in the config.

| Field | Meaning |
|---|---|
| `title`, `blurb` | Heading and subtitle. Keep the subtitle under about 12 words. |
| `hfDataset` | `owner/name`. The "Updated" date comes from the Hugging Face API. |
| `source.format` | `parquet` or `csv`. |
| `source.urls` | One or more `resolve` URLs, read as one table. |
| `source.discover` | `{ "hfDataset", "path" }`. Lists the files under that folder when the page loads, following the API's paging, instead of fixed `urls`. Use it when files get renamed or merged. |
| `source.materialize` | `true` loads the files into memory once. Helps when a table is many small files, or when charts need many group-bys. |
| `source.csvOptions` | Extra `read_csv` options. CSVs are read as text, then cast per column. |
| `key` | A column unique per row. Used for sort ties, the detail panel and `open=`. |
| `covers`, `caveats` | Shown in the collapsed "About this data". Keep to three short caveats, each one a reader would otherwise get wrong. Put column-level notes in `help`. |
| `links` | Dataset card, code, source. |
| `searchColumns`, `defaultSort`, `pageSize` | Search columns (text), `{ "col", "dir" }`, 1 to 500. |
| `detail` | `{ "title": "{col} ...", "links": [{ "label", "href", "showIf": { "col", "equals" } }] }`. |
| `stats` | Stat cards: `{ "label", "expr", "hint" }`. `expr` is a SQL aggregate over `t`, such as `count(DISTINCT agency)`. Label: 1 to 3 words. |
| `charts` | `{ "type", "title", "label", "value", "unit", "limit" }`. See below. |
| `columns` | One per column (below). Only listed columns are read. |

Charts. `label` is a SQL expression over `t`; `value` defaults to `count(*)`.

- `month`: `label` must give `YYYY-MM` (for example `strftime(date, '%Y-%m')`). Months with no rows are drawn as zero, so a gap shows as a gap.
- `year`: same, `YYYY`.
- `top`: the `limit` largest groups (default 10, max 50), as horizontal bars.

Rows whose label is blank are left out of the bars and counted in a note under the chart.

Each column: `key`, `label`, `type` (`text`, `number`, `date`, `bool`), and optionally `filter` (`select`, `text`, or `range`), `show: false`, `format: "currency"`, `link` (a URL template), `help` (hover text on the header and in the detail panel), and `expr` (a SQL expression for a computed column).

Templates use `{column}` for the value and `{column:enc}` for a URL-encoded one. Links must be http or https. The page checks the config on load and stops with a plain message if a column is missing from the file or a template names an unknown column.

## Host it

Any static host works: upload the folder as is. Visitors need to reach `cdn.jsdelivr.net` (DuckDB-WASM 1.29.0 and Chart.js 4.4.0, both pinned), Google Fonts and `huggingface.co`. Hugging Face allows cross-origin range requests, which is what lets the browser read parts of a Parquet file. Datasets must be public.

## Limits

- First open downloads the database engine, then reads the table's metadata. Measured on a fast connection: EEOC decisions 2.3 s, DoD (3 files) 4.2 s, J&A and the EEOC listing a few seconds. The same DoD table as 87 small files took 37 s, so fewer, larger files matter.
- Pick-list counts cover the whole table, not the current filters.
- Hugging Face can throttle many fast requests (HTTP 429). The page says so. We did not see it in testing.
- Charts use Chart.js, with one color and no legend. Long labels are shortened on narrow screens; the Table under each chart and the hover tooltip have the full text.

## Checked

Stat cards and chart totals were compared with an independent DuckDB (Python) count over the same files, for EEOC decisions, OPM union contracts, J&A and DoD, with and without filters, and for the EEOC listing without filters. All matched. There is no automated test suite.
