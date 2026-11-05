/* Dataset Explorer. One page, one JSON config per dataset (configs/<id>.json).
 *
 * DuckDB-WASM reads the Parquet/CSV straight from its HTTPS URL (Hugging Face
 * "resolve" links), so the page never holds a copy and shows whatever is
 * published now. Every number on the page comes from a SQL query against a view
 * called `t` that is built from the config's column list.
 *
 * State has one owner: `view` (search, filters, sort, page, open row). The URL
 * is written from it (writeURL) and read back into it (readURL). Controls,
 * chips, stats and charts are drawn from it. Nothing else keeps a copy.
 *
 * URL: ?d=<dataset>&q=<search>&f.<col>=<value> (repeat for several values)
 *      &f.<col>.min= &f.<col>.max= &sort=<col>&dir=asc|desc&page=<n>&open=<key>
 *
 * Config shape is documented in README.md. Chart.js is a classic script in
 * index.html and is used as the global `Chart`.
 */
import * as duckdb from 'https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.29.0/+esm';

const BLANK = '__blank__';
const EXPORT_LIMIT = 250000;
const FACET_LIMIT = 500;
const CHART_GROUP_LIMIT = 5000;

const el = (id) => document.getElementById(id);
const qi = (name) => '"' + name.replace(/"/g, '""') + '"';

// Set once while starting; read-only afterwards.
let config = null;
let db = null;
let conn = null;
const facets = {}; // column key -> { truncated, items: [{ value, label, n }] }
const colByKey = {};
const charts = []; // { spec, chart, box, foot, tbody }
let sourceUrls = []; // the data files actually read; set once in createView

// The one owner of what the user is looking at.
const view = { q: '', filters: {}, sort: { col: null, dir: 'asc' }, page: 1, open: null };
let total = 0;
let notices = [];
let latest = 0; // bumped on every refresh so a slow, stale answer is dropped
let typingTimer = null;

/* ---------- messages ---------- */

function setStatus(text, kind, busy) {
  const box = el('status');
  box.replaceChildren();
  if (!text) return;
  const msg = document.createElement('div');
  msg.className = 'msg ' + (kind || '');
  msg.textContent = text;
  if (busy) {
    const bar = document.createElement('div');
    bar.className = 'bar';
    bar.append(document.createElement('i'));
    msg.append(bar);
  }
  box.append(msg);
}

let ticker = null;
function busy(msg) {
  clearInterval(ticker);
  const t0 = performance.now();
  setStatus(msg, '', true);
  ticker = setInterval(() => setStatus(msg + ' ' + Math.round((performance.now() - t0) / 1000) + ' s', '', true), 1000);
}

function fail(err) {
  clearInterval(ticker);
  console.error(err);
  const text = String(err && err.message ? err.message : err);
  const throttled = /429|too many requests/i.test(text);
  setStatus(throttled ? 'Hugging Face is limiting requests. Wait a minute, then reload.' : text, 'error');
}

function showNotices() {
  setStatus(notices.length ? notices.join(' ') : '', 'warn');
}

/* ---------- config ---------- */

async function fetchJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(url + ': HTTP ' + r.status);
  return r.json();
}

function checkConfig(c) {
  const bad = (msg) => { throw new Error('Config ' + c.id + ': ' + msg); };
  for (const k of ['id', 'title', 'key', 'source', 'columns', 'searchColumns', 'covers']) {
    if (!c[k]) bad('missing "' + k + '"');
  }
  if (!['parquet', 'csv'].includes(c.source.format)) bad('source.format must be parquet or csv');
  if (c.source.discover) {
    if (!c.source.discover.hfDataset || !c.source.discover.path) bad('source.discover needs hfDataset and path');
  } else if (!Array.isArray(c.source.urls) || !c.source.urls.length) {
    bad('source.urls must be a list');
  }
  if (!(c.pageSize >= 1 && c.pageSize <= 500)) bad('pageSize must be 1 to 500');
  for (const col of c.columns) {
    if (!['text', 'number', 'date', 'bool'].includes(col.type)) bad(col.key + ': type must be text, number, date or bool');
    if (col.filter && !['select', 'text', 'range'].includes(col.filter)) bad(col.key + ': unknown filter ' + col.filter);
    if (col.filter === 'range' && !['number', 'date'].includes(col.type)) bad(col.key + ': range needs a number or date column');
    colByKey[col.key] = col;
  }
  if (!colByKey[c.key]) bad('key column ' + c.key + ' is not in columns');
  for (const s of c.searchColumns) {
    if (!colByKey[s] || colByKey[s].type !== 'text') bad('searchColumns: ' + s + ' must be a text column');
  }
  if (c.defaultSort && !colByKey[c.defaultSort.col]) bad('defaultSort column is not in columns');
  for (const s of c.stats || []) {
    if (!s.label || !s.expr) bad('each stat needs a label and an expr');
  }
  for (const ch of c.charts || []) {
    if (!['month', 'year', 'top'].includes(ch.type)) bad('chart type must be month, year or top');
    if (!ch.title || !ch.label) bad('each chart needs a title and a label expression');
    if (ch.limit !== undefined && !(ch.limit >= 1 && ch.limit <= 50)) bad('chart limit must be 1 to 50');
  }
  const templates = [];
  for (const col of c.columns) if (col.link) templates.push(col.link);
  for (const l of (c.detail && c.detail.links) || []) templates.push(l.href);
  if (c.detail && c.detail.title) templates.push(c.detail.title);
  for (const t of templates) {
    for (const m of t.matchAll(/\{(\w+)(?::enc)?\}/g)) {
      if (!colByKey[m[1]]) bad('template ' + t + ' uses unknown column ' + m[1]);
    }
  }
}

