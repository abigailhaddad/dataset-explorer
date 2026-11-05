/* Dataset Explorer. One page, one JSON config per dataset (configs/<id>.json).
 *
 * DuckDB-WASM reads the Parquet/CSV straight from its HTTPS URL (Hugging Face
 * "resolve" links), so the page never holds a copy and shows whatever is
 * published now. Every row you see comes from a SQL query against a view
 * called `t` that is built from the config's column list.
 *
 * State has one owner: `view` (search, filters, sort, page, open row). The URL
 * is written from it (writeURL) and read back into it (readURL). Controls are
 * drawn from it (syncControls). Nothing else keeps a copy.
 *
 * URL: ?d=<dataset>&q=<search>&f.<col>=<value> (repeat for several values)
 *      &f.<col>.min= &f.<col>.max= &sort=<col>&dir=asc|desc&page=<n>&open=<key>
 *
 * Config shape is documented in README.md.
 */
import * as duckdb from 'https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.29.0/+esm';

const BLANK = '__blank__';
const EXPORT_LIMIT = 250000;
const FACET_LIMIT = 500;

const el = (id) => document.getElementById(id);
const qi = (name) => '"' + name.replace(/"/g, '""') + '"';

// Set once while starting; read-only afterwards.
let config = null;
let db = null;
let conn = null;
const facets = {}; // column key -> [{ value, label, n }]
const colByKey = {};

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
  ticker = setInterval(() => setStatus(msg + ' (' + Math.round((performance.now() - t0) / 1000) + ' s)', '', true), 1000);
}

