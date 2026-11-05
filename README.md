# Dataset Explorer

A static page that lets anyone search, filter, sort, page through, link to and download a table that lives on Hugging Face. There is no server and no build step. One `index.html`, one `app.js`, one `style.css`, and one JSON config per dataset.

The browser runs [DuckDB-WASM](https://duckdb.org/docs/api/wasm/overview.html) and queries the Parquet or CSV file at its Hugging Face `resolve` URL. The page never holds a copy of the data, so it shows what is published now.

## Run it

Browsers block `file:` pages from fetching data, so serve the folder:

```bash
python3 -m http.server 8770
# open http://127.0.0.1:8770/
```

Open `?d=<id>` to pick a dataset, for example `?d=eeoc`. With no `d` you get the list.

## What it does

- Search across the columns the config names (every word must match somewhere).
- Filters per column: pick-list (several values), "contains" text, and number or date ranges.
- Click a column header to sort. Paging runs in SQL (`LIMIT`/`OFFSET`), so it stays fast on large tables.
- Click a row for a detail panel with every column and links to the source documents.
- Download the filtered rows as CSV (up to 250,000 rows).
- Every view is in the URL (search, filters, sort, page, open row), so a link reproduces it. Unknown or invalid values in a link are ignored with a visible note.
- Light and dark, and a card layout under 640 px.

URL form: `?d=eeoc&q=postal&f.agency=A&f.agency=B&f.decision_date.min=2026-01-01&sort=decision_date&dir=desc&page=2&open=<key>`. A blank value in a pick-list is `__blank__`.

## Add a dataset

1. Copy `configs/eeoc.json` to `configs/<id>.json` (ids are lowercase letters, digits and hyphens).
2. Add `{ "id", "title", "blurb" }` to `configs/index.json`.
3. Fill in the config:

| Field | Meaning |
|---|---|
| `title`, `blurb` | Heading and one-line description. |
| `hfDataset` | `owner/name`. The page reads its last-changed date from the Hugging Face API. |
| `source.format` | `parquet` or `csv`. |
| `source.urls` | One or more `resolve` URLs. Several files are read as one table. |
| `source.materialize` | `true` loads the files into memory once. Use it for a table split into many small files. |
| `source.csvOptions` | Extra `read_csv` options. CSVs are read as all text, then cast per column. |
| `key` | A column that is unique per row. Used for sorting ties, the detail panel and `open=` links. |
| `asOf` | `{ "sql": "SELECT ... FROM t", "label": "... {value}." }`, shown under the title. Cast to text in the SQL. |
| `covers`, `caveats` | What the table covers, and the warnings. Shown on the page. Say what is excluded or model-made. |
| `links` | Dataset card, code, source. |
| `searchColumns` | Text columns the search box looks in. |
| `defaultSort` | `{ "col", "dir" }`. |
| `pageSize` | 1 to 500. |
| `detail` | `{ "title": "{col} ...", "links": [{ "label", "href", "showIf": { "col", "equals" } }] }`. |
| `columns` | One entry per column (below). Only listed columns are read. |

Each column: `key`, `label`, `type` (`text`, `number`, `date`, `bool`), and optionally `filter` (`select`, `text`, or `range` for numbers and dates), `show: false` (kept for the detail panel and CSV but not in the grid), `format: "currency"`, `link` (a template that makes the cell a link), and `expr` (a SQL expression over the source columns, for a computed key).

Templates use `{column}` for the raw value and `{column:enc}` for a URL-encoded one. Links must be http or https.

The page checks the config when it loads and stops with a plain message if a column is missing from the file, a template names an unknown column, or the file can't be read.

## Host it

Any static host works: Cloudflare Pages, Netlify, Vercel, GitHub Pages, or an S3 bucket. Upload the folder as is. Nothing runs server-side.

- The page loads DuckDB-WASM from `cdn.jsdelivr.net` (version pinned in `app.js`). Visitors need to reach it and `huggingface.co`.
- Hugging Face allows cross-origin range requests, which is what lets the browser read only the parts of a Parquet file it needs. Check this still holds if you point at another host.
- A dataset needs to be public. There is no place for a token.

## Limits

- First load downloads and starts the database engine (a few MB) and then reads the table's metadata. Measured on a fast connection: 1.4 s for a 1 MB CSV, 3.2 s for a 0.7 MB Parquet, 3.7 s for a 116,000-row Parquet, 6.7 s for a 17 MB Parquet. A table split into 87 small files took 37 s (86 s without `materialize`). Fewer, larger files open much faster.
- Pick-list counts are for the whole table, not the current filters.
- Hugging Face can throttle many fast requests (HTTP 429). The page shows a message and asks you to wait. We did not see throttling in testing.
- CSV exports open in a spreadsheet as numbers. Open them as text so leading zeros survive.

## Where the patterns came from

DuckDB-WASM startup (worker via a blob and `importScripts`) follows `federal-hiring-explorer`. Filter chips, the narrow-the-list pick-list and shareable URLs follow `regulations-comment-explorer`, `terminations` and the `shareable-filter-urls` skill. Config-driven columns come from the older `data-explorer`, now with SQL in place of in-memory rows.

## Tests

There is no automated test suite yet. The numbers in the report that came with this were checked by running the same filters in Python with DuckDB reading the same files and comparing counts, and by comparing an exported CSV with the source field by field.