function fill(template, row) {
  return template.replace(/\{(\w+)(:enc)?\}/g, (m, k, enc) => {
    const v = row[k];
    if (v === null || v === undefined) return '';
    return enc ? encodeURIComponent(v) : String(v);
  });
}

function safeHref(href) {
  try {
    const u = new URL(href, location.href);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch (e) {
    return null;
  }
}

/* ---------- DuckDB ---------- */

async function startDuckDB() {
  const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
  const workerUrl = URL.createObjectURL(
    new Blob(['importScripts("' + bundle.mainWorker + '");'], { type: 'text/javascript' })
  );
  db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), new Worker(workerUrl));
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  URL.revokeObjectURL(workerUrl);
  conn = await db.connect();
}

async function runQuery(sql, params) {
  const stmt = await conn.prepare(sql);
  try {
    const table = await stmt.query(...params);
    return table.toArray().map((r) => r.toJSON());
  } finally {
    await stmt.close();
  }
}

// List the data files of a Hugging Face dataset folder now, so the page keeps
// working when the files are renamed or merged. The tree API returns at most
// 1000 entries a page and names the next page in the Link header.
async function discoverUrls(d) {
  const ext = '.' + config.source.format;
  const found = [];
  let next = 'https://huggingface.co/api/datasets/' + d.hfDataset + '/tree/main/' + d.path;
  while (next) {
    const r = await fetch(next);
    if (!r.ok) throw new Error(next + ': HTTP ' + r.status);
    for (const f of await r.json()) {
      if (f.type === 'file' && f.path.endsWith(ext)) found.push(f.path);
    }
    const link = r.headers.get('Link');
    const m = link && link.match(/<([^>]+)>;\s*rel="next"/);
    next = m ? m[1] : null;
  }
  if (!found.length) throw new Error('No ' + ext + ' files under ' + d.path + ' in ' + d.hfDataset + '.');
  found.sort();
  return found.map((p) => 'https://huggingface.co/datasets/' + d.hfDataset + '/resolve/main/' + p);
}

async function createView() {
  const ext = config.source.format;
  sourceUrls = config.source.discover ? await discoverUrls(config.source.discover) : config.source.urls;
  const names = [];
  for (let i = 0; i < sourceUrls.length; i++) {
    const name = 'src' + i + '.' + ext;
    await db.registerFileURL(name, sourceUrls[i], duckdb.DuckDBDataProtocol.HTTP, false);
    names.push("'" + name + "'");
  }
  const list = '[' + names.join(', ') + ']';
  let rel = ext === 'parquet'
    ? 'read_parquet(' + list + ', union_by_name=true)'
    : 'read_csv(' + list + ', header=true, all_varchar=true' + (config.source.csvOptions ? ', ' + config.source.csvOptions : '') + ')';
  // Many small files: read them once into memory instead of re-reading every
  // file's footer on every query.
  let found = null;
  try {
    if (config.source.materialize) {
      await conn.query('CREATE OR REPLACE TABLE raw AS SELECT * FROM ' + rel);
      rel = 'raw';
    }
    found = new Set((await runQuery('DESCRIBE SELECT * FROM ' + rel, [])).map((r) => r.column_name));
  } catch (e) {
    throw new Error('Could not read ' + sourceUrls[0] + ' (' + e.message + '). The file may have moved, or Hugging Face is limiting requests.');
  }
  const missing = config.columns.filter((c) => !c.expr && !found.has(c.key)).map((c) => c.key);
  if (missing.length) throw new Error('The file has no column named ' + missing.join(', ') + '. Check the config.');

  const exprs = config.columns.map((c) => {
    if (c.expr) return '(' + c.expr + ') AS ' + qi(c.key);
    if (c.type === 'number') return 'TRY_CAST(' + qi(c.key) + ' AS DOUBLE) AS ' + qi(c.key);
    if (c.type === 'date') return 'TRY_CAST(' + qi(c.key) + ' AS DATE) AS ' + qi(c.key);
    if (c.type === 'bool') return 'TRY_CAST(' + qi(c.key) + ' AS BOOLEAN) AS ' + qi(c.key);
    return "NULLIF(CAST(" + qi(c.key) + " AS VARCHAR), '') AS " + qi(c.key);
  });
  await conn.query('CREATE OR REPLACE VIEW t AS SELECT ' + exprs.join(', ') + ' FROM ' + rel);
}

// Dates come back as text so they print and export as YYYY-MM-DD.
function selectList() {
  return config.columns
    .map((c) => (c.type === 'date' ? 'CAST(' + qi(c.key) + ' AS VARCHAR) AS ' + qi(c.key) : qi(c.key)))
    .join(', ');
}

async function loadFacets() {
  for (const c of config.columns.filter((x) => x.filter === 'select')) {
    const rows = await runQuery(
      'SELECT CAST(' + qi(c.key) + ' AS VARCHAR) AS v, count(*) AS n FROM t GROUP BY 1 ORDER BY n DESC, v LIMIT ' + (FACET_LIMIT + 1), []
    );
    const truncated = rows.length > FACET_LIMIT;
    facets[c.key] = {
      truncated,
      items: rows.slice(0, FACET_LIMIT).map((r) => ({
        value: r.v === null ? BLANK : r.v,
        label: r.v === null ? '(blank)' : c.type === 'bool' ? (r.v === 'true' ? 'Yes' : 'No') : r.v,
        n: Number(r.n),
      })),
    };
  }
}