function fail(err) {
  clearInterval(ticker);
  console.error(err);
  const text = String(err && err.message ? err.message : err);
  const throttled = /429|too many requests/i.test(text);
  setStatus(
    (throttled
      ? 'Hugging Face is limiting requests right now. Wait a minute, then reload. '
      : 'Something went wrong: ') + text,
    'error'
  );
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
  if (!Array.isArray(c.source.urls) || !c.source.urls.length) bad('source.urls must be a list');
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

async function createView() {
  const ext = config.source.format;
  const names = [];
  for (let i = 0; i < config.source.urls.length; i++) {
    const name = 'src' + i + '.' + ext;
    await db.registerFileURL(name, config.source.urls[i], duckdb.DuckDBDataProtocol.HTTP, false);
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
    throw new Error('Could not read the data file at ' + config.source.urls[0] + ' (' + e.message + '). The file may have moved or been renamed, or Hugging Face may be limiting requests.');
  }
  const missing = config.columns.filter((c) => !c.expr && !found.has(c.key)).map((c) => c.key);
  if (missing.length) throw new Error('The file has no column(s) named: ' + missing.join(', ') + '. Check the config against the dataset.');

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
        else notices.push('Ignored "' + v + '" in the link: not a valid ' + c.type + ' for ' + c.label + '.');
      }
    }
  }
  for (const name of p.keys()) {
    if (!name.startsWith('f.')) continue;
    const key = name.slice(2).replace(/\.(min|max)$/, '');
    if (!colByKey[key] || !colByKey[key].filter) notices.push('Ignored unknown filter "' + name + '" in the link.');
  }
  const ds = config.defaultSort || {};
  let col = p.get('sort') || ds.col || null;
  if (col && !colByKey[col]) {
    notices.push('Ignored unknown sort column "' + col + '" in the link.');
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

/* ---------- drawing ---------- */

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

function buildControls() {
  el('q').placeholder = 'Search ' + config.searchColumns.map((k) => colByKey[k].label.toLowerCase()).join(', ');

  const bar = el('filters');
  bar.replaceChildren();
  for (const c of config.columns.filter((x) => x.filter)) {
    if (c.filter === 'select') {
      const d = document.createElement('details');
      d.className = 'filter';
      d.dataset.key = c.key;
      const s = document.createElement('summary');
      s.append(c.label + ' ');
      const n = document.createElement('span');
      n.className = 'n';
      s.append(n);
      const panel = document.createElement('div');
      panel.className = 'panel';
      const narrow = document.createElement('input');
      narrow.type = 'search';
      narrow.className = 'narrow';
      narrow.placeholder = 'Narrow this list';
      narrow.setAttribute('aria-label', 'Narrow the ' + c.label + ' list');
      const opts = document.createElement('div');
      opts.className = 'opts';
      for (const item of facets[c.key].items) {
        const lab = document.createElement('label');
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.value = item.value;
        box.dataset.key = c.key;
        const name = document.createElement('span');
        name.textContent = item.label;
        const cnt = document.createElement('span');
        cnt.className = 'c';
        cnt.textContent = item.n.toLocaleString();
        lab.append(box, name, cnt);
        opts.append(lab);
      }
      panel.append(narrow, opts);
      const note0 = document.createElement('p');
      note0.className = 'summary';
      note0.textContent = 'Counts are for the whole table, not the current filters.';
      panel.append(note0);
      if (facets[c.key].truncated) {
        const note = document.createElement('p');
        note.className = 'summary';
        note.textContent = 'Showing the ' + FACET_LIMIT + ' most common values.';
        panel.append(note);
      }
      d.append(s, panel);
      bar.append(d);
    }
    if (c.filter === 'text') {
      const lab = document.createElement('label');
      lab.className = 'filter';
      lab.append(c.label + ' contains');
      const input = document.createElement('input');
      input.type = 'search';
      input.dataset.key = c.key;
      lab.append(input);
      bar.append(lab);
    }
    if (c.filter === 'range') {
      const fs = document.createElement('fieldset');
      fs.className = 'filter';
      fs.dataset.key = c.key;
      const lg = document.createElement('legend');
      lg.textContent = c.label;
      fs.append(lg);
      for (const end of ['min', 'max']) {
        const input = document.createElement('input');
        input.type = c.type === 'date' ? 'date' : 'number';
        input.dataset.key = c.key;
        input.dataset.end = end;
        input.setAttribute('aria-label', c.label + ' ' + (end === 'min' ? 'from' : 'to'));
        fs.append(input);
        if (end === 'min') fs.append('to');
      }
      bar.append(fs);
    }
  }

  const head = el('grid').tHead;
  head.replaceChildren();
  const tr = document.createElement('tr');
  for (const c of shownColumns()) {
    const th = document.createElement('th');
    th.textContent = c.label;
    th.dataset.key = c.key;
    th.tabIndex = 0;
    tr.append(th);
  }
  head.append(tr);
}

function syncControls() {
  el('q').value = view.q;
  for (const c of config.columns.filter((x) => x.filter)) {
    const f = view.filters[c.key];
    if (c.filter === 'select') {
      const d = el('filters').querySelector('details[data-key="' + c.key + '"]');
      for (const box of d.querySelectorAll('input[type="checkbox"]')) box.checked = f.includes(box.value);
      d.querySelector('.n').textContent = f.length ? '(' + f.length + ')' : '';
    }
    if (c.filter === 'text') el('filters').querySelector('label input[data-key="' + c.key + '"]').value = f;
    if (c.filter === 'range') {
      el('filters').querySelector('input[data-key="' + c.key + '"][data-end="min"]').value = f.min;
      el('filters').querySelector('input[data-key="' + c.key + '"][data-end="max"]').value = f.max;
    }
  }
  for (const th of el('grid').tHead.querySelectorAll('th')) {
    th.removeAttribute('aria-sort');
    if (th.dataset.key === view.sort.col) th.setAttribute('aria-sort', view.sort.dir === 'desc' ? 'descending' : 'ascending');
  }
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
    ? 'Showing ' + from.toLocaleString() + ' to ' + to.toLocaleString() + ' of ' + total.toLocaleString() + ' rows.'
    : 'No rows match.';
  el('pageinfo').textContent = 'Page ' + view.page.toLocaleString() + ' of ' + pages.toLocaleString();
  el('first').disabled = el('prev').disabled = view.page <= 1;
  el('next').disabled = el('last').disabled = view.page >= pages;
}

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
    notices.push('No row has the key "' + keyValue + '" (from the link).');
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
    setStatus('That is ' + n.toLocaleString() + ' rows, more than the ' + EXPORT_LIMIT.toLocaleString() + ' the page will export. Filter it down first.', 'warn');
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
  setStatus('Downloaded ' + n.toLocaleString() + ' rows. Open the file as text in a spreadsheet so ID columns keep their leading zeros.', '');
}

