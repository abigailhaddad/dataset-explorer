/* Dataset Explorer. One page, one JSON config per dataset (configs/<id>.json).
 *
 * DuckDB-WASM reads the Parquet/CSV straight from its HTTPS URL (Hugging Face
 * "resolve" links), so the page never holds a copy and shows whatever is
 * published now. Every number comes from a SQL query against a view called `t`
 * that is built from the config's column list (and optional joined tables).
 *
 * Two kinds of page, one URL space:
 *   list    ?d=<dataset>&v=<view>&q=&f.<col>=&sort=&dir=&page=&size=  (+ pivot: pr pc pm ps pd)
 *   record  ?d=<dataset>&r=<record key>&back=<the list query to return to>
 *
 * State has one owner: `view`. The URL is written from it (writeURL) and read
 * back into it (readState). A record page keeps the list state it came from in
 * `back`, so "Back to results" and previous/next restore it.
 *
 * Views come from config.views (a table view first, then bespoke chart views);
 * a "Pivot & counts" view is added when config.pivot exists. Chart.js is a
 * classic script in index.html and is used as the global `Chart`.
 */
import * as duckdb from 'https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.29.0/+esm';

const BLANK = '__blank__';
const EXPORT_LIMIT = 250000;
const FACET_LIMIT = 500;
const NARROW_MIN = 10; // show the "Narrow the list" box only above this many options
const CHART_GROUP_LIMIT = 20000;
const PAGE_SIZES = [10, 25, 50, 100, 200];
const PHONE_PAGE_SIZE = 10; // a phone shows each row as a tall card, so start with a short page
const PIVOT_ROWS = 200;
const PIVOT_COLS = 12;
const PIVOT_CELL_LIMIT = 200000;