/* ---------- state <-> URL ---------- */

function emptyFilters() {
  const f = {};
  for (const c of config.columns) {
    if (c.filter === 'select') f[c.key] = [];
    if (c.filter === 'text') f[c.key] = '';
    if (c.filter === 'range') f[c.key] = { min: '', max: '' };
  }
  return f;
}

function validBound(c, v) {
  if (v === '') return true;
  if (c.type === 'number') return Number.isFinite(Number(v));
  return /^\d{4}-\d{2}-\d{2}$/.test(v);
}

function readURL() {
  notices = [];
  const p = new URLSearchParams(location.search);
  view.q = p.get('q') || '';
  view.filters = emptyFilters();
  for (const c of config.columns) {
    if (c.filter === 'select') view.filters[c.key] = p.getAll('f.' + c.key);
    if (c.filter === 'text') view.filters[c.key] = p.get('f.' + c.key) || '';
    if (c.filter === 'range') {
      for (const end of ['min', 'max']) {
        const v = p.get('f.' + c.key + '.' + end) || '';
        if (validBound(c, v)) view.filters[c.key][end] = v;
        else notices.push('Ignored "' + v + '" for ' + c.label + ': not a valid ' + c.type + '.');
      }
    }
  }
  for (const name of p.keys()) {
    if (!name.startsWith('f.')) continue;
    const key = name.slice(2).replace(/\.(min|max)$/, '');
    if (!colByKey[key] || !colByKey[key].filter) notices.push('Ignored unknown filter "' + name + '".');
  }
  const ds = config.defaultSort || {};
  let col = p.get('sort') || ds.col || null;
  if (col && !colByKey[col]) {
    notices.push('Ignored unknown sort column "' + col + '".');
    col = ds.col || null;
  }
  const dir = p.get('dir') || ds.dir || 'asc';
  view.sort = { col, dir: dir === 'desc' ? 'desc' : 'asc' };
  view.page = Math.max(1, parseInt(p.get('page') || '1', 10) || 1);
  view.open = p.get('open');
}

function writeURL(push) {
  const p = new URLSearchParams();
  p.set('d', config.id);
  if (view.q) p.set('q', view.q);
  for (const c of config.columns) {
    const f = view.filters[c.key];
    if (c.filter === 'select') for (const v of f) p.append('f.' + c.key, v);
    if (c.filter === 'text' && f) p.set('f.' + c.key, f);
    if (c.filter === 'range') {
      if (f.min !== '') p.set('f.' + c.key + '.min', f.min);
      if (f.max !== '') p.set('f.' + c.key + '.max', f.max);
    }
  }
  const ds = config.defaultSort || {};
  if (view.sort.col && (view.sort.col !== ds.col || view.sort.dir !== (ds.dir || 'asc'))) {
    p.set('sort', view.sort.col);
    p.set('dir', view.sort.dir);
  }
  if (view.page > 1) p.set('page', String(view.page));
  if (view.open) p.set('open', view.open);
  const url = location.pathname + '?' + p;
  if (push) history.pushState(null, '', url);
  else history.replaceState(null, '', url);
}

/* ---------- SQL from state ---------- */

function likePattern(s) {
  return '%' + s.replace(/[\\%_]/g, '\\$&') + '%';
}

function buildWhere() {
  const parts = [];
  const params = [];
  for (const term of view.q.split(/\s+/).filter(Boolean)) {
    parts.push('(' + config.searchColumns.map((c) => qi(c) + " ILIKE ? ESCAPE '\\'").join(' OR ') + ')');
    for (let i = 0; i < config.searchColumns.length; i++) params.push(likePattern(term));
  }
  for (const c of config.columns) {
    const f = view.filters[c.key];
    if (c.filter === 'select' && f.length) {
      const vals = f.filter((v) => v !== BLANK);
      const bits = [];
      if (vals.length) {
        bits.push('CAST(' + qi(c.key) + ' AS VARCHAR) IN (' + vals.map(() => '?').join(',') + ')');
        params.push(...vals);
      }
      if (f.includes(BLANK)) bits.push(qi(c.key) + ' IS NULL');
      parts.push('(' + bits.join(' OR ') + ')');
    }
    if (c.filter === 'text' && f) {
      parts.push(qi(c.key) + " ILIKE ? ESCAPE '\\'");
      params.push(likePattern(f));
    }
    if (c.filter === 'range') {
      if (f.min !== '') {
        parts.push(qi(c.key) + (c.type === 'date' ? ' >= CAST(? AS DATE)' : ' >= ?'));
        params.push(c.type === 'date' ? f.min : Number(f.min));
      }
      if (f.max !== '') {
        parts.push(qi(c.key) + (c.type === 'date' ? ' <= CAST(? AS DATE)' : ' <= ?'));
        params.push(c.type === 'date' ? f.max : Number(f.max));
      }
    }
  }
  return { sql: parts.length ? ' WHERE ' + parts.join(' AND ') : '', params };
}

function orderBy() {
  const key = qi(config.key);
  if (!view.sort.col) return ' ORDER BY ' + key;
  return ' ORDER BY ' + qi(view.sort.col) + (view.sort.dir === 'desc' ? ' DESC' : ' ASC') + ' NULLS LAST, ' + key;
}