/* ---------- as-of line ---------- */

async function showAsOf() {
  const parts = [];
  if (config.asOf) {
    const rows = await runQuery(config.asOf.sql, []);
    parts.push(config.asOf.label.replace('{value}', String(Object.values(rows[0])[0])));
  }
  if (config.hfDataset) {
    try {
      const info = await fetchJSON('https://huggingface.co/api/datasets/' + config.hfDataset);
      parts.push('Hugging Face dataset last changed ' + info.lastModified.slice(0, 10) + '.');
    } catch (e) {
      console.error(e);
      parts.push('Could not read the Hugging Face dataset date.');
    }
  }
  el('asof').textContent = parts.join(' ');
}

/* ---------- events (bound once) ---------- */

function wire() {
  el('q').addEventListener('input', (e) => {
    view.q = e.target.value.trim();
    view.page = 1;
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => update(false), 250);
  });

  el('filters').addEventListener('input', (e) => {
    const t = e.target;
    if (t.classList.contains('narrow')) {
      const needle = t.value.toLowerCase();
      for (const lab of t.closest('.panel').querySelectorAll('.opts label')) {
        lab.hidden = !lab.textContent.toLowerCase().includes(needle);
      }
      return;
    }
    const c = colByKey[t.dataset.key];
    if (c.filter === 'select') {
      view.filters[c.key] = [...t.closest('details').querySelectorAll('input[type="checkbox"]:checked')].map((b) => b.value);
    } else if (c.filter === 'text') {
      view.filters[c.key] = t.value.trim();
    } else {
      view.filters[c.key][t.dataset.end] = t.value;
    }
    view.page = 1;
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => update(false), 250);
  });

  document.addEventListener('click', (e) => {
    for (const d of document.querySelectorAll('details.filter[open]')) {
      if (!d.contains(e.target)) d.open = false;
    }
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

  el('clear').addEventListener('click', () => {
    view.q = '';
    view.filters = emptyFilters();
    view.page = 1;
    update(true);
  });
  el('copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      setStatus('Link copied.', '');
    } catch (e) {
      setStatus('Could not copy automatically. The address bar has the link.', 'warn');
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
  });
}

/* ---------- start ---------- */

function renderNav(index, current) {
  const nav = el('nav');
  for (const d of index) {
    const a = document.createElement('a');
    a.href = '?d=' + d.id;
    a.textContent = d.title;
    if (d.id === current) a.setAttribute('aria-current', 'page');
    nav.append(a);
  }
}

function renderHome(index) {
  const list = el('home-list');
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
  if (matchMedia('(max-width: 640px)').matches) el('about').open = false;
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

  const id = new URLSearchParams(location.search).get('d');
  const index = await fetchJSON('configs/index.json');
  renderNav(index, id);
  if (!id) {
    renderHome(index);
    return;
  }
  if (!index.some((d) => d.id === id)) throw new Error('No dataset called "' + id + '".');
  config = await fetchJSON('configs/' + id + '.json');
  checkConfig(config);
  renderHeader();

  const t0 = performance.now();
  busy('Starting the database engine…');
  await startDuckDB();
  busy('Opening the table from Hugging Face…');
  await createView();
  busy('Reading filter values…');
  await loadFacets();
  readURL();
  buildControls();
  syncControls();
  el('controls').hidden = false;
  clearInterval(ticker);
  await refresh();
  console.info('opened ' + config.id + ' in ' + ((performance.now() - t0) / 1000).toFixed(1) + ' s');
  await showAsOf();
  el('asof').textContent += ' Opened in ' + ((performance.now() - t0) / 1000).toFixed(1) + ' s.';
  if (view.open) await showDetail(view.open);
}

start().catch(fail);