const el = (id) => document.getElementById(id);
const qi = (name) => '"' + name.replace(/"/g, '""') + '"';

// Make one element: h('p', 'cls', 'text').
function h(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

// Set once while starting; read-only afterwards.
let config = null;
let db = null;
let conn = null;
let mainRel = ''; // SQL for the main table's files, before the view `t`
let joinRels = []; // SQL for each joined table
let sourceUrls = [];
const colByKey = {};

// Filled lazily the first time a list page is shown.
let materialized = false;
let facetsLoaded = false;
let listBuilt = false;
const facets = {}; // column key -> { truncated, items: [{ value, label, n }] }

// The one owner of what the user is looking at.
const view = {
  v: null,
  q: '',
  filters: {},
  sort: { col: null, dir: 'asc' },
  page: 1,
  size: 50,
  record: null,
  back: '',
  pivot: { row: '', col: '', measure: 'count', sort: { key: '__total', dir: 'desc' } },
};
let total = 0;
let notices = [];
let latest = 0; // bumped on every refresh so a slow, stale answer is dropped
let typingTimer = null;
let filterTrigger = null;
const charts = []; // { spec, chart, box, foot, table }
let pivotCells = null; // last pivot query: { rows, measure, rowCol, colCol }
let pivotShown = null; // what the pivot table shows, for CSV

/* ---------- messages ---------- */

function setStatus(text, kind, busy) {
  const box = el('status');
  box.replaceChildren();
  if (!text) return;
  const msg = h('div', 'msg ' + (kind || ''), text);
  if (busy) {
    const bar = h('div', 'bar');
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

function checkChart(c, ch, bad) {
  if (!['month', 'year', 'top', 'stack', 'items'].includes(ch.type)) bad('chart type must be month, year, top, stack or items');
  if (!ch.title) bad('each chart needs a title');
  if (ch.type === 'items') {
    if (!Array.isArray(ch.items) || !ch.items.length) bad('chart "' + ch.title + '" needs items');
    for (const it of ch.items) if (!it.label || !it.expr) bad('chart "' + ch.title + '": each item needs a label and an expr');
  } else if (ch.type === 'stack') {
    if (!ch.x || !ch.series) bad('chart "' + ch.title + '" needs x and series expressions');
    if (ch.kind && !['month', 'year', 'category'].includes(ch.kind)) bad('chart "' + ch.title + '": kind must be month, year or category');
  } else if (!ch.label) {
    bad('chart "' + ch.title + '" needs a label expression');
  }
  if (ch.limit !== undefined && !(ch.limit >= 1 && ch.limit <= 50)) bad('chart limit must be 1 to 50');
}

function checkConfig(c) {
  const bad = (msg) => { throw new Error('Config ' + c.id + ': ' + msg); };
  for (const k of ['id', 'title', 'key', 'source', 'columns', 'searchColumns', 'covers', 'record']) {
    if (!c[k]) bad('missing "' + k + '"');
  }
  if (!['parquet', 'csv'].includes(c.source.format)) bad('source.format must be parquet or csv');
  if (c.source.discover) {
    if (!c.source.discover.hfDataset || !c.source.discover.path) bad('source.discover needs hfDataset and path');
  } else if (!Array.isArray(c.source.urls) || !c.source.urls.length) {
    bad('source.urls must be a list');
  }
  if (!(c.pageSize >= 1 && c.pageSize <= 500)) bad('pageSize must be 1 to 500');
  for (const j of c.joins || []) {
    if (!j.id || !j.on || !Array.isArray(j.urls) || !j.urls.length) bad('each join needs id, on and urls');
  }
  for (const col of c.columns) {
    if (!['text', 'number', 'date', 'bool'].includes(col.type)) bad(col.key + ': type must be text, number, date or bool');
    if (col.filter && !['select', 'text', 'range'].includes(col.filter)) bad(col.key + ': unknown filter ' + col.filter);
    if (col.filter === 'range' && !['number', 'date'].includes(col.type)) bad(col.key + ': range needs a number or date column');
    if (col.join && !(c.joins || []).some((j) => j.id === col.join)) bad(col.key + ': unknown join ' + col.join);
    colByKey[col.key] = col;
  }
  if (!colByKey[c.key]) bad('key column ' + c.key + ' is not in columns');
  for (const s of c.searchColumns) {
    if (!colByKey[s] || colByKey[s].type !== 'text') bad('searchColumns: ' + s + ' must be a text column');
  }
  if (c.defaultSort && !colByKey[c.defaultSort.col]) bad('defaultSort column is not in columns');

  // Views: the config's, then the generic pivot view.
  const views = (c.views || []).map((v) => ({ ...v }));
  if (!views.length) bad('missing "views"');
  views[0].table = true;
  const ids = new Set();
  for (const v of views) {
    if (!v.id || !v.label) bad('each view needs an id and a label');
    if (ids.has(v.id)) bad('duplicate view id ' + v.id);
    ids.add(v.id);
    for (const s of v.stats || []) if (!s.label || !s.expr) bad('view ' + v.id + ': each stat needs a label and an expr');
    for (const ch of v.charts || []) checkChart(c, ch, bad);
  }
  if (c.pivot) {
    if (!Array.isArray(c.pivot.columns) || !c.pivot.columns.length) bad('pivot.columns must be a list');
    for (const k of c.pivot.columns) if (!colByKey[k]) bad('pivot column ' + k + ' is not in columns');
    if (!colByKey[c.pivot.default]) bad('pivot.default must be a column');
    for (const m of c.pivot.measures || []) if (!m.id || !m.label || !m.expr) bad('each pivot measure needs id, label and expr');
    views.push({ id: 'pivot', label: 'Pivot & counts', subtitle: 'Count rows by any field.', pivot: true });
  }
  c.viewList = views;

  // Record page.
  const r = c.record;
  if (!colByKey[r.key]) bad('record.key ' + r.key + ' is not a column');
  if (!r.title || !r.sections || !r.sections.length) bad('record needs a title and sections');
  const templates = [...[].concat(r.title), r.subtitle || ''];
  for (const sec of r.sections) {
    for (const k of sec.columns) if (!colByKey[k]) bad('record section ' + sec.title + ': unknown column ' + k);
  }
  for (const t of r.text || []) if (!colByKey[t.column]) bad('record.text: unknown column ' + t.column);
  for (const l of r.links || []) templates.push(l.href);
  for (const rel of r.related || []) {
    for (const k of rel.cols) if (!colByKey[k]) bad('record.related: unknown column ' + k);
    templates.push(rel.title);
    templates.push(rel.sub || '');
  }
  for (const col of c.columns) if (col.link) templates.push(col.link);
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

// The first of several title templates that fills in to something.
function fillFirst(spec, row) {
  for (const t of [].concat(spec)) {
    const s = fill(t, row).trim();
    if (s) return s;
  }
  return '';
}

function safeHref(href) {
  if (!href) return null;
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

async function registerFiles(prefix, urls, ext) {
  const names = [];
  for (let i = 0; i < urls.length; i++) {
    const name = prefix + i + '.' + ext;
    await db.registerFileURL(name, urls[i], duckdb.DuckDBDataProtocol.HTTP, false);
    names.push("'" + name + "'");
  }
  return '[' + names.join(', ') + ']';
}

function readRel(list, format) {
  return format === 'parquet'
    ? 'read_parquet(' + list + ', union_by_name=true)'
    : 'read_csv(' + list + ', header=true, all_varchar=true' + (config.source.csvOptions ? ', ' + config.source.csvOptions : '') + ')';
}

// (Re)define the view `t` over the main relation and the joined tables.
async function defineT(rel) {
  let from = rel + ' AS m';
  (config.joins || []).forEach((j, i) => {
    from += ' LEFT JOIN ' + joinRels[i] + ' AS j' + i + ' ON m.' + qi(j.on) + ' = j' + i + '.' + qi(j.on);
  });
  const exprs = config.columns.map((c) => {
    if (c.expr) return '(' + c.expr + ') AS ' + qi(c.key);
    const ji = c.join ? config.joins.findIndex((j) => j.id === c.join) : -1;
    const src = (ji >= 0 ? 'j' + ji : 'm') + '.' + qi(c.from || c.key);
    if (c.type === 'number') return 'TRY_CAST(' + src + ' AS DOUBLE) AS ' + qi(c.key);
    if (c.type === 'date') return 'TRY_CAST(' + src + ' AS DATE) AS ' + qi(c.key);
    if (c.type === 'bool') return 'TRY_CAST(' + src + ' AS BOOLEAN) AS ' + qi(c.key);
    return 'NULLIF(CAST(' + src + " AS VARCHAR), '') AS " + qi(c.key);
  });
  await conn.query('CREATE OR REPLACE VIEW t AS SELECT ' + exprs.join(', ') + ' FROM ' + from);
}

async function createView() {
  const ext = config.source.format;
  sourceUrls = config.source.discover ? await discoverUrls(config.source.discover) : config.source.urls;
  mainRel = readRel(await registerFiles('src', sourceUrls, ext), ext);
  joinRels = [];
  for (let i = 0; i < (config.joins || []).length; i++) {
    joinRels.push(readRel(await registerFiles('join' + i + '_', config.joins[i].urls, ext), ext));
  }
  let found = null;
  const joinFound = [];
  try {
    found = new Set((await runQuery('DESCRIBE SELECT * FROM ' + mainRel, [])).map((r) => r.column_name));
    for (const rel of joinRels) joinFound.push(new Set((await runQuery('DESCRIBE SELECT * FROM ' + rel, [])).map((r) => r.column_name)));
  } catch (e) {
    throw new Error('Could not read ' + sourceUrls[0] + ' (' + e.message + '). The file may have moved, or Hugging Face is limiting requests.');
  }
  const missing = [];
  for (const c of config.columns) {
    if (c.expr) continue;
    const have = c.join ? joinFound[config.joins.findIndex((j) => j.id === c.join)] : found;
    if (!have.has(c.from || c.key)) missing.push(c.from || c.key);
  }
  if (missing.length) throw new Error('The file has no column named ' + missing.join(', ') + '. Check the config.');
  await defineT(mainRel);
}

// Many small files: read them once into memory instead of re-reading every
// file's footer on every query. A record page does not need this, so it waits
// until a list page is shown.
async function materializeIfNeeded() {
  if (!config.source.materialize || materialized) return;
  busy('Loading the table…');
  await conn.query('CREATE OR REPLACE TABLE raw AS SELECT * FROM ' + mainRel);
  await defineT('raw');
  materialized = true;
}

// Dates come back as text so they print and export as YYYY-MM-DD.
function selectList() {
  return config.columns
    .map((c) => (c.type === 'date' ? 'CAST(' + qi(c.key) + ' AS VARCHAR) AS ' + qi(c.key) : qi(c.key)))
    .join(', ');
}

async function loadFacets() {
  if (facetsLoaded) return;
  for (const c of config.columns.filter((x) => x.filter === 'select')) {
    const rows = await runQuery(
      'SELECT CAST(' + qi(c.key) + ' AS VARCHAR) AS v, count(*) AS n FROM t GROUP BY 1 ORDER BY n DESC, v LIMIT ' + (FACET_LIMIT + 1), []
    );
    const truncated = rows.length > FACET_LIMIT;
    facets[c.key] = {
      truncated,
      items: rows.slice(0, FACET_LIMIT).map((r) => ({
        value: r.v === null ? BLANK : r.v,
        label: r.v === null ? '(blank)' : c.type === 'bool' ? (r.v === 'true' ? 'Yes' : 'No') : c.format === 'code' ? humanCode(r.v, c) : r.v,
        n: Number(r.n),
      })),
    };
  }
  facetsLoaded = true;
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

function pivotDefaults() {
  return { row: config.pivot ? config.pivot.default : '', col: '', measure: 'count', sort: { key: '__total', dir: 'desc' } };
}

// Read the page's URL into `view`. A record page keeps its list state in `back`.
function readState(params) {
  notices = [];
  view.record = params.get('r');
  view.back = view.record !== null ? params.get('back') || '' : '';
  const p = view.record !== null ? new URLSearchParams(view.back) : params;

  const wanted = p.get('v');
  const ids = config.viewList.map((v) => v.id);
  if (wanted && !ids.includes(wanted)) notices.push('Ignored unknown view "' + wanted + '".');
  view.v = wanted && ids.includes(wanted) ? wanted : ids[0];

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
  const size = parseInt(p.get('size') || '', 10);
  const phone = window.matchMedia('(max-width: 640px)').matches;
  view.size = pageSizes().includes(size) ? size : phone ? PHONE_PAGE_SIZE : config.pageSize;

  view.pivot = pivotDefaults();
  if (config.pivot) {
    const row = p.get('pr');
    const col2 = p.get('pc');
    const measure = p.get('pm');
    if (row && config.pivot.columns.includes(row)) view.pivot.row = row;
    if (col2 && config.pivot.columns.includes(col2) && col2 !== view.pivot.row) view.pivot.col = col2;
    if (measure && (config.pivot.measures || []).some((m) => m.id === measure)) view.pivot.measure = measure;
    view.pivot.sort.key = p.get('ps') || '__total';
    view.pivot.sort.dir = p.get('pd') === 'asc' ? 'asc' : p.get('pd') === 'desc' ? 'desc' : view.pivot.sort.key === '__row' ? 'asc' : 'desc';
  }
}

function pageSizes() {
  return PAGE_SIZES.includes(config.pageSize) ? PAGE_SIZES : [...PAGE_SIZES, config.pageSize].sort((a, b) => a - b);
}

// The list state as a query string (no `d`), for the list URL and for `back=`.
function listQuery() {
  const p = new URLSearchParams();
  if (view.v !== config.viewList[0].id) p.set('v', view.v);
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
  if (view.size !== config.pageSize) p.set('size', String(view.size));
  if (view.v === 'pivot') {
    const def = pivotDefaults();
    if (view.pivot.row !== def.row) p.set('pr', view.pivot.row);
    if (view.pivot.col) p.set('pc', view.pivot.col);
    if (view.pivot.measure !== 'count') p.set('pm', view.pivot.measure);
    if (view.pivot.sort.key !== '__total' || view.pivot.sort.dir !== 'desc') {
      p.set('ps', view.pivot.sort.key);
      p.set('pd', view.pivot.sort.dir);
    }
  }
  return p.toString();
}

function listUrl() {
  const s = listQuery();
  return '?d=' + config.id + (s ? '&' + s : '');
}

function recordUrl(key) {
  const s = listQuery();
  return '?d=' + config.id + '&r=' + encodeURIComponent(key) + (s ? '&back=' + encodeURIComponent(s) : '');
}

function writeURL(push) {
  if (push) history.pushState(null, '', listUrl());
  else history.replaceState(null, '', listUrl());
}

function go(href) {
  history.pushState(null, '', href);
  window.scrollTo(0, 0);
  route().catch(fail);
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

// The order clause body, without "ORDER BY": the sort column, then the key.
function orderBody() {
  const key = qi(config.key);
  if (!view.sort.col) return key;
  return qi(view.sort.col) + (view.sort.dir === 'desc' ? ' DESC' : ' ASC') + ' NULLS LAST, ' + key;
}

/* ---------- table ---------- */

// A raw code such as not_stated, shown as plain words. The stored value is unchanged.
function humanCode(v, c) {
  if (c && c.valueLabels && c.valueLabels[v] !== undefined) return c.valueLabels[v];
  const t = String(v).replace(/_/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function formatValue(c, v) {
  if (v === null || v === undefined || v === '') return '';
  if (c.type === 'bool') return v ? 'Yes' : 'No';
  if (c.format === 'code') return humanCode(v, c);
  if (c.type === 'number') {
    const n = Number(v);
    if (c.format === 'currency') return '$' + n.toLocaleString(undefined, { maximumFractionDigits: 0 });
    return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }
  return String(v);
}

function cellNode(c, row) {
  const text = formatValue(c, row[c.key]);
  const span = h('span', 'cell');
  span.title = text;
  const href = c.link && text ? safeHref(fill(c.link, row)) : null;
  if (href) {
    const a = h('a', '', text);
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener';
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
    const th = h('th', '', c.label);
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
  const cols = shownColumns();
  for (const row of rows) {
    const tr = document.createElement('tr');
    tr.dataset.key = row[config.key];
    cols.forEach((c, i) => {
      const td = document.createElement('td');
      td.dataset.label = c.label;
      if (c.type === 'number') td.className = 'num';
      if (row[c.key] === null || row[c.key] === '') td.classList.add('empty');
      if (i === 0 && row[c.key] !== null && row[c.key] !== '') {
        // The first column opens the record page; it is a real link, so it can open in a new tab.
        const a = h('a', 'recordlink', formatValue(c, row[c.key]));
        a.href = recordUrl(row[config.key]);
        a.dataset.soft = '1';
        a.title = 'Open this record';
        const span = h('span', 'cell');
        span.append(a);
        td.append(span);
      } else {
        td.append(cellNode(c, row));
      }
      tr.append(td);
    });
    body.append(tr);
  }
}

function pageItems(page, pages) {
  const keep = new Set([1, pages, page - 1, page, page + 1]);
  const nums = [...keep].filter((n) => n >= 1 && n <= pages).sort((a, b) => a - b);
  const items = [];
  let last = 0;
  for (const n of nums) {
    if (n - last > 1) items.push('…');
    items.push(n);
    last = n;
  }
  return items;
}

function renderPager() {
  const pages = Math.max(1, Math.ceil(total / view.size));
  const box = el('pager');
  box.replaceChildren();
  const add = (label, page, extra) => {
    const b = h('button', extra || '', label);
    b.type = 'button';
    b.dataset.page = String(page);
    box.append(b);
    return b;
  };
  add('First', 1).disabled = view.page <= 1;
  add('Previous', view.page - 1).disabled = view.page <= 1;
  for (const item of pageItems(view.page, pages)) {
    if (item === '…') {
      box.append(h('span', 'gap', '…'));
      continue;
    }
    const b = add(String(item), item, item === view.page ? 'current' : '');
    if (item === view.page) b.setAttribute('aria-current', 'page');
    b.setAttribute('aria-label', 'Page ' + item);
  }
  add('Next', view.page + 1).disabled = view.page >= pages;
  add('Last', pages).disabled = view.page >= pages;
  el('pagesize').value = String(view.size);
}

function renderMatchBar() {
  const bar = el('matchbar');
  bar.replaceChildren();
  const vw = activeView();
  if (vw.table) {
    const from = total ? (view.page - 1) * view.size + 1 : 0;
    const to = Math.min(total, view.page * view.size);
    bar.append(total ? from.toLocaleString() + ' to ' + to.toLocaleString() + ' of ' + total.toLocaleString() + ' rows' : 'No rows match.');
    return;
  }
  bar.append(total.toLocaleString() + (total === 1 ? ' row matches. ' : ' rows match. '));
  const b = h('button', '', 'Show rows');
  b.type = 'button';
  b.dataset.act = 'rows';
  bar.append(b);
}

/* ---------- toolbar, filter chips, filter popover ---------- */

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
    bar.append(h('span', 'filters-bar-empty', 'No filters applied'));
    return;
  }
  for (const c of active) {
    const chip = h('span', 'filter-chip');
    const edit = h('button', 'filter-chip-edit');
    edit.type = 'button';
    edit.dataset.act = 'edit';
    edit.dataset.key = c.key;
    const value = h('span', 'filter-chip-value', chipValue(c));
    value.title = chipValue(c);
    edit.append(h('span', 'filter-chip-label', c.label), value);
    const remove = h('button', 'filter-chip-remove', '×');
    remove.type = 'button';
    remove.dataset.act = 'remove';
    remove.dataset.key = c.key;
    remove.setAttribute('aria-label', 'Remove ' + c.label + ' filter');
    chip.append(edit, remove);
    bar.append(chip);
  }
  const clear = h('button', '', 'Clear all');
  clear.type = 'button';
  clear.dataset.act = 'clear';
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

function buildFilterColumnList() {
  const sel = el('fdcol');
  sel.replaceChildren();
  for (const c of filterColumns()) {
    const o = h('option', '', c.label);
    o.value = c.key;
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
    const narrow = h('input');
    narrow.type = 'search';
    narrow.id = 'fdnarrow';
    narrow.placeholder = 'Narrow the list';
    narrow.setAttribute('aria-label', 'Narrow the ' + c.label + ' list');
    const opts = h('div', 'opts');
    for (const item of facets[c.key].items) {
      const lab = document.createElement('label');
      const box = h('input');
      box.type = 'checkbox';
      box.value = item.value;
      box.checked = f.includes(item.value);
      lab.append(box, h('span', '', item.label), h('span', 'c', item.n.toLocaleString()));
      opts.append(lab);
    }
    const note = h('p', 'summary', 'Counts cover the whole table.' + (facets[c.key].truncated ? ' Top ' + FACET_LIMIT + ' values shown.' : ''));
    // A search box only helps when the list is long enough to need one.
    if (facets[c.key].items.length > NARROW_MIN) body.append(narrow);
    body.append(opts, note);
  } else if (c.filter === 'text') {
    const input = h('input');
    input.type = 'search';
    input.id = 'fdtext';
    input.placeholder = 'Contains';
    input.setAttribute('aria-label', c.label + ' contains');
    input.value = f;
    body.append(input);
  } else {
    const row = h('div', 'rangerow');
    const type = c.type === 'date' ? 'date' : 'number';
    const lo = h('input');
    lo.type = type;
    lo.id = 'fdmin';
    lo.value = f.min;
    lo.setAttribute('aria-label', c.label + ' from');
    const hi = h('input');
    hi.type = type;
    hi.id = 'fdmax';
    hi.value = f.max;
    hi.setAttribute('aria-label', c.label + ' to');
    row.append(lo, 'to', hi);
    body.append(row);
  }
}

function openFilter(key, trigger) {
  filterTrigger = trigger;
  el('fdcol').value = key || filterColumns()[0].key;
  drawEditor();
  el('filterpop').hidden = false;
  el('addfilter').setAttribute('aria-expanded', 'true');
  const first = el('fdbody').querySelector('input') || el('fdcol');
  first.focus();
}

function closeFilter(giveFocusBack) {
  if (el('filterpop').hidden) return;
  el('filterpop').hidden = true;
  el('addfilter').setAttribute('aria-expanded', 'false');
  if (giveFocusBack && filterTrigger && filterTrigger.isConnected) filterTrigger.focus();
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
  closeFilter(true);
  update(true);
}

function removeFilter(key) {
  view.filters[key] = emptyFilters()[key];
  view.page = 1;
  update(true);
}

/* ---------- views (tabs) ---------- */

function activeView() {
  return config.viewList.find((v) => v.id === view.v);
}

function renderTabs() {
  const tabs = el('viewtabs');
  tabs.replaceChildren();
  for (const v of config.viewList) {
    const b = h('button', 'view-tab', v.label);
    b.type = 'button';
    b.setAttribute('role', 'tab');
    b.dataset.view = v.id;
    const on = v.id === view.v;
    b.setAttribute('aria-selected', on ? 'true' : 'false');
    b.tabIndex = on ? 0 : -1;
    tabs.append(b);
  }
  tabs.hidden = config.viewList.length < 2;
}

function setView(id) {
  view.v = id;
  view.page = 1;
  writeURL(true);
  showList().catch(fail);
}

function renderHeading() {
  const vw = activeView();
  const sub = el('blurb');
  sub.replaceChildren(vw.subtitle || config.blurb || '');
  if (vw.experimental) sub.append(' ', h('span', 'badge', 'Experimental'));
}

/* ---------- stats and charts ---------- */

function fmtNumber(spec, n) {
  const v = Number(n);
  if (spec.format === 'currency') return '$' + v.toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (spec.format === 'percent') return v.toLocaleString(undefined, { maximumFractionDigits: 1 }) + '%';
  return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function buildStats(specs) {
  const row = el('stats');
  row.replaceChildren();
  specs.forEach((s, i) => {
    const card = h('div', 'stat-card');
    if (s.hint) card.title = s.hint;
    const v = h('div', 'stat-value', '--');
    v.id = 'stat' + i;
    card.append(h('h3', '', s.label), v);
    row.append(card);
  });
}

function statText(spec, v) {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'bigint' || typeof v === 'number') return spec.format ? fmtNumber(spec, v) : Number(v).toLocaleString();
  return String(v);
}

async function refreshStats(id, specs, whereSql, params) {
  if (!specs.length) return;
  const sql = 'SELECT ' + specs.map((s, i) => '(' + s.expr + ') AS s' + i).join(', ') + ' FROM t' + whereSql;
  const rows = await runQuery(sql, params);
  if (id !== latest) return;
  specs.forEach((s, i) => {
    const node = el('stat' + i);
    const text = statText(s, rows[0]['s' + i]);
    node.textContent = text;
    node.classList.toggle('text', text.length > 12);
  });
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function themeChart(o) {
  const grid = cssVar('--chart-grid');
  const tick = cssVar('--chart-tick');
  const { x, y } = o.chart.options.scales;
  x.ticks.color = y.ticks.color = tick;
  const horizontal = o.chart.options.indexAxis === 'y';
  (horizontal ? x : y).grid.color = grid;
  if (o.spec.type === 'stack') {
    o.chart.options.plugins.legend.labels.color = cssVar('--color-text');
    o.chart.data.datasets.forEach((ds) => {
      const other = ds.label === 'Other' || ds.label === '(blank)';
      ds.backgroundColor = other ? cssVar('--series-other') : cssVar('--series-' + (ds.colorSlot + 1));
      ds.borderColor = cssVar('--color-bg');
    });
  } else {
    const ds = o.chart.data.datasets[0];
    ds.backgroundColor = cssVar('--chart-bar');
    ds.hoverBackgroundColor = cssVar('--chart-bar-hover');
  }
  o.chart.update('none');
}

function applyChartThemes() {
  for (const o of charts) themeChart(o);
}

function destroyCharts() {
  for (const o of charts) o.chart.destroy();
  charts.length = 0;
}

function buildCharts(specs) {
  const host = el('charts');
  host.replaceChildren();
  destroyCharts();
  if (!specs.length) return;
  if (typeof Chart === 'undefined') throw new Error('Chart.js did not load.');
  for (const spec of specs) {
    const stack = spec.type === 'stack';
    const timeKind = stack && (spec.kind === 'month' || spec.kind === 'year');
    const horizontal = spec.type === 'top' || spec.type === 'items' || (stack && !timeKind);
    const card = h('div', 'chart-card');
    const box = h('div', 'chart-box');
    const canvas = document.createElement('canvas');
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', spec.title + ' (the table under the chart has the numbers)');
    box.append(canvas);
    const foot = h('p', 'chart-foot');
    const details = document.createElement('details');
    const scroll = h('div', 'tablescroll');
    const table = document.createElement('table');
    scroll.append(table);
    details.append(h('summary', '', 'Table'), scroll);
    card.append(h('h3', '', spec.title), box, foot, details);
    host.append(card);

    const unit = spec.unit || 'rows';
    const valueAxis = {
      beginAtZero: true,
      ticks: { precision: 0, callback: (v) => fmtNumber(spec, v) },
      grid: {},
    };
    const labelAxis = { ticks: { autoSkip: true, maxTicksLimit: horizontal ? 50 : 24, maxRotation: 45 }, grid: { display: false } };
    if (horizontal) {
      labelAxis.ticks.callback = function (value) {
        const s = this.getLabelForValue(value);
        const max = Math.max(12, Math.min(34, Math.floor(this.chart.width / 17)));
        return s.length > max ? s.slice(0, max - 1) + '…' : s;
      };
    }
    if (stack) {
      valueAxis.stacked = true;
      labelAxis.stacked = true;
    }
    const chart = new Chart(canvas, {
      type: 'bar',
      data: { labels: [], datasets: [{ label: unit, data: [], borderWidth: 0, borderRadius: 3, maxBarThickness: horizontal ? 18 : 28, backgroundColor: cssVar('--chart-bar'), hoverBackgroundColor: cssVar('--chart-bar-hover') }] },
      options: {
        indexAxis: horizontal ? 'y' : 'x',
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 150 },
        plugins: {
          legend: { display: stack, position: 'bottom', labels: { boxWidth: 12, boxHeight: 12 } },
          tooltip: {
            backgroundColor: '#2A211A',
            titleColor: '#F5EDE0',
            bodyColor: '#F5EDE0',
            borderColor: '#3D2B1F',
            borderWidth: 1,
            callbacks: {
              label: (ctx) => ' ' + (stack ? ctx.dataset.label + ': ' : '') + fmtNumber(spec, horizontal ? ctx.parsed.x : ctx.parsed.y) + (spec.format ? '' : ' ' + unit),
            },
          },
        },
        scales: horizontal ? { x: valueAxis, y: labelAxis } : { x: labelAxis, y: valueAxis },
      },
    });
    const o = { spec, chart, box, foot, table };
    charts.push(o);
    themeChart(o);
  }
}

// A chart may add its own condition (spec.where) to the page's filters.
function andWhere(spec, whereSql) {
  if (!spec.where) return whereSql;
  return (whereSql ? whereSql + ' AND ' : ' WHERE ') + '(' + spec.where + ')';
}

function groupSql(spec, whereSql) {
  const label = 'CAST((' + spec.label + ') AS VARCHAR)';
  const value = 'CAST((' + (spec.value || 'count(*)') + ') AS DOUBLE)';
  const order = spec.type === 'top' ? 'v DESC, l' : 'l';
  const having = spec.min ? ' HAVING count(*) >= ' + Number(spec.min) : '';
  return 'SELECT ' + label + ' AS l, ' + value + ' AS v FROM t' + andWhere(spec, whereSql) + ' GROUP BY 1' + having + ' ORDER BY ' + order + ' LIMIT ' + CHART_GROUP_LIMIT;
}

function stackSql(spec, whereSql) {
  const x = 'CAST((' + spec.x + ') AS VARCHAR)';
  const s = 'CAST((' + spec.series + ') AS VARCHAR)';
  const value = 'CAST((' + (spec.value || 'count(*)') + ') AS DOUBLE)';
  return 'SELECT ' + x + ' AS x, ' + s + ' AS s, ' + value + ' AS v FROM t' + andWhere(spec, whereSql) + ' GROUP BY 1, 2 LIMIT ' + CHART_GROUP_LIMIT;
}

function itemsSql(spec, whereSql) {
  return 'SELECT ' + spec.items.map((it, i) => 'CAST((' + it.expr + ') AS DOUBLE) AS i' + i).join(', ') + ' FROM t' + andWhere(spec, whereSql);
}

// Fill in periods with no rows so a gap in the data shows as a gap in the chart.
function fillPeriods(kind, title, labelsIn) {
  const year = kind === 'year';
  const pattern = year ? /^\d{4}$/ : /^\d{4}-\d{2}$/;
  for (const l of labelsIn) {
    if (!pattern.test(l)) throw new Error('Chart "' + title + '": label "' + l + '" is not ' + (year ? 'YYYY' : 'YYYY-MM') + '.');
  }
  if (!labelsIn.length) return [];
  const sorted = [...labelsIn].sort();
  const last = sorted[sorted.length - 1];
  let [y, m] = sorted[0].split('-').map(Number);
  const labels = [];
  for (;;) {
    const label = year ? String(y) : y + '-' + String(m).padStart(2, '0');
    labels.push(label);
    if (label === last) break;
    if (year || m === 12) { y += 1; m = 1; } else { m += 1; }
  }
  return labels;
}

// A chart's numbers as a small table under it.
function fillChartTable(o, headers, rows) {
  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  for (const t of headers) hr.append(h('th', '', t));
  thead.append(hr);
  const tbody = document.createElement('tbody');
  for (const r of rows) {
    const tr = document.createElement('tr');
    r.forEach((cell, i) => tr.append(h('td', i ? 'num' : '', cell)));
    tbody.append(tr);
  }
  o.table.replaceChildren(thead, tbody);
}

function drawGroupChart(o, rows) {
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
    labels = fillPeriods(spec.type, spec.title, kept.map((r) => r.l));
    const byLabel = new Map(kept.map((r) => [r.l, Number(r.v)]));
    values = labels.map((l) => byLabel.get(l) || 0);
  }
  if (blanks) foot += fmtNumber(spec, blanks) + ' blank, not shown.';
  if (!labels.length) foot = 'No rows match.';
  o.foot.textContent = foot.trim();
  o.box.style.height = spec.type === 'top' ? Math.max(90, labels.length * 26 + 40) + 'px' : '200px';
  o.chart.data.labels = labels;
  o.chart.data.datasets[0].data = values;
  themeChart(o); // sets the bar colors, then redraws
  o.chart.resize();
  fillChartTable(o, ['', spec.unit || 'rows'], labels.map((l, i) => [l, fmtNumber(spec, values[i])]));
}

function drawItemsChart(o, row) {
  const spec = o.spec;
  const labels = spec.items.map((it) => it.label);
  const values = spec.items.map((it, i) => (row['i' + i] === null ? 0 : Number(row['i' + i])));
  o.foot.textContent = spec.note || '';
  o.box.style.height = Math.max(90, labels.length * 26 + 40) + 'px';
  o.chart.data.labels = labels;
  o.chart.data.datasets[0].data = values;
  themeChart(o); // sets the bar colors, then redraws
  o.chart.resize();
  fillChartTable(o, ['', spec.unit || 'rows'], labels.map((l, i) => [l, fmtNumber(spec, values[i])]));
}

function drawStackChart(o, rows) {
  const spec = o.spec;
  const timeKind = spec.kind === 'month' || spec.kind === 'year';
  const blanks = rows.filter((r) => r.x === null).reduce((n, r) => n + Number(r.v), 0);
  const kept = rows.filter((r) => r.x !== null);

  const seriesTotals = new Map();
  for (const r of kept) {
    const s = r.s === null ? '(blank)' : r.s;
    seriesTotals.set(s, (seriesTotals.get(s) || 0) + Number(r.v));
  }
  // With spec.seriesOrder the colors belong to the names, so a filter does not
  // repaint the series that are left. Without it, the biggest series come first.
  const ranked = [...seriesTotals.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map((e) => e[0]);
  const limitS = spec.seriesLimit || 5;
  const fixed = spec.seriesOrder || null;
  const shown = fixed ? fixed.filter((n) => seriesTotals.has(n)) : ranked.slice(0, limitS);
  const folded = ranked.some((n) => !shown.includes(n));
  const names = folded ? [...shown, 'Other'] : shown;

  const cell = new Map();
  const xTotals = new Map();
  for (const r of kept) {
    const s = r.s === null ? '(blank)' : r.s;
    const name = shown.includes(s) ? s : 'Other';
    const k = r.x + '\u0000' + name;
    cell.set(k, (cell.get(k) || 0) + Number(r.v));
    xTotals.set(r.x, (xTotals.get(r.x) || 0) + Number(r.v));
  }
  let xs = [];
  let foot = '';
  if (timeKind) {
    xs = fillPeriods(spec.kind, spec.title, [...xTotals.keys()]);
  } else {
    const order = [...xTotals.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map((e) => e[0]);
    const limit = spec.limit || 10;
    xs = order.slice(0, limit);
    if (order.length > limit) foot = 'Top ' + limit + ' of ' + order.length.toLocaleString() + '. ';
  }
  if (folded) foot += 'Smaller groups are under Other. ';
  if (spec.note) foot += spec.note + ' ';
  if (blanks) foot += fmtNumber(spec, blanks) + ' blank, not shown.';
  if (!xs.length) foot = 'No rows match.';
  o.foot.textContent = foot.trim();
  o.box.style.height = timeKind ? '260px' : Math.max(120, xs.length * 28 + 80) + 'px';

  o.chart.data.labels = xs;
  o.chart.data.datasets = names.map((name, i) => ({
    label: name,
    colorSlot: fixed && fixed.includes(name) ? fixed.indexOf(name) : i,
    data: xs.map((x) => cell.get(x + '\u0000' + name) || 0),
    borderWidth: 2,
    borderRadius: 0,
    maxBarThickness: timeKind ? 28 : 22,
  }));
  themeChart(o);
  o.chart.resize();
  fillChartTable(o, [spec.xLabel || '', ...names, 'Total'], xs.map((x) => [
    x,
    ...names.map((name) => fmtNumber(spec, cell.get(x + '\u0000' + name) || 0)),
    fmtNumber(spec, xTotals.get(x) || 0),
  ]));
}

async function refreshCharts(id, whereSql, params) {
  for (const o of charts) {
    const spec = o.spec;
    if (spec.type === 'items') {
      const rows = await runQuery(itemsSql(spec, whereSql), params);
      if (id !== latest) return;
      drawItemsChart(o, rows[0]);
    } else if (spec.type === 'stack') {
      const rows = await runQuery(stackSql(spec, whereSql), params);
      if (id !== latest) return;
      drawStackChart(o, rows);
    } else {
      const rows = await runQuery(groupSql(spec, whereSql), params);
      if (id !== latest) return;
      drawGroupChart(o, rows);
    }
  }
}

/* ---------- pivot ---------- */

function buildPivotControls() {
  if (!config.pivot) return;
  const row = el('pvrow');
  const col = el('pvcol');
  row.replaceChildren();
  col.replaceChildren(Object.assign(h('option', '', 'None'), { value: '' }));
  for (const k of config.pivot.columns) {
    const label = colByKey[k].label;
    row.append(Object.assign(h('option', '', label), { value: k }));
    col.append(Object.assign(h('option', '', label), { value: k }));
  }
  const m = el('pvmeasure');
  m.replaceChildren(Object.assign(h('option', '', 'Number of rows'), { value: 'count' }));
  for (const x of config.pivot.measures || []) m.append(Object.assign(h('option', '', x.label), { value: x.id }));
}

function syncPivotControls() {
  el('pvrow').value = view.pivot.row;
  el('pvcol').value = view.pivot.col;
  el('pvmeasure').value = view.pivot.measure;
}

function currentMeasure() {
  if (view.pivot.measure === 'count') return { id: 'count', label: 'Rows', expr: 'count(*)' };
  return config.pivot.measures.find((m) => m.id === view.pivot.measure);
}

async function refreshPivot(id, whereSql, params) {
  const p = view.pivot;
  const measure = currentMeasure();
  const sql = 'SELECT CAST(' + qi(p.row) + ' AS VARCHAR) AS r, ' + (p.col ? 'CAST(' + qi(p.col) + ' AS VARCHAR) AS c, ' : '') +
    'CAST((' + measure.expr + ') AS DOUBLE) AS m FROM t' + whereSql + ' GROUP BY ' + (p.col ? '1, 2' : '1') + ' LIMIT ' + (PIVOT_CELL_LIMIT + 1);
  const rows = await runQuery(sql, params);
  if (id !== latest) return;
  if (rows.length > PIVOT_CELL_LIMIT) throw new Error('Too many groups to pivot. Pick fields with fewer values, or add a filter.');
  pivotCells = { rows, measure, rowCol: colByKey[p.row], colCol: p.col ? colByKey[p.col] : null };
  renderPivot();
}

function pivotCellText(measure, v) {
  const n = Number(v);
  if (measure.format === 'currency') return '$' + n.toLocaleString(undefined, { maximumFractionDigits: 0 });
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

// Group names as the rest of the page shows them: Yes/No for true/false, plain words for codes.
function pivotLabel(c, v) {
  if (c.type === 'bool') return v === 'true' ? 'Yes' : v === 'false' ? 'No' : v;
  if (c.format === 'code') return humanCode(v, c);
  return v;
}

function renderPivot() {
  const { rows, measure, rowCol, colCol } = pivotCells;
  const box = el('pvresult');
  const blank = '(blank)';
  const rowTotals = new Map();
  const colTotals = new Map();
  const cell = new Map();
  let grand = 0;
  for (const r of rows) {
    const rl = r.r === null ? blank : pivotLabel(rowCol, r.r);
    const cl = colCol ? (r.c === null ? blank : pivotLabel(colCol, r.c)) : '';
    const v = Number(r.m);
    rowTotals.set(rl, (rowTotals.get(rl) || 0) + v);
    colTotals.set(cl, (colTotals.get(cl) || 0) + v);
    cell.set(rl + '\u0000' + cl, (cell.get(rl + '\u0000' + cl) || 0) + v);
    grand += v;
  }
  // Columns: the biggest few, the rest under Other.
  let colNames = [];
  const otherCols = new Set();
  if (colCol) {
    const rankedCols = [...colTotals.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map((e) => e[0]);
    colNames = rankedCols.slice(0, PIVOT_COLS);
    for (const c of rankedCols.slice(PIVOT_COLS)) otherCols.add(c);
    if (otherCols.size) colNames.push('Other');
  }
  const cellValue = (rl, cn) => {
    if (cn !== 'Other' || !otherCols.size) return cell.get(rl + '\u0000' + cn) || 0;
    let s = 0;
    for (const c of otherCols) s += cell.get(rl + '\u0000' + c) || 0;
    return s;
  };

  // Rows: the biggest PIVOT_ROWS, then the user's sort.
  const rowOrder = [...rowTotals.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const capped = rowOrder.length > PIVOT_ROWS;
  let list = rowOrder.slice(0, PIVOT_ROWS).map((e) => e[0]);
  const sort = view.pivot.sort;
  const sign = sort.dir === 'asc' ? 1 : -1;
  const sortVal = (rl) => {
    if (sort.key === '__total') return rowTotals.get(rl);
    if (colNames.includes(sort.key)) return cellValue(rl, sort.key);
    return rowTotals.get(rl);
  };
  list.sort((a, b) => {
    if (sort.key === '__row') return sign * a.localeCompare(b);
    return sign * (sortVal(a) - sortVal(b)) || a.localeCompare(b);
  });

  let max = 0;
  for (const rl of list) {
    if (colCol) for (const cn of colNames) max = Math.max(max, cellValue(rl, cn));
    else max = Math.max(max, rowTotals.get(rl));
  }
  const heat = (td, v) => {
    if (!max || !v) return;
    const pct = Math.round(6 + 56 * Math.sqrt(v / max));
    td.style.background = 'color-mix(in srgb, var(--color-accent) ' + pct + '%, transparent)';
  };

  const table = h('table', 'pivot-table');
  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  const headCell = (label, key, num) => {
    const th = h('th', num ? 'num' : '', label);
    th.dataset.sort = key;
    th.tabIndex = 0;
    if (sort.key === key) th.setAttribute('aria-sort', sort.dir === 'asc' ? 'ascending' : 'descending');
    hr.append(th);
  };
  headCell(rowCol.label, '__row', false);
  if (colCol) for (const cn of colNames) headCell(cn, cn, true);
  headCell(colCol ? 'Total' : measure.label, '__total', true);
  if (!colCol) hr.append(h('th', 'num', 'Share'));
  thead.append(hr);

  const tbody = document.createElement('tbody');
  const shown = [];
  for (const rl of list) {
    const tr = document.createElement('tr');
    tr.append(h('td', '', rl));
    const line = [rl];
    if (colCol) {
      for (const cn of colNames) {
        const v = cellValue(rl, cn);
        const td = h('td', 'num', v ? pivotCellText(measure, v) : '');
        heat(td, v);
        tr.append(td);
        line.push(v);
      }
    }
    const tv = rowTotals.get(rl);
    const tt = h('td', 'num total', pivotCellText(measure, tv));
    if (!colCol) heat(tt, tv);
    tr.append(tt);
    line.push(tv);
    if (!colCol) {
      const share = grand ? (100 * tv) / grand : 0;
      tr.append(h('td', 'num', share.toLocaleString(undefined, { maximumFractionDigits: 1 }) + '%'));
      line.push(Math.round(share * 10) / 10);
    }
    tbody.append(tr);
    shown.push(line);
  }
  const foot = document.createElement('tfoot');
  const fr = document.createElement('tr');
  fr.append(h('td', '', 'All rows'));
  const allLine = ['All rows'];
  if (colCol) {
    for (const cn of colNames) {
      let s = 0;
      if (cn === 'Other') for (const c of otherCols) s += colTotals.get(c) || 0;
      else s = colTotals.get(cn) || 0;
      fr.append(h('td', 'num', pivotCellText(measure, s)));
      allLine.push(s);
    }
  }
  fr.append(h('td', 'num total', pivotCellText(measure, grand)));
  allLine.push(grand);
  if (!colCol) {
    fr.append(h('td', 'num', '100%'));
    allLine.push(100);
  }
  foot.append(fr);
  shown.push(allLine);
  table.append(thead, tbody, foot);
  box.replaceChildren(table);

  const headers = [rowCol.label, ...(colCol ? colNames : []), colCol ? 'Total' : measure.label, ...(colCol ? [] : ['Share %'])];
  pivotShown = { headers, lines: shown };
  const notes = [];
  if (capped) notes.push('Top ' + PIVOT_ROWS + ' of ' + rowOrder.length.toLocaleString() + ' rows by total. "All rows" counts every row.');
  if (otherCols.size) notes.push('Top ' + PIVOT_COLS + ' of ' + colTotals.size.toLocaleString() + ' columns. The rest are under Other.');
  if (!rows.length) notes.push('No rows match.');
  el('pvnote').textContent = notes.join(' ');
}

function downloadPivot() {
  if (!pivotShown) return;
  const lines = [pivotShown.headers.map(csvField).join(',')];
  for (const l of pivotShown.lines) lines.push(l.map(csvField).join(','));
  const url = URL.createObjectURL(new Blob([lines.join('\r\n') + '\r\n'], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = config.id + '-pivot.csv';
  a.click();
  URL.revokeObjectURL(url);
}

/* ---------- refresh ---------- */

// A list page is ready when data-loading is 0 (the tests wait for it).
async function refresh() {
  const id = ++latest;
  el('listpane').dataset.loading = '1';
  await refreshBody(id);
  if (id === latest) el('listpane').dataset.loading = '0';
}

async function refreshBody(id) {
  const { sql, params } = buildWhere();
  const count = await runQuery('SELECT count(*) AS n FROM t' + sql, params);
  if (id !== latest) return;
  total = Number(count[0].n);
  const vw = activeView();
  if (vw.table) {
    view.page = Math.min(view.page, Math.max(1, Math.ceil(total / view.size)));
    const rows = await runQuery(
      'SELECT ' + selectList() + ' FROM t' + sql + ' ORDER BY ' + orderBody() + ' LIMIT ' + view.size + ' OFFSET ' + (view.page - 1) * view.size,
      params
    );
    if (id !== latest) return;
    renderGrid(rows);
    renderPager();
  }
  renderMatchBar();
  showNotices();
  if (vw.pivot) {
    await refreshPivot(id, sql, params);
    return;
  }
  await refreshStats(id, vw.stats || [], sql, params);
  await refreshCharts(id, sql, params);
}

function update(push) {
  writeURL(push);
  syncControls();
  refresh().catch(fail);
}

/* ---------- list page ---------- */

async function showList() {
  el('recordpane').hidden = true;
  el('listpane').hidden = false;
  if (!listBuilt) {
    await materializeIfNeeded();
    busy('Reading filter values…');
    await loadFacets();
    buildToolbar();
    buildFilterColumnList();
    buildTableHead();
    buildPivotControls();
    el('pagesize').replaceChildren(...pageSizes().map((n) => Object.assign(h('option', '', String(n)), { value: String(n) })));
    listBuilt = true;
    clearInterval(ticker);
  }
  const vw = activeView();
  renderTabs();
  renderHeading();
  el('tablesection').hidden = !vw.table;
  el('pivotsection').hidden = !vw.pivot;
  el('viewpane').hidden = !!vw.pivot;
  if (!vw.pivot) {
    buildStats(vw.stats || []);
    buildCharts(vw.charts || []);
  } else {
    destroyCharts();
    syncPivotControls();
  }
  syncControls();
  setStatus('');
  await refresh();
}

/* ---------- record page ---------- */

async function recordNeighbors(key) {
  if (!view.back) return { prev: null, next: null };
  const { sql, params } = buildWhere();
  const order = orderBody();
  const rows = await runQuery(
    'SELECT p, n FROM (SELECT CAST(' + qi(config.key) + ' AS VARCHAR) AS k, lag(CAST(' + qi(config.key) + ' AS VARCHAR)) OVER (ORDER BY ' + order +
    ') AS p, lead(CAST(' + qi(config.key) + ' AS VARCHAR)) OVER (ORDER BY ' + order + ') AS n FROM t' + sql + ') WHERE k = ?',
    [...params, key]
  );
  return rows.length ? { prev: rows[0].p, next: rows[0].n } : { prev: null, next: null };
}

function copyButton(getText) {
  const b = h('button', 'copy', 'Copy');
  b.type = 'button';
  b.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(getText());
      b.textContent = 'Copied';
    } catch (e) {
      console.error(e);
      b.textContent = 'Could not copy';
    }
    setTimeout(() => { b.textContent = 'Copy'; }, 1500);
  });
  return b;
}

function recordCard(title) {
  const card = h('section', 'rec-card');
  card.append(h('h2', '', title));
  return card;
}

async function showRelated(card, rel, row) {
  const values = rel.cols.map((k) => row[k]);
  if (values.some((v) => v === null || v === undefined || v === '')) return;
  const where = rel.cols.map((k) => 'CAST(' + qi(k) + ' AS VARCHAR) = ?').join(' AND ') + ' AND CAST(' + qi(config.key) + ' AS VARCHAR) <> ?';
  const params = [...values.map(String), String(row[config.key])];
  const count = await runQuery('SELECT count(*) AS n FROM t WHERE ' + where, params);
  const n = Number(count[0].n);
  if (!n) return;
  const limit = rel.limit || 8;
  const rows = await runQuery('SELECT ' + selectList() + ' FROM t WHERE ' + where + ' ORDER BY ' + orderBody() + ' LIMIT ' + limit, params);
  const head = h('h3', '', rel.label + ' (' + n.toLocaleString() + ')');
  const list = h('ul', 'rel-list');
  for (const r of rows) {
    const li = document.createElement('li');
    const a = h('a', '', fill(rel.title, r) || (rel.titleFallback ? fill(rel.titleFallback, r) : '') || String(r[config.key]));
    a.href = recordUrl(r[config.key]);
    a.dataset.soft = '1';
    li.append(a);
    const sub = rel.sub ? fill(rel.sub, r) : '';
    if (sub) li.append(h('span', 'sub', sub));
    list.append(li);
  }
  card.append(head, list);
  if (n > rows.length) card.append(h('p', 'summary', 'Showing ' + rows.length + ' of ' + n.toLocaleString() + '.'));
}

// Optional extra tables for a record (J&A attachments): loaded on request,
// because they are large files.
function moreBlock(spec, row) {
  const card = recordCard(spec.label);
  const out = h('div', 'more-out');
  const btn = h('button', '', spec.button || 'Load');
  btn.type = 'button';
  card.append(h('p', 'summary', spec.hint || ''), btn, out);
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    out.replaceChildren(h('p', 'summary', 'Reading…'));
    try {
      const name = 'more_' + spec.id + '.parquet';
      await db.registerFileURL(name, spec.url, duckdb.DuckDBDataProtocol.HTTP, false);
      const cols = spec.columns.map((c) => qi(c.key)).concat(spec.text ? [qi(spec.text)] : []);
      const rows = await runQuery(
        'SELECT ' + cols.join(', ') + " FROM read_parquet('" + name + "') WHERE CAST(" + qi(spec.where) + ' AS VARCHAR) = ? ORDER BY 1',
        [String(row[spec.value || config.key])]
      );
      out.replaceChildren();
      if (!rows.length) out.append(h('p', 'summary', 'Nothing found.'));
      for (const r of rows) {
        const item = h('div', 'more-item');
        item.append(h('h3', '', String(r[spec.columns[0].key] === null ? '' : r[spec.columns[0].key])));
        const dl = h('dl', 'fields');
        for (const c of spec.columns.slice(1)) {
          const dd = h('dd', r[c.key] === null || r[c.key] === '' ? 'empty' : '', r[c.key] === null || r[c.key] === '' ? '—' : String(r[c.key]));
          dl.append(h('dt', '', c.label), dd);
        }
        item.append(dl);
        if (spec.text && r[spec.text]) {
          const det = document.createElement('details');
          det.append(h('summary', '', 'Extracted text'));
          det.append(h('pre', 'longtext', String(r[spec.text])));
          item.append(det);
        }
        out.append(item);
      }
    } catch (e) {
      console.error(e);
      out.replaceChildren(h('p', 'msg error', 'Could not load: ' + e.message));
      btn.disabled = false;
    }
  });
  return card;
}

async function showRecord() {
  el('listpane').hidden = true;
  el('recordpane').hidden = false;
  el('viewtabs').hidden = true;
  el('blurb').replaceChildren('Record');
  const box = el('recordpane');
  box.replaceChildren();
  const rec = config.record;
  const backHref = '?d=' + config.id + (view.back ? '&' + view.back : '');
  const back = h('a', 'back-link', '← Back to results');
  back.href = backHref;
  back.dataset.soft = '1';

  const key = view.record;
  const found = key
    ? await runQuery('SELECT ' + selectList() + ' FROM t WHERE CAST(' + qi(rec.key) + ' AS VARCHAR) = ? LIMIT 2', [key])
    : [];
  setStatus('');
  if (!found.length) {
    document.title = config.title;
    box.append(back, h('h2', 'rec-missing', key ? 'No record with that key' : 'No record key in the link'));
    if (key) box.append(h('p', 'summary', 'Key: ' + key));
    box.append(h('p', 'summary', 'The record may have been removed, or the link is incomplete.'));
    return;
  }
  const row = found[0];
  const title = fillFirst(rec.title, row) || String(row[rec.key]);
  document.title = title + ' · ' + config.title;

  const nav = h('div', 'rec-nav');
  nav.append(back);
  const sibling = h('span', 'rec-sib');
  nav.append(sibling);
  box.append(nav);
  box.append(h('h2', 'rec-title', title));
  if (rec.subtitle) {
    const sub = fill(rec.subtitle, row).replace(/^[\s·]+|[\s·]+$/g, '');
    if (sub) box.append(h('p', 'site-subtitle', sub));
  }
  if (found.length > 1) box.append(h('p', 'msg warn', 'More than one row has this key. Showing the first.'));

  const grid = h('div', 'rec-grid');
  for (const sec of rec.sections) {
    const card = recordCard(sec.title);
    const dl = h('dl', 'fields');
    for (const k of sec.columns) {
      const c = colByKey[k];
      const text = formatValue(c, row[k]);
      const dt = h('dt', '', c.label);
      if (c.help) dt.title = c.help;
      const dd = h('dd', text ? '' : 'empty');
      const href = c.link && text ? safeHref(fill(c.link, row)) : null;
      if (href) {
        const a = h('a', '', text);
        a.href = href;
        a.target = '_blank';
        a.rel = 'noopener';
        dd.append(a);
      } else {
        dd.textContent = text || '—';
      }
      dl.append(dt, dd);
    }
    card.append(dl);
    grid.append(card);
  }
  const links = [];
  for (const l of rec.links || []) {
    if (l.showIf && l.showIf.equals !== undefined && String(row[l.showIf.col]) !== l.showIf.equals) continue;
    if (l.showIf && l.showIf.min !== undefined && !(Number(row[l.showIf.col]) >= l.showIf.min)) continue;
    const href = safeHref(fill(l.href, row));
    if (href) links.push({ label: l.label, href });
  }
  if (links.length) {
    const card = recordCard('Source');
    const list = h('ul', 'rel-list');
    for (const l of links) {
      const li = document.createElement('li');
      const a = h('a', '', l.label);
      a.href = l.href;
      a.target = '_blank';
      a.rel = 'noopener';
      li.append(a);
      list.append(li);
    }
    card.append(list);
    grid.append(card);
  }
  box.append(grid);

  for (const t of rec.text || []) {
    const card = recordCard(t.label);
    const value = row[t.column];
    if (value === null || value === '') {
      card.append(h('p', 'summary', '—'));
    } else {
      card.querySelector('h2').after(copyButton(() => String(value)));
      card.append(h('pre', 'longtext', String(value)));
    }
    box.append(card);
  }
  for (const m of rec.more || []) {
    // skipWhenZero names a count column: with none, there is nothing to load.
    if (m.skipWhenZero && Number(row[m.skipWhenZero]) === 0) continue;
    box.append(moreBlock(m, row));
  }

  const related = recordCard('Related');
  box.append(related);
  const relBox = related;
  related.hidden = true;
  const neighbors = recordNeighbors(String(row[rec.key]));
  await Promise.all((rec.related || []).map((r) => showRelated(relBox, r, row)));
  related.hidden = related.children.length < 2;

  const nb = await neighbors;
  for (const [label, k] of [['← Previous', nb.prev], ['Next →', nb.next]]) {
    if (!k) continue;
    const a = h('a', '', label);
    a.href = recordUrl(k);
    a.dataset.soft = '1';
    sibling.append(a);
  }
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
  const rows = await runQuery('SELECT ' + selectList() + ' FROM t' + sql + ' ORDER BY ' + orderBody(), params);
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

  el('addfilter').addEventListener('click', () => {
    if (el('filterpop').hidden) openFilter(null, el('addfilter'));
    else closeFilter(true);
  });
  el('chips').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    if (b.dataset.act === 'edit') openFilter(b.dataset.key, b);
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
    let shown = 0;
    for (const lab of el('fdbody').querySelectorAll('.opts label')) {
      lab.hidden = !lab.textContent.toLowerCase().includes(needle);
      if (!lab.hidden) shown += 1;
    }
    const note = el('fdbody').querySelector('p.summary');
    if (note.dataset.base === undefined) note.dataset.base = note.textContent;
    note.textContent = shown === 0 ? 'No values match.' : note.dataset.base;
  });
  el('fdbody').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.tagName === 'INPUT' && e.target.type !== 'checkbox') applyFilter();
  });
  el('filterpop').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeFilter(true);
  });
  el('fdapply').addEventListener('click', applyFilter);
  el('fdcancel').addEventListener('click', () => closeFilter(true));
  el('fdremove').addEventListener('click', () => {
    const key = el('fdcol').value;
    closeFilter(true);
    removeFilter(key);
  });
  document.addEventListener('click', (e) => {
    if (el('filterpop').hidden) return;
    if (e.target.closest('#filterpop, #addfilter, .filter-chip-edit')) return;
    closeFilter(false);
  });

  // Links marked data-soft change the page without reloading the database.
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-soft]');
    if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    go(a.getAttribute('href'));
  });

  el('viewtabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-view]');
    if (b && b.dataset.view !== view.v) setView(b.dataset.view);
  });
  el('viewtabs').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const ids = config.viewList.map((v) => v.id);
    const next = ids[(ids.indexOf(view.v) + (e.key === 'ArrowRight' ? 1 : ids.length - 1)) % ids.length];
    setView(next);
    setTimeout(() => {
      const b = el('viewtabs').querySelector('[aria-selected="true"]');
      if (b) b.focus();
    }, 0);
  });
  el('matchbar').addEventListener('click', (e) => {
    if (e.target.closest('button[data-act="rows"]')) setView(config.viewList[0].id);
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
    if (tr) go(recordUrl(tr.dataset.key));
  });

  el('pager').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-page]');
    if (!b || b.disabled) return;
    view.page = Number(b.dataset.page);
    update(true);
  });
  el('pagesize').addEventListener('change', (e) => {
    view.size = Number(e.target.value);
    view.page = 1;
    update(true);
  });

  for (const id of ['pvrow', 'pvcol', 'pvmeasure']) {
    el(id).addEventListener('change', () => {
      view.pivot.row = el('pvrow').value;
      view.pivot.col = el('pvcol').value === view.pivot.row ? '' : el('pvcol').value;
      view.pivot.measure = el('pvmeasure').value;
      view.pivot.sort = { key: '__total', dir: 'desc' };
      syncPivotControls();
      update(true);
    });
  }
  el('pvresult').addEventListener('click', (e) => {
    const th = e.target.closest('th[data-sort]');
    if (!th) return;
    const key = th.dataset.sort;
    const same = view.pivot.sort.key === key;
    view.pivot.sort = { key, dir: same ? (view.pivot.sort.dir === 'asc' ? 'desc' : 'asc') : key === '__row' ? 'asc' : 'desc' };
    writeURL(false);
    renderPivot();
  });
  el('pvcsv').addEventListener('click', downloadPivot);

  el('copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      setStatus('Link copied.', '');
      const btn = el('copy');
      btn.textContent = 'Copied';
      setTimeout(() => { btn.textContent = 'Copy Link'; }, 1500);
    } catch (e) {
      setStatus('Could not copy. The address bar has the link.', 'warn');
    }
  });
  el('csv').addEventListener('click', () => {
    if (view.v === 'pivot') downloadPivot();
    else exportCsv().catch(fail);
  });

  window.addEventListener('popstate', () => {
    if (config) route().catch(fail);
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

async function route() {
  closeFilter(false);
  readState(new URLSearchParams(location.search));
  if (view.record !== null) await showRecord();
  else await showList();
}

function findEntry(index, id) {
  const want = String(id || '').trim().toLowerCase();
  return index.find((d) => d.id === want || (d.aliases || []).includes(want));
}

function renderNav(index, current) {
  const nav = el('nav');
  nav.replaceChildren('Datasets: ');
  index.forEach((d, i) => {
    if (i) nav.append(h('span', 'sep', '·'));
    if (d.id === current) {
      const here = h('span', '', d.title);
      here.setAttribute('aria-current', 'page');
      nav.append(here);
      return;
    }
    const a = h('a', '', d.title);
    a.href = '?d=' + d.id;
    nav.append(a);
  });
}

function renderHome(index) {
  const list = el('home-list');
  list.replaceChildren();
  for (const d of index) {
    const li = document.createElement('li');
    const a = h('a', '', d.title);
    a.href = '?d=' + d.id;
    li.append(a, h('p', '', d.blurb));
    list.append(li);
  }
  el('home').hidden = false;
}

function renderHeader() {
  document.title = config.title;
  el('title').textContent = config.title;
  el('covers').textContent = config.covers;
  for (const text of config.caveats || []) el('caveats').append(h('li', '', text));
  for (const l of config.links || []) {
    const a = h('a', '', l.label);
    a.href = l.href;
    a.target = '_blank';
    a.rel = 'noopener';
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
  clearInterval(ticker);
  setStatus('');
  await route();
  console.info('opened ' + config.id + ' in ' + ((performance.now() - t0) / 1000).toFixed(1) + ' s');
  await showAsOf();
}

start().catch(fail);