/* ---------- table ---------- */

function formatValue(c, v) {
  if (v === null || v === undefined || v === '') return '';
  if (c.type === 'bool') return v ? 'Yes' : 'No';
  if (c.type === 'number') {
    const n = Number(v);
    if (c.format === 'currency') return '$' + n.toLocaleString(undefined, { maximumFractionDigits: 0 });
    return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }
  return String(v);
}

function cellNode(c, row) {
  const text = formatValue(c, row[c.key]);
  const span = document.createElement('span');
  span.className = 'cell';
  span.title = text;
  const href = c.link && text ? safeHref(fill(c.link, row)) : null;
  if (href) {
    const a = document.createElement('a');
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = text;
    span.append(a);
  } else {
    span.textContent = text;
  }
  return span;
}

function shownColumns() {
  return config.columns.filter((c) => c.show !== false);
}

function buildTableHead() {
  const head = el('grid').tHead;
  head.replaceChildren();
  const tr = document.createElement('tr');
  for (const c of shownColumns()) {
    const th = document.createElement('th');
    th.textContent = c.label;
    th.dataset.key = c.key;
    th.tabIndex = 0;
    if (c.help) th.title = c.help;
    tr.append(th);
  }
  head.append(tr);
}

function renderGrid(rows) {
  const body = el('grid').tBodies[0];
  body.replaceChildren();
  for (const row of rows) {
    const tr = document.createElement('tr');
    tr.dataset.key = row[config.key];
    for (const c of shownColumns()) {
      const td = document.createElement('td');
      td.dataset.label = c.label;
      if (c.type === 'number') td.className = 'num';
      if (row[c.key] === null || row[c.key] === '') td.classList.add('empty');
      td.append(cellNode(c, row));
      tr.append(td);
    }
    body.append(tr);
  }
}

function renderSummary() {
  const size = config.pageSize;
  const pages = Math.max(1, Math.ceil(total / size));
  const from = total ? (view.page - 1) * size + 1 : 0;
  const to = Math.min(total, view.page * size);
  el('summary').textContent = total
    ? from.toLocaleString() + ' to ' + to.toLocaleString() + ' of ' + total.toLocaleString() + ' rows'
    : 'No rows match.';
  el('pageinfo').textContent = 'Page ' + view.page.toLocaleString() + ' of ' + pages.toLocaleString();
  el('first').disabled = el('prev').disabled = view.page <= 1;
  el('next').disabled = el('last').disabled = view.page >= pages;
}

/* ---------- toolbar and filter chips ---------- */

function filterColumns() {
  return config.columns.filter((c) => c.filter);
}

function isActive(c) {
  const f = view.filters[c.key];
  if (c.filter === 'select') return f.length > 0;
  if (c.filter === 'text') return f !== '';
  return f.min !== '' || f.max !== '';
}

function facetLabel(c, value) {
  const item = facets[c.key] && facets[c.key].items.find((i) => i.value === value);
  return item ? item.label : value;
}

function chipValue(c) {
  const f = view.filters[c.key];
  if (c.filter === 'select') {
    const labels = f.map((v) => facetLabel(c, v));
    return labels.length > 2 ? labels.slice(0, 2).join(', ') + ' +' + (labels.length - 2) : labels.join(', ');
  }
  if (c.filter === 'text') return 'contains "' + f + '"';
  if (f.min !== '' && f.max !== '') return f.min + ' to ' + f.max;
  return f.min !== '' ? 'from ' + f.min : 'to ' + f.max;
}

function renderChips() {
  const bar = el('chips');
  bar.replaceChildren();
  const active = filterColumns().filter(isActive);
  if (!active.length) {
    const none = document.createElement('span');
    none.className = 'filters-bar-empty';
    none.textContent = 'No filters applied';
    bar.append(none);
    return;
  }
  for (const c of active) {
    const chip = document.createElement('span');
    chip.className = 'filter-chip';
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'filter-chip-edit';
    edit.dataset.act = 'edit';
    edit.dataset.key = c.key;
    const label = document.createElement('span');
    label.className = 'filter-chip-label';
    label.textContent = c.label;
    const value = document.createElement('span');
    value.className = 'filter-chip-value';
    value.textContent = chipValue(c);
    value.title = chipValue(c);
    edit.append(label, value);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'filter-chip-remove';
    remove.dataset.act = 'remove';
    remove.dataset.key = c.key;
    remove.setAttribute('aria-label', 'Remove ' + c.label + ' filter');
    remove.textContent = '×';
    chip.append(edit, remove);
    bar.append(chip);
  }
  const clear = document.createElement('button');
  clear.type = 'button';
  clear.dataset.act = 'clear';
  clear.textContent = 'Clear all';
  bar.append(clear);
}

function syncControls() {
  el('q').value = view.q;
  renderChips();
  for (const th of el('grid').tHead.querySelectorAll('th')) {
    th.removeAttribute('aria-sort');
    if (th.dataset.key === view.sort.col) th.setAttribute('aria-sort', view.sort.dir === 'desc' ? 'descending' : 'ascending');
  }
}

function buildToolbar() {
  const names = config.searchColumns.map((k) => colByKey[k].label.toLowerCase());
  el('q').placeholder = 'Search ' + names.slice(0, 2).join(', ') + (names.length > 2 ? '…' : '');
  el('q').title = 'Searches: ' + names.join(', ');
  el('addfilter').hidden = filterColumns().length === 0;
  const link = el('fulllink');
  if (sourceUrls.length === 1) {
    link.href = sourceUrls[0];
    link.textContent = 'Full dataset (' + config.source.format + ') ↓';
  } else if (config.hfDataset) {
    link.href = 'https://huggingface.co/datasets/' + config.hfDataset + '/tree/main';
    link.textContent = 'Full dataset (Hugging Face) ↗';
  }
  link.hidden = !link.href;
}

/* ---------- filter dialog ---------- */

function buildFilterColumnList() {
  const sel = el('fdcol');
  sel.replaceChildren();
  for (const c of filterColumns()) {
    const o = document.createElement('option');
    o.value = c.key;
    o.textContent = c.label;
    sel.append(o);
  }
}

function drawEditor() {
  const c = colByKey[el('fdcol').value];
  const f = view.filters[c.key];
  const body = el('fdbody');
  body.replaceChildren();
  el('fderr').hidden = true;
  el('fdremove').hidden = !isActive(c);
  if (c.filter === 'select') {
    const narrow = document.createElement('input');
    narrow.type = 'search';
    narrow.id = 'fdnarrow';
    narrow.placeholder = 'Narrow the list';
    narrow.setAttribute('aria-label', 'Narrow the ' + c.label + ' list');
    const opts = document.createElement('div');
    opts.className = 'opts';
    for (const item of facets[c.key].items) {
      const lab = document.createElement('label');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.value = item.value;
      box.checked = f.includes(item.value);
      const name = document.createElement('span');
      name.textContent = item.label;
      const cnt = document.createElement('span');
      cnt.className = 'c';
      cnt.textContent = item.n.toLocaleString();
      lab.append(box, name, cnt);
      opts.append(lab);
    }
    const note = document.createElement('p');
    note.className = 'summary';
    note.textContent = 'Counts cover the whole table.' + (facets[c.key].truncated ? ' Top ' + FACET_LIMIT + ' values shown.' : '');
    body.append(narrow, opts, note);
  } else if (c.filter === 'text') {
    const input = document.createElement('input');
    input.type = 'search';
    input.id = 'fdtext';
    input.placeholder = 'Contains';
    input.setAttribute('aria-label', c.label + ' contains');
    input.value = f;
    body.append(input);
  } else {
    const row = document.createElement('div');
    row.className = 'rangerow';
    const type = c.type === 'date' ? 'date' : 'number';
    const lo = document.createElement('input');
    lo.type = type;
    lo.id = 'fdmin';
    lo.value = f.min;
    lo.setAttribute('aria-label', c.label + ' from');
    const hi = document.createElement('input');
    hi.type = type;
    hi.id = 'fdmax';
    hi.value = f.max;
    hi.setAttribute('aria-label', c.label + ' to');
    row.append(lo, 'to', hi);
    body.append(row);
  }
}

function openFilter(key) {
  el('fdcol').value = key || filterColumns()[0].key;
  drawEditor();
  el('filterdlg').showModal();
}

function applyFilter() {
  const c = colByKey[el('fdcol').value];
  if (c.filter === 'select') {
    view.filters[c.key] = [...el('fdbody').querySelectorAll('.opts input:checked')].map((b) => b.value);
  } else if (c.filter === 'text') {
    view.filters[c.key] = el('fdtext').value.trim();
  } else {
    const range = { min: el('fdmin').value, max: el('fdmax').value };
    for (const end of ['min', 'max']) {
      if (!validBound(c, range[end])) {
        el('fderr').textContent = 'Not a valid ' + c.type + ': ' + range[end];
        el('fderr').hidden = false;
        return;
      }
    }
    view.filters[c.key] = range;
  }
  view.page = 1;
  el('filterdlg').close();
  update(true);
}

function removeFilter(key) {
  const c = colByKey[key];
  view.filters[key] = emptyFilters()[key];
  view.page = 1;
  update(true);
  return c;
}

/* ---------- stats and charts ---------- */

function buildStats() {
  const row = el('stats');
  row.replaceChildren();
  (config.stats || []).forEach((s, i) => {
    const card = document.createElement('div');
    card.className = 'stat-card';
    if (s.hint) card.title = s.hint;
    const h = document.createElement('h3');
    h.textContent = s.label;
    const v = document.createElement('div');
    v.className = 'stat-value';
    v.id = 'stat' + i;
    v.textContent = '--';
    card.append(h, v);
    row.append(card);
  });
}

function statText(v) {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'bigint' || typeof v === 'number') return Number(v).toLocaleString();
  return String(v);
}

async function refreshStats(id, whereSql, params) {
  const specs = config.stats || [];
  if (!specs.length) return;
  const sql = 'SELECT ' + specs.map((s, i) => '(' + s.expr + ') AS s' + i).join(', ') + ' FROM t' + whereSql;
  const rows = await runQuery(sql, params);
  if (id !== latest) return;
  specs.forEach((s, i) => {
    const node = el('stat' + i);
    const text = statText(rows[0]['s' + i]);
    node.textContent = text;
    node.classList.toggle('text', text.length > 12);
  });
}

function chartColors() {
  const css = getComputedStyle(document.documentElement);
  const get = (name) => css.getPropertyValue(name).trim();
  return { bar: get('--chart-bar'), hover: get('--chart-bar-hover'), grid: get('--chart-grid'), tick: get('--chart-tick') };
}

function themeChart(o) {
  const c = chartColors();
  const ds = o.chart.data.datasets[0];
  ds.backgroundColor = c.bar;
  ds.hoverBackgroundColor = c.hover;
  const { x, y } = o.chart.options.scales;
  x.ticks.color = y.ticks.color = c.tick;
  (o.spec.type === 'top' ? x : y).grid.color = c.grid;
  o.chart.update('none');
}

function applyChartThemes() {
  for (const o of charts) themeChart(o);
}

function buildCharts() {
  const host = el('charts');
  host.replaceChildren();
  charts.length = 0;
  const specs = config.charts || [];
  if (!specs.length) return;
  if (typeof Chart === 'undefined') throw new Error('Chart.js did not load.');
  for (const spec of specs) {
    const horizontal = spec.type === 'top';
    const card = document.createElement('div');
    card.className = 'chart-card';
    const h = document.createElement('h3');
    h.textContent = spec.title;
    const box = document.createElement('div');
    box.className = 'chart-box';
    const canvas = document.createElement('canvas');
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', spec.title + ' (the table below the chart has the numbers)');
    box.append(canvas);
    const foot = document.createElement('p');
    foot.className = 'chart-foot';
    const details = document.createElement('details');
    const sum = document.createElement('summary');
    sum.textContent = 'Table';
    const scroll = document.createElement('div');
    scroll.className = 'tablescroll';
    const table = document.createElement('table');
    const tbody = document.createElement('tbody');
    table.append(tbody);
    scroll.append(table);
    details.append(sum, scroll);
    card.append(h, box, foot, details);
    host.append(card);

    const unit = spec.unit || 'rows';
    const valueAxis = { beginAtZero: true, ticks: { precision: 0, callback: (v) => Number(v).toLocaleString() }, grid: {} };
    const labelAxis = { ticks: { autoSkip: true, maxTicksLimit: horizontal ? 50 : 24, maxRotation: 45 }, grid: { display: false } };
    if (horizontal) {
      labelAxis.ticks.callback = function (value) {
        const s = this.getLabelForValue(value);
        const max = Math.max(12, Math.min(34, Math.floor(this.chart.width / 17)));
        return s.length > max ? s.slice(0, max - 1) + '…' : s;
      };
    }
    const chart = new Chart(canvas, {
      type: 'bar',
      data: { labels: [], datasets: [{ label: unit, data: [], borderWidth: 0, borderRadius: 3, maxBarThickness: horizontal ? 18 : 28 }] },
      options: {
        indexAxis: horizontal ? 'y' : 'x',
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 150 },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: '#2A211A',
            titleColor: '#F5EDE0',
            bodyColor: '#F5EDE0',
            borderColor: '#3D2B1F',
            borderWidth: 1,
            callbacks: {
              label: (ctx) => ' ' + Number(horizontal ? ctx.parsed.x : ctx.parsed.y).toLocaleString() + ' ' + unit,
            },
          },
        },
        scales: horizontal ? { x: valueAxis, y: labelAxis } : { x: labelAxis, y: valueAxis },
      },
    });
    const o = { spec, chart, box, foot, tbody };
    charts.push(o);
    themeChart(o);
  }
}

function chartSql(spec, whereSql) {
  const label = 'CAST((' + spec.label + ') AS VARCHAR)';
  const value = 'CAST((' + (spec.value || 'count(*)') + ') AS DOUBLE)';
  const order = spec.type === 'top' ? 'v DESC, l' : 'l';
  return 'SELECT ' + label + ' AS l, ' + value + ' AS v FROM t' + whereSql + ' GROUP BY 1 ORDER BY ' + order + ' LIMIT ' + CHART_GROUP_LIMIT;
}

// Fill in periods with no rows so a gap in the data shows as a gap in the chart.
function fillPeriods(spec, rows) {
  const year = spec.type === 'year';
  const pattern = year ? /^\d{4}$/ : /^\d{4}-\d{2}$/;
  for (const r of rows) {
    if (!pattern.test(r.l)) throw new Error('Chart "' + spec.title + '": label "' + r.l + '" is not ' + (year ? 'YYYY' : 'YYYY-MM') + '.');
  }
  if (!rows.length) return { labels: [], values: [] };
  const byLabel = new Map(rows.map((r) => [r.l, Number(r.v)]));
  const last = rows[rows.length - 1].l;
  let [y, m] = rows[0].l.split('-').map(Number);
  const labels = [];
  for (;;) {
    const label = year ? String(y) : y + '-' + String(m).padStart(2, '0');
    labels.push(label);
    if (label === last) break;
    if (year || m === 12) { y += 1; m = 1; } else { m += 1; }
  }
  return { labels, values: labels.map((l) => byLabel.get(l) || 0) };
}

function drawChart(o, rows) {
  const spec = o.spec;
  const blanks = rows.filter((r) => r.l === null).reduce((n, r) => n + Number(r.v), 0);
  const kept = rows.filter((r) => r.l !== null);
  let labels = [];
  let values = [];
  let foot = '';
  if (spec.type === 'top') {
    const limit = spec.limit || 10;
    labels = kept.slice(0, limit).map((r) => r.l);
    values = kept.slice(0, limit).map((r) => Number(r.v));
    if (kept.length > limit) foot = 'Top ' + limit + ' of ' + kept.length.toLocaleString() + '. ';
  } else {
    ({ labels, values } = fillPeriods(spec, kept));
  }
  if (blanks) foot += blanks.toLocaleString() + ' blank, not shown.';
  if (!labels.length) foot = 'No rows match.';
  o.foot.textContent = foot.trim();
  o.box.style.height = spec.type === 'top' ? Math.max(90, labels.length * 26 + 40) + 'px' : '200px';
  o.chart.data.labels = labels;
  o.chart.data.datasets[0].data = values;
  o.chart.update('none');
  o.chart.resize();
  o.tbody.replaceChildren();
  labels.forEach((l, i) => {
    const tr = document.createElement('tr');
    const a = document.createElement('td');
    a.textContent = l;
    const b = document.createElement('td');
    b.className = 'num';
    b.textContent = values[i].toLocaleString();
    tr.append(a, b);
    o.tbody.append(tr);
  });
}

async function refreshCharts(id, whereSql, params) {
  for (const o of charts) {
    const rows = await runQuery(chartSql(o.spec, whereSql), params);
    if (id !== latest) return;
    drawChart(o, rows);
  }
}

/* ---------- refresh ---------- */

async function refresh() {
  const id = ++latest;
  const { sql, params } = buildWhere();
  const count = await runQuery('SELECT count(*) AS n FROM t' + sql, params);
  if (id !== latest) return;
  total = Number(count[0].n);
  const size = config.pageSize;
  view.page = Math.min(view.page, Math.max(1, Math.ceil(total / size)));
  const rows = await runQuery(
    'SELECT ' + selectList() + ' FROM t' + sql + orderBy() + ' LIMIT ' + size + ' OFFSET ' + (view.page - 1) * size,
    params
  );
  if (id !== latest) return;
  renderGrid(rows);
  renderSummary();
  showNotices();
  await refreshStats(id, sql, params);
  await refreshCharts(id, sql, params);
}

function update(push) {
  writeURL(push);
  syncControls();
  refresh().catch(fail);
}

/* ---------- detail panel ---------- */

async function showDetail(keyValue) {
  const rows = await runQuery('SELECT ' + selectList() + ' FROM t WHERE ' + qi(config.key) + ' = ?', [keyValue]);
  if (!rows.length) {
    notices.push('No row has the key "' + keyValue + '".');
    view.open = null;
    writeURL(false);
    showNotices();
    return;
  }
  const row = rows[0];
  const detail = config.detail || {};
  el('dtitle').textContent = detail.title ? fill(detail.title, row) : String(row[config.key]);

  const links = el('dlinks');
  links.replaceChildren();
  for (const l of detail.links || []) {
    if (l.showIf && String(row[l.showIf.col]) !== l.showIf.equals) continue;
    const href = safeHref(fill(l.href, row));
    if (!href) continue;
    const a = document.createElement('a');
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = l.label;
    links.append(a);
  }

  const body = el('dbody');
  body.replaceChildren();
  for (const c of config.columns) {
    const dt = document.createElement('dt');
    dt.textContent = c.label;
    if (c.help) dt.title = c.help;
    const dd = document.createElement('dd');
    dd.textContent = formatValue(c, row[c.key]) || '—';
    body.append(dt, dd);
  }
  if (!el('detail').open) el('detail').showModal();
}

/* ---------- export ---------- */

function csvField(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

async function exportCsv() {
  const { sql, params } = buildWhere();
  const count = await runQuery('SELECT count(*) AS n FROM t' + sql, params);
  const n = Number(count[0].n);
  if (n > EXPORT_LIMIT) {
    setStatus(n.toLocaleString() + ' rows is over the ' + EXPORT_LIMIT.toLocaleString() + ' export limit. Filter first.', 'warn');
    return;
  }
  const rows = await runQuery('SELECT ' + selectList() + ' FROM t' + sql + orderBy(), params);
  const lines = [config.columns.map((c) => csvField(c.key)).join(',')];
  for (const r of rows) lines.push(config.columns.map((c) => csvField(r[c.key])).join(','));
  const url = URL.createObjectURL(new Blob([lines.join('\r\n') + '\r\n'], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = config.id + '-filtered.csv';
  a.click();
  URL.revokeObjectURL(url);
  setStatus('Downloaded ' + n.toLocaleString() + ' rows. Open as text to keep leading zeros.', '');
}

/* ---------- as-of line ---------- */

async function showAsOf() {
  if (!config.hfDataset) return;
  try {
    const info = await fetchJSON('https://huggingface.co/api/datasets/' + config.hfDataset);
    el('asof').textContent = 'Updated ' + info.lastModified.slice(0, 10);
  } catch (e) {
    console.error(e);
    el('asof').textContent = 'Update date unavailable';
  }
}

/* ---------- events (bound once) ---------- */

function wire() {
  el('q').addEventListener('input', (e) => {
    view.q = e.target.value.trim();
    view.page = 1;
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => update(false), 250);
  });

  el('addfilter').addEventListener('click', () => openFilter(null));
  el('chips').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    if (b.dataset.act === 'edit') openFilter(b.dataset.key);
    if (b.dataset.act === 'remove') removeFilter(b.dataset.key);
    if (b.dataset.act === 'clear') {
      view.q = '';
      view.filters = emptyFilters();
      view.page = 1;
      update(true);
    }
  });
  el('fdcol').addEventListener('change', drawEditor);
  el('fdbody').addEventListener('input', (e) => {
    if (e.target.id !== 'fdnarrow') return;
    const needle = e.target.value.toLowerCase();
    for (const lab of el('fdbody').querySelectorAll('.opts label')) lab.hidden = !lab.textContent.toLowerCase().includes(needle);
  });
  el('fdapply').addEventListener('click', applyFilter);
  el('fdcancel').addEventListener('click', () => el('filterdlg').close());
  el('fdremove').addEventListener('click', () => {
    el('filterdlg').close();
    removeFilter(el('fdcol').value);
  });

  el('grid').tHead.addEventListener('click', (e) => {
    const th = e.target.closest('th');
    if (!th) return;
    view.sort = { col: th.dataset.key, dir: view.sort.col === th.dataset.key && view.sort.dir === 'asc' ? 'desc' : 'asc' };
    view.page = 1;
    update(true);
  });

  el('grid').tBodies[0].addEventListener('click', (e) => {
    if (e.target.closest('a')) return;
    const tr = e.target.closest('tr');
    if (!tr) return;
    view.open = tr.dataset.key;
    writeURL(true);
    showDetail(view.open).catch(fail);
  });

  el('first').addEventListener('click', () => { view.page = 1; update(true); });
  el('prev').addEventListener('click', () => { view.page -= 1; update(true); });
  el('next').addEventListener('click', () => { view.page += 1; update(true); });
  el('last').addEventListener('click', () => { view.page = Math.ceil(total / config.pageSize); update(true); });

  el('copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      setStatus('Link copied.', '');
    } catch (e) {
      setStatus('Could not copy. The address bar has the link.', 'warn');
    }
  });
  el('csv').addEventListener('click', () => exportCsv().catch(fail));

  el('dclose').addEventListener('click', () => el('detail').close());
  el('detail').addEventListener('close', () => {
    if (!view.open) return;
    view.open = null;
    writeURL(false);
  });

  window.addEventListener('popstate', () => {
    if (!config) return;
    readURL();
    syncControls();
    refresh().catch(fail);
    if (view.open) showDetail(view.open).catch(fail);
    else if (el('detail').open) el('detail').close();
  });

  el('theme').addEventListener('click', () => {
    const root = document.documentElement;
    const dark = (root.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')) === 'dark';
    root.dataset.theme = dark ? 'light' : 'dark';
    try {
      localStorage.setItem('theme', root.dataset.theme);
    } catch (e) {
      console.warn('Could not remember the theme choice', e);
    }
    applyChartThemes();
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyChartThemes);
}

/* ---------- start ---------- */

function findEntry(index, id) {
  const want = String(id || '').trim().toLowerCase();
  return index.find((d) => d.id === want || (d.aliases || []).includes(want));
}

function renderNav(index, current) {
  const nav = el('nav');
  nav.replaceChildren('Datasets: ');
  index.forEach((d, i) => {
    if (i) {
      const sep = document.createElement('span');
      sep.className = 'sep';
      sep.textContent = '·';
      nav.append(sep);
    }
    if (d.id === current) {
      const here = document.createElement('span');
      here.setAttribute('aria-current', 'page');
      here.textContent = d.title;
      nav.append(here);
      return;
    }
    const a = document.createElement('a');
    a.href = '?d=' + d.id;
    a.textContent = d.title;
    nav.append(a);
  });
}

function renderHome(index) {
  const list = el('home-list');
  list.replaceChildren();
  for (const d of index) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = '?d=' + d.id;
    a.textContent = d.title;
    const p = document.createElement('p');
    p.textContent = d.blurb;
    li.append(a, p);
    list.append(li);
  }
  el('home').hidden = false;
}

function renderHeader() {
  document.title = config.title;
  el('title').textContent = config.title;
  el('blurb').textContent = config.blurb || '';
  el('covers').textContent = config.covers;
  for (const text of config.caveats || []) {
    const li = document.createElement('li');
    li.textContent = text;
    el('caveats').append(li);
  }
  for (const l of config.links || []) {
    const a = document.createElement('a');
    a.href = l.href;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = l.label;
    el('links').append(a);
  }
  el('explorer').hidden = false;
}

async function start() {
  try {
    const saved = localStorage.getItem('theme');
    if (saved === 'light' || saved === 'dark') document.documentElement.dataset.theme = saved;
  } catch (e) {
    console.warn('Could not read the saved theme', e);
  }
  wire();

  const asked = new URLSearchParams(location.search).get('d');
  const index = await fetchJSON('configs/index.json');
  const entry = asked ? findEntry(index, asked) : null;
  renderNav(index, entry ? entry.id : null);
  if (!entry) {
    renderHome(index);
    if (asked) setStatus('No dataset called "' + asked + '". Pick one below.', 'error');
    return;
  }
  if (entry.id !== asked) {
    const p = new URLSearchParams(location.search);
    p.set('d', entry.id);
    history.replaceState(null, '', location.pathname + '?' + p);
  }
  config = await fetchJSON('configs/' + entry.id + '.json');
  checkConfig(config);
  renderHeader();

  const t0 = performance.now();
  busy('Starting the database engine…');
  await startDuckDB();
  busy('Opening the table…');
  await createView();
  busy('Reading filter values…');
  await loadFacets();
  readURL();
  buildToolbar();
  buildFilterColumnList();
  buildTableHead();
  buildStats();
  buildCharts();
  syncControls();
  el('controls').hidden = false;
  clearInterval(ticker);
  setStatus('');
  await refresh();
  console.info('opened ' + config.id + ' in ' + ((performance.now() - t0) / 1000).toFixed(1) + ' s');
  await showAsOf();
  if (view.open) await showDetail(view.open);
}

start().catch(fail);
