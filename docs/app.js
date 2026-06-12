/* Frontier AI Research Tracker */
'use strict';

const ORG_META = {
  anthropic: { label: 'Anthropic' },
  openai:    { label: 'OpenAI' },
  deepmind:  { label: 'DeepMind' },
  other:     { label: 'Other' },
};
const PAGE_SIZE = 50;

const KIND_META = { paper: 'Research papers', post: 'Posts & announcements' };

const state = {
  papers: [],
  filtered: [],
  kinds: new Set(['paper']), // default: research papers only
  orgs: new Set(),      // empty = all
  topics: new Set(),    // empty = all
  years: new Set(),     // empty = all
  query: '',
  _terms: [],
  sort: 'featured',
  page: 1,
  view: 'papers',
  charts: {},
  themeMode: 'share', // share-of-corpus interest curves by default
  custom: [],          // user-defined curve phrases
  customSel: new Set(),
  timeline: null, // lazy-loaded entries
};

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const orgColor = (org) => getComputedStyle(document.documentElement).getPropertyValue(`--${org in ORG_META ? org : 'other'}`).trim();

/* ---------------- URL state ---------------- */
function readHash() {
  const h = new URLSearchParams(location.hash.replace(/^#/, ''));
  state.query = h.get('q') || '';
  state.sort = ['featured', 'newest', 'oldest', 'cited', 'match'].includes(h.get('sort')) ? h.get('sort') : 'featured';
  state.page = Math.max(1, parseInt(h.get('page'), 10) || 1);
  state.view = ['analytics', 'timeline'].includes(h.get('view')) ? h.get('view') : 'papers';
  const show = h.get('show');
  state.kinds = show === 'posts' ? new Set(['post']) : show === 'all' ? new Set() : new Set(['paper']);
  state.orgs = new Set((h.get('labs') || '').split(',').filter(Boolean));
  state.topics = new Set((h.get('topics') || '').split('|').filter(Boolean));
  state.years = new Set((h.get('years') || '').split(',').filter(Boolean));
  const curves = (h.get('curves') || '').split('|').map((c) => c.trim()).filter(Boolean);
  if (curves.length) {
    state.custom = [...new Set([...state.custom, ...curves])].slice(0, 12);
    curves.forEach((c) => state.customSel.add(c));
  }
}

let suppressHash = false;
function writeHash() {
  const h = new URLSearchParams();
  if (state.query) h.set('q', state.query);
  if (state.sort !== 'featured') h.set('sort', state.sort);
  if (state.page > 1) h.set('page', String(state.page));
  if (state.view !== 'papers') h.set('view', state.view);
  if (!(state.kinds.size === 1 && state.kinds.has('paper'))) {
    h.set('show', state.kinds.size === 1 && state.kinds.has('post') ? 'posts' : 'all');
  }
  if (state.orgs.size) h.set('labs', [...state.orgs].join(','));
  if (state.topics.size) h.set('topics', [...state.topics].join('|'));
  if (state.years.size) h.set('years', [...state.years].join(','));
  if (state.custom.length) h.set('curves', state.custom.join('|'));
  const str = h.toString().replace(/%2C/g, ',').replace(/%7C/g, '|');
  suppressHash = true;
  history.replaceState(null, '', str ? '#' + str : location.pathname + location.search);
  setTimeout(() => { suppressHash = false; });
}

/* ---------------- data load ---------------- */
async function load() {
  const res = await fetch('data/papers.json');
  const data = await res.json();
  state._v = encodeURIComponent(data.updated || '0'); // cache-bust satellites with the data version
  const [themesRes, blRes] = await Promise.all([
    fetch('data/themes.json?v=' + state._v), fetch('data/field-baseline.json?v=' + state._v)]);
  try { const tj = await themesRes.json(); THEME_NAMES = tj.names || []; TOPIC_LIST = tj.topics || []; } catch (e) { THEME_NAMES = []; TOPIC_LIST = []; }
  try {
    const bl = await blRes.json();
    // smooth with a centered 4-quarter window: OpenAlex year-only dates pile
    // onto Jan 1 and inflate every Q1
    const raw = bl.quarters.map((x) => ({ key: x.y * 4 + x.q, n: x.n || 0 }));
    state.baseline = new Map(raw.map((x, i) => {
      const win = raw.slice(Math.max(0, i - 2), i + 2).map((w) => w.n).filter(Boolean);
      return [x.key, win.length ? win.reduce((a, b) => a + b, 0) / win.length : x.n];
    }));
    state.baselineYearly = new Map();
    for (const x of bl.quarters) {
      state.baselineYearly.set(x.y, (state.baselineYearly.get(x.y) || 0) + (x.n || 0));
    }
  } catch (e) { state.baseline = null; state.baselineYearly = null; }
  state.papers = (data.papers || data).map((p, i) => ({
    ...p,
    id: p.id ?? i,
    date: p.date || '1970-01-01',
    topics: Array.isArray(p.x) ? p.x.map((i) => TOPIC_LIST[i]).filter(Boolean) : (p.topics || []),
    authors: p.authors || [],
    _ts: Date.parse(p.date || '1970-01-01') || 0,
    url: p.url || (p.arxiv_id ? 'https://arxiv.org/abs/' + p.arxiv_id : '#'),
    kind: p.kind === 'post' ? 'post' : 'paper',
    _hay: [p.title, (p.authors || []).join(' '), p.summary, p.abstract, (p.topics || []).join(' '), p.venue]
      .join(' ').toLowerCase(),
  }));
  state.papers.sort((a, b) => b._ts - a._ts);
  computeThemeMasks();

  $('#stat-count').textContent = state.papers.filter((p) => p.kind === 'paper').length.toLocaleString();
  if (data.updated) $('#stat-updated').textContent = ` · updated ${data.updated}`;

  readHash();
  $('#search').value = state.query;
  $('#sort').value = state.sort;
  setView(state.view, false);
  buildFacets();
  applyFilters(false);
}

/* ---------------- facets ---------------- */
function matches(p, { skipOrg = false, skipTopic = false, skipYear = false, skipKind = false } = {}) {
  if (!skipKind && state.kinds.size && !state.kinds.has(p.kind)) return false;
  if (!skipOrg && state.orgs.size && !state.orgs.has(p.org)) return false;
  if (!skipYear && state.years.size && !state.years.has(p.date.slice(0, 4))) return false;
  if (!skipTopic && state.topics.size && !p.topics.some((t) => state.topics.has(t))) return false;
  if (state._terms.length && !state._terms.every((t) => p._hay.includes(t))) return false;
  return true;
}

function buildFacets() {
  // static structure; counts updated in updateFacetCounts()
  const topicSet = new Set(), yearSet = new Set();
  for (const p of state.papers) {
    for (const t of p.topics) topicSet.add(t);
    yearSet.add(p.date.slice(0, 4));
  }
  state._allTopics = [...topicSet];
  state._allYears = [...yearSet].sort();

  $('#type-chips').innerHTML = Object.entries(KIND_META)
    .map(([k, label]) =>
      `<button class="facet-btn kind-facet" data-kind="${k}"><span class="lbl">${label}</span><span class="n" data-n></span></button>`)
    .join('');

  $('#org-chips').innerHTML = Object.entries(ORG_META)
    .map(([k, m]) =>
      `<button class="facet-btn org-facet" data-org="${k}" style="--dot:var(--${k})">
        <span class="dot"></span><span class="lbl">${m.label}</span><span class="n" data-n></span></button>`)
    .join('');

  $('#topic-chips').innerHTML = state._allTopics
    .map((t) => `<button class="facet-btn topic-facet" data-topic="${esc(t)}"><span class="lbl">${esc(t)}</span><span class="n" data-n></span></button>`)
    .join('');

  $('#year-chips').innerHTML = state._allYears
    .map((y) => `<button class="year-btn" data-year="${y}">${y}</button>`)
    .join('');

  document.querySelectorAll('.kind-facet').forEach((b) =>
    b.addEventListener('click', () => { toggle(state.kinds, b.dataset.kind); applyFilters(); }));
  document.querySelectorAll('.org-facet').forEach((b) =>
    b.addEventListener('click', () => { toggle(state.orgs, b.dataset.org); applyFilters(); }));
  document.querySelectorAll('.topic-facet').forEach((b) =>
    b.addEventListener('click', () => { toggle(state.topics, b.dataset.topic); applyFilters(); }));
  document.querySelectorAll('.year-btn').forEach((b) =>
    b.addEventListener('click', () => { toggle(state.years, b.dataset.year); applyFilters(); }));
}

function toggle(set, v) { set.has(v) ? set.delete(v) : set.add(v); }

function updateFacetCounts() {
  const orgCounts = {}, topicCounts = {}, yearCounts = {}, kindCounts = {};
  for (const p of state.papers) {
    if (matches(p, { skipKind: true })) kindCounts[p.kind] = (kindCounts[p.kind] || 0) + 1;
    if (matches(p, { skipOrg: true })) orgCounts[p.org] = (orgCounts[p.org] || 0) + 1;
    if (matches(p, { skipTopic: true })) for (const t of p.topics) topicCounts[t] = (topicCounts[t] || 0) + 1;
    if (matches(p, { skipYear: true })) { const y = p.date.slice(0, 4); yearCounts[y] = (yearCounts[y] || 0) + 1; }
  }
  document.querySelectorAll('.kind-facet').forEach((b) => {
    const n = kindCounts[b.dataset.kind] || 0;
    b.querySelector('[data-n]').textContent = n.toLocaleString();
    b.classList.toggle('zero', !n && !state.kinds.has(b.dataset.kind));
    b.classList.toggle('active', state.kinds.has(b.dataset.kind));
  });
  document.querySelectorAll('.org-facet').forEach((b) => {
    const n = orgCounts[b.dataset.org] || 0;
    b.querySelector('[data-n]').textContent = n.toLocaleString();
    b.classList.toggle('zero', !n && !state.orgs.has(b.dataset.org));
    b.classList.toggle('active', state.orgs.has(b.dataset.org));
  });
  // sort topics by count desc, "Other" pinned last
  const topicBtns = [...document.querySelectorAll('.topic-facet')];
  topicBtns.sort((a, b) =>
    (a.dataset.topic === 'Other') - (b.dataset.topic === 'Other') ||
    (topicCounts[b.dataset.topic] || 0) - (topicCounts[a.dataset.topic] || 0));
  const topicWrap = $('#topic-chips');
  for (const b of topicBtns) {
    const n = topicCounts[b.dataset.topic] || 0;
    b.querySelector('[data-n]').textContent = n.toLocaleString();
    b.classList.toggle('zero', !n && !state.topics.has(b.dataset.topic));
    b.classList.toggle('active', state.topics.has(b.dataset.topic));
    topicWrap.appendChild(b);
  }
  document.querySelectorAll('.year-btn').forEach((b) => {
    const n = yearCounts[b.dataset.year] || 0;
    b.classList.toggle('zero', !n && !state.years.has(b.dataset.year));
    b.classList.toggle('active', state.years.has(b.dataset.year));
    b.title = `${n.toLocaleString()} papers`;
  });
}

/* ---------------- filtering & sorting ---------------- */
function applyFilters(resetPage = true) {
  if (resetPage) state.page = 1;
  const q = state.query.trim().toLowerCase();
  state._terms = q ? q.split(/\s+/).filter(Boolean) : [];

  state.filtered = state.papers.filter((p) => matches(p));

  if (state._terms.length) {
    for (const p of state.filtered) {
      let score = 0;
      const title = p.title.toLowerCase();
      for (const t of state._terms) {
        if (title.includes(t)) score += 5;
        if ((p.summary || '').toLowerCase().includes(t)) score += 2;
        score += 1;
      }
      p._score = score;
    }
  }

  const sort = state.sort === 'match' && !state._terms.length ? 'featured' : state.sort;
  const cmp = {
    featured: (a, b) => (b.importance || 0) - (a.importance || 0) || b._ts - a._ts,
    newest: (a, b) => b._ts - a._ts,
    oldest: (a, b) => a._ts - b._ts,
    cited:  (a, b) => (b.cited_by || 0) - (a.cited_by || 0) || b._ts - a._ts,
    match:  (a, b) => (b._score || 0) - (a._score || 0) || b._ts - a._ts,
  }[sort];
  state.filtered.sort(cmp);

  const kindNonDefault = !(state.kinds.size === 1 && state.kinds.has('paper')) ? 1 : 0;
  const nFilters = state.orgs.size + state.topics.size + state.years.size + (q ? 1 : 0) + kindNonDefault;
  $('#clear-filters').hidden = !nFilters;
  const badge = $('#filter-badge');
  badge.hidden = !nFilters;
  badge.textContent = nFilters;

  updateFacetCounts();
  writeHash();
  renderPage();
  renderReadingGuide();
  if (state.view === 'analytics') renderAnalytics();
  if (state.view === 'timeline') renderTimeline();
}

/* ---------------- paginated list ---------------- */
function monthLabel(date) {
  return new Date(date + 'T12:00:00Z').toLocaleDateString('en-US', { year: 'numeric', month: 'long', timeZone: 'UTC' });
}

function renderPage() {
  const total = state.filtered.length;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (state.page > pages) state.page = pages;
  const start = (state.page - 1) * PAGE_SIZE;
  const slice = state.filtered.slice(start, start + PAGE_SIZE);

  $('#feed-empty').hidden = total > 0;
  $('#result-count').innerHTML = total
    ? `Showing <b>${(start + 1).toLocaleString()}–${(start + slice.length).toLocaleString()}</b> of <b>${total.toLocaleString()}</b> papers`
    : 'No results';

  const list = $('#paper-list');
  list.innerHTML = '';
  const frag = document.createDocumentFragment();
  const groupByMonth = state.sort === 'newest' || state.sort === 'oldest';
  let lastMonth = null;
  for (const p of slice) {
    if (groupByMonth) {
      const m = monthLabel(p.date);
      if (m !== lastMonth) {
        const h = document.createElement('h2');
        h.className = 'month-head';
        h.textContent = m;
        frag.appendChild(h);
        lastMonth = m;
      }
    }
    frag.appendChild(card(p));
  }
  list.appendChild(frag);
  renderPagination(pages);
}

function renderPagination(pages) {
  const el = $('#pagination');
  if (pages <= 1) { el.innerHTML = ''; return; }
  const cur = state.page;
  const windowPages = new Set([1, 2, pages - 1, pages, cur - 1, cur, cur + 1]);
  const items = [];
  let prev = 0;
  for (let p = 1; p <= pages; p++) {
    if (!windowPages.has(p)) continue;
    if (p - prev > 1) items.push('<span class="page-ellipsis">…</span>');
    items.push(`<button class="page-btn${p === cur ? ' current' : ''}" data-page="${p}" ${p === cur ? 'aria-current="page"' : ''}>${p}</button>`);
    prev = p;
  }
  el.innerHTML = `
    <button class="page-btn" data-page="${cur - 1}" ${cur === 1 ? 'disabled' : ''} aria-label="Previous page">‹</button>
    ${items.join('')}
    <button class="page-btn" data-page="${cur + 1}" ${cur === pages ? 'disabled' : ''} aria-label="Next page">›</button>`;
  el.querySelectorAll('.page-btn:not([disabled])').forEach((b) =>
    b.addEventListener('click', () => gotoPage(parseInt(b.dataset.page, 10))));
}

function gotoPage(p) {
  const pages = Math.max(1, Math.ceil(state.filtered.length / PAGE_SIZE));
  p = Math.min(Math.max(1, p), pages);
  if (p === state.page) return;
  state.page = p;
  writeHash();
  renderPage();
  window.scrollTo({ top: 0 });
}

/* ---------------- reading guide ---------------- */
async function loadReading() {
  if (state.reading !== undefined) return state.reading;
  try {
    const res = await fetch('data/reading.json?v=' + (state._v || '0'));
    state.reading = (await res.json()).topics || {};
  } catch (e) { state.reading = {}; }
  return state.reading;
}

async function renderReadingGuide() {
  const el = $('#reading-guide');
  // show only when exactly one topic is selected
  if (state.topics.size !== 1) { el.hidden = true; el.innerHTML = ''; return; }
  const topic = [...state.topics][0];
  const reading = await loadReading();
  if (state.topics.size !== 1 || [...state.topics][0] !== topic) return; // selection raced
  const guide = reading[topic];
  if (!guide || !guide.groups?.length) { el.hidden = true; el.innerHTML = ''; return; }

  const byId = new Map(state.papers.map((p) => [p.id, p]));
  const n = guide.groups.reduce((s, g) => s + g.entries.length, 0);
  el.innerHTML = `
    <details class="guide" open>
      <summary><span class="guide-icon">📖</span> Essential reading — ${esc(topic)} <span class="guide-sub">${n} hand-picked papers, in learning order</span></summary>
      <div class="guide-body">
        ${guide.groups.map((g) => `
          <div class="guide-group">
            <h4>${esc(g.name)}</h4>
            ${g.entries.map((e) => {
              const p = byId.get(e.id);
              if (!p) return '';
              const org = ORG_META[p.org] || ORG_META.other;
              return `<div class="guide-item" style="--org-color:var(--${p.org in ORG_META ? p.org : 'other'})">
                <a class="guide-title" href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.title)}</a>
                <span class="guide-meta"><span class="org-badge">${org.label}</span> ${p.date.slice(0, 4)}${p.sv ? ' · <span class="sv-badge">survey</span>' : ''}${p.cited_by ? ' · ' + p.cited_by.toLocaleString() + ' cites' : ''}</span>
                <p class="guide-note">${esc(e.note)}</p>
              </div>`;
            }).join('')}
          </div>`).join('')}
        <p class="guide-foot">Curated editorially — the canon as an expert would hand it to you, wherever it was written.</p>
      </div>
    </details>`;
  el.hidden = false;
}

/* ---------------- card ---------------- */
function card(p) {
  const el = document.createElement('article');
  el.className = 'card';
  el.style.setProperty('--org-color', `var(--${p.org in ORG_META ? p.org : 'other'})`);

  const authors = p.authors.length
    ? esc(p.authors.slice(0, 6).join(', ')) + (p.authors.length > 6 ? ' et al.' : '')
    : '';
  const date = p.date && p.date !== '1970-01-01'
    ? new Date(p.date + 'T12:00:00Z').toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' })
    : '';
  const cites = p.cited_by ? `<span class="sep">·</span><span class="cites">${p.cited_by.toLocaleString()} citations</span>` : '';
  const venue = p.venue ? `<span class="sep">·</span><span class="venue">${esc(p.venue)}</span>` : '';
  const hasAbstract = p.abstract && p.abstract.length > 40 && p.abstract !== p.summary;

  el.innerHTML = `
    <div class="card-head">
      <a class="card-title" href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.title)}</a>
      ${date ? `<span class="card-date">${date}</span>` : ''}
    </div>
    <div class="card-meta">
      <span class="org-badge" style="--org-color:var(--${p.org in ORG_META ? p.org : 'other'})">${(ORG_META[p.org] || ORG_META.other).label}</span>
      ${p.kind === 'post' ? '<span class="kind-pill">post</span>' : ''}
      ${authors ? `<span class="authors">${authors}</span>` : ''}
      ${venue}${cites}
    </div>
    ${p.summary ? `<p class="card-summary">${esc(p.summary)}${hasAbstract ? '<button class="more-btn">abstract ▾</button>' : ''}</p>` : ''}
    <div class="card-abstract" hidden>${esc(p.abstract || '')}</div>
    <div class="card-tags">
      ${p.topics.map((t) => `<button class="tag" data-topic="${esc(t)}">${esc(t)}</button>`).join('')}
      ${p.arxiv_id ? `<a class="tag" href="https://arxiv.org/abs/${esc(p.arxiv_id)}" target="_blank" rel="noopener">arXiv:${esc(p.arxiv_id)}</a>` : ''}
    </div>`;

  const moreBtn = el.querySelector('.more-btn');
  if (moreBtn) {
    moreBtn.addEventListener('click', () => {
      const ab = el.querySelector('.card-abstract');
      ab.hidden = !ab.hidden;
      moreBtn.textContent = ab.hidden ? 'abstract ▾' : 'abstract ▴';
    });
  }
  el.querySelectorAll('.tag[data-topic]').forEach((tagBtn) =>
    tagBtn.addEventListener('click', () => {
      const t = tagBtn.dataset.topic;
      if (!state.topics.has(t)) { state.topics.add(t); applyFilters(); window.scrollTo({ top: 0 }); }
    }));
  return el;
}

/* ---------------- analytics ---------------- */
function quarterKey(d) {
  const y = d.slice(0, 4), m = +d.slice(5, 7);
  return `${y} Q${Math.ceil(m / 3) || 1}`;
}

function destroyChart(key) {
  if (state.charts[key]) { state.charts[key].destroy(); delete state.charts[key]; }
}

function chartTheme() {
  const css = getComputedStyle(document.documentElement);
  Chart.defaults.color = css.getPropertyValue('--text-dim').trim();
  Chart.defaults.borderColor = css.getPropertyValue('--border-soft').trim();
  Chart.defaults.font.family = 'Inter, sans-serif';
  Chart.defaults.font.size = 11.5;
}

function renderAnalytics() {
  if (typeof Chart === 'undefined') return;
  chartTheme();

  const papers = state.papers.filter((p) => p.kind === 'paper' && matches(p, { skipKind: true }));
  $('#an-count').textContent = papers.length.toLocaleString();
  const orgKeys = Object.keys(ORG_META);

  /* publications over time, stacked by org */
  const quarters = [...new Set(papers.map((p) => quarterKey(p.date)))].sort();
  const byOrgQ = {};
  for (const o of orgKeys) byOrgQ[o] = Object.fromEntries(quarters.map((q) => [q, 0]));
  for (const p of papers) byOrgQ[p.org in ORG_META ? p.org : 'other'][quarterKey(p.date)]++;
  destroyChart('time');
  state.charts.time = new Chart($('#ch-time'), {
    type: 'bar',
    data: {
      labels: quarters,
      datasets: orgKeys
        .filter((o) => papers.some((p) => (p.org in ORG_META ? p.org : 'other') === o))
        .map((o) => ({ label: ORG_META[o].label, data: quarters.map((q) => byOrgQ[o][q]), backgroundColor: orgColor(o), stack: 's' })),
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: { x: { stacked: true, grid: { display: false } }, y: { stacked: true, beginAtZero: true } },
      plugins: { legend: { position: 'top' } },
    },
  });

  /* org share */
  const orgCounts = {};
  for (const p of papers) { const o = p.org in ORG_META ? p.org : 'other'; orgCounts[o] = (orgCounts[o] || 0) + 1; }
  const orgEntries = orgKeys.filter((o) => orgCounts[o]);
  destroyChart('org');
  state.charts.org = new Chart($('#ch-org'), {
    type: 'doughnut',
    data: {
      labels: orgEntries.map((o) => ORG_META[o].label),
      datasets: [{ data: orgEntries.map((o) => orgCounts[o]), backgroundColor: orgEntries.map(orgColor), borderWidth: 0 }],
    },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'right' } }, cutout: '62%' },
  });

  /* topic counts */
  const topicCounts = {};
  for (const p of papers) for (const t of p.topics) topicCounts[t] = (topicCounts[t] || 0) + 1;
  const topTopics = Object.entries(topicCounts).sort((a, b) => b[1] - a[1]).slice(0, 12);
  destroyChart('topics');
  state.charts.topics = new Chart($('#ch-topics'), {
    type: 'bar',
    data: {
      labels: topTopics.map(([t]) => t),
      datasets: [{ data: topTopics.map(([, n]) => n), backgroundColor: orgColor('deepmind') + 'cc', borderRadius: 4 }],
    },
    options: {
      indexAxis: 'y', responsive: true, maintainAspectRatio: false,
      scales: { x: { beginAtZero: true }, y: { grid: { display: false } } },
      plugins: { legend: { display: false } },
    },
  });

  /* what each lab works on: normalized topic mix per lab */
  const TOPIC_PALETTE = ['#2563eb', '#c15f3c', '#0d8a6f', '#b58a2c', '#7c5cc4', '#2b8fa8', '#c2417a', '#5b8a3c', '#8a5a44', '#4a6fa5', '#a8642b', '#5e548e', '#9aa0a6'];
  const labKeys = orgKeys.filter((o) => papers.some((p) => (p.org in ORG_META ? p.org : 'other') === o));
  const allTopics = Object.entries(topicCounts).sort((a, b) => b[1] - a[1]).map(([t]) => t);
  const labTotals = {}, labTopic = {};
  for (const o of labKeys) { labTotals[o] = 0; labTopic[o] = {}; }
  for (const p of papers) {
    const o = p.org in ORG_META ? p.org : 'other';
    labTotals[o]++;
    const t = p.topics[0] || 'Other'; // primary topic only: each bar sums to 100%
    labTopic[o][t] = (labTopic[o][t] || 0) + 1;
  }
  destroyChart('labtopics');
  state.charts.labtopics = new Chart($('#ch-labtopics'), {
    type: 'bar',
    data: {
      labels: labKeys.map((o) => ORG_META[o].label),
      datasets: allTopics.map((t, i) => ({
        label: t,
        data: labKeys.map((o) => labTotals[o] ? +((100 * (labTopic[o][t] || 0)) / labTotals[o]).toFixed(1) : 0),
        backgroundColor: TOPIC_PALETTE[i % TOPIC_PALETTE.length],
        stack: 's',
      })),
    },
    options: {
      indexAxis: 'y', responsive: true, maintainAspectRatio: false,
      scales: {
        x: { stacked: true, beginAtZero: true, ticks: { callback: (v) => v + '%' } },
        y: { stacked: true, grid: { display: false } },
      },
      plugins: {
        legend: { position: 'top', labels: { boxWidth: 12, font: { size: 10.5 } } },
        tooltip: { callbacks: { label: (item) => `${item.dataset.label}: ${item.raw}% (${labTopic[labKeys[item.dataIndex]][item.dataset.label] || 0} papers)` } },
      },
    },
  });

  /* topic trends per year (top 6) */
  const years = [...new Set(papers.map((p) => p.date.slice(0, 4)))].sort();
  const top6 = topTopics.slice(0, 6).map(([t]) => t);
  const palette = ['#2563eb', '#c15f3c', '#0d8a6f', '#b58a2c', '#7c5cc4', '#2b8fa8'];
  destroyChart('trends');
  state.charts.trends = new Chart($('#ch-trends'), {
    type: 'line',
    data: {
      labels: years,
      datasets: top6.map((t, i) => ({
        label: t,
        data: years.map((y) => papers.filter((p) => p.date.startsWith(y) && p.topics.includes(t)).length),
        borderColor: palette[i], backgroundColor: palette[i],
        tension: 0.3, pointRadius: 2.5, borderWidth: 2,
      })),
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: { y: { beginAtZero: true }, x: { grid: { display: false } } },
      plugins: { legend: { position: 'top' } },
    },
  });

  /* top cited list */
  const topCited = [...papers].filter((p) => p.cited_by).sort((a, b) => b.cited_by - a.cited_by).slice(0, 10);
  $('#top-cited').innerHTML = topCited.map((p) =>
    `<li><a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.title)}</a>
      <span class="tc-meta"> — ${(ORG_META[p.org] || ORG_META.other).label}, ${p.date.slice(0, 4)}, ${p.cited_by.toLocaleString()} citations</span></li>`
  ).join('') || '<li class="tc-meta">No citation data in this selection.</li>';

  renderThemes(papers);
}

/* ---------------- research interest curves ---------------- */
let THEME_NAMES = [];
let TOPIC_LIST = [];

/* user-defined interest curves: phrase -> flexible regex over paper text */
function phraseToRegex(phrase) {
  const esc = phrase.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '[\\s-]+');
  return new RegExp('\\b' + esc + '\\b', 'i');
}
function loadCustom() {
  try { return JSON.parse(localStorage.getItem('frt-custom') || '[]').slice(0, 12); } catch (e) { return []; }
}
function saveCustom() {
  try { localStorage.setItem('frt-custom', JSON.stringify(state.custom)); } catch (e) {}
}
/* field-wide curve for a custom phrase: yearly counts across ALL ML papers in
   OpenAlex (millions), normalized per 10k using the same field baseline */
async function fetchFieldCurve(phrase) {
  try {
    const q = '"' + phrase.replace(/"/g, '') + '"';
    const url = 'https://api.openalex.org/works?filter=title_and_abstract.search:' + encodeURIComponent(q) +
      ',concepts.id:C119857082,from_publication_date:2012-01-01&group_by=publication_year&mailto=michaelofengend@gmail.com';
    const res = await fetch(url);
    if (!res.ok) return null;
    const j = await res.json();
    const m = new Map();
    for (const g of j.group_by || []) {
      const y = +g.key;
      const base = state.baselineYearly?.get(y);
      if (y >= 2012 && base) m.set(y, +((10000 * g.count) / base).toFixed(2));
    }
    return m.size ? m : null;
  } catch (e) { return null; }
}

function customSets() {
  // membership cache: one Set of paper ids per custom phrase
  if (!state._customSets) state._customSets = new Map();
  for (const name of [...state._customSets.keys()]) {
    if (!state.custom.includes(name)) state._customSets.delete(name);
  }
  for (const name of state.custom) {
    if (state._customSets.has(name)) continue;
    const re = phraseToRegex(name);
    const set = new Set();
    for (const p of state.papers) if (re.test(p._hay)) set.add(p.id);
    state._customSets.set(name, set);
  }
  return state._customSets;
}
const THEME_PALETTE = ['#2563eb', '#c15f3c', '#0d8a6f', '#b58a2c', '#7c5cc4', '#2b8fa8', '#c2417a', '#5b8a3c', '#8a5a44', '#4a6fa5', '#a8642b', '#5e548e'];
const THEME_DEFAULT = ['Reward hacking', 'Automated auditing', 'Mid-training', 'Subliminal learning', 'Emergent misalignment', 'Evaluation awareness'];

function computeThemeMasks() {
  // masks are precomputed server-side (build-site-data.mjs) as p.th = [lo, hi]
  for (const p of state.papers) {
    p._thLo = (p.th && p.th[0]) || 0;
    p._thHi = (p.th && p.th[1]) || 0;
  }
}
const hasTheme = (p, i) => i < 28 ? (p._thLo & (1 << i)) !== 0 : (p._thHi & (1 << (i - 28))) !== 0;

/* Least-squares Gaussian fit over quarterly counts (grid search over mu, sigma;
   closed-form amplitude). Crucially, mu may lie BEYOND the data window — a
   still-rising theme fits a bell whose peak is in the future instead of being
   forced inside the observed range. w = counts with the partial current quarter
   scaled to a full-quarter rate; ts = fractional-year midpoints. */
function fitBell(w, ts) {
  const N = w.reduce((a, b) => a + b, 0);
  if (N <= 0) return null;
  const nonzeroIdx = w.map((x, i) => (x > 0 ? i : -1)).filter((i) => i >= 0);
  // a 3-parameter bell needs real support: >=4 nonzero quarters spanning >=1.25y
  if (nonzeroIdx.length < 4) return null;
  const span = ts[nonzeroIdx[nonzeroIdx.length - 1]] - ts[nonzeroIdx[0]];
  if (span < 1.25) return null;
  const t0 = ts[0], t1 = ts[ts.length - 1];
  let best = null;
  for (let mu = t0 - 2; mu <= t1 + 4; mu += 0.1) {
    for (let sigma = 0.35; sigma <= 5; sigma += 0.1) {
      let sg = 0, sgg = 0, sse = 0;
      const g = ts.map((t) => Math.exp(-((t - mu) ** 2) / (2 * sigma * sigma)));
      ts.forEach((t, i) => { sg += w[i] * g[i]; sgg += g[i] * g[i]; });
      const A = sgg > 0 ? sg / sgg : 0;
      if (A <= 0) continue;
      ts.forEach((t, i) => { sse += (w[i] - A * g[i]) ** 2; });
      if (!best || sse < best.sse) best = { mu, sigma, A, sse };
    }
  }
  if (!best) return null;
  const { mu, sigma, A, sse } = best;
  const value = (t) => A * Math.exp(-((t - mu) ** 2) / (2 * sigma * sigma));
  const mean = N / ts.length;
  let sst = 0;
  ts.forEach((t, i) => { sst += (w[i] - mean) ** 2; });
  const r2 = sst > 0 ? Math.max(0, 1 - sse / sst) : 0;
  // peak at/abutting the grid edge = growth still looks exponential; peak not identifiable
  const openEnded = mu >= t1 + 3.8;
  return { mu, sigma, value, r2, total: N, openEnded, nonzero: nonzeroIdx.length };
}

/* two-wave (re-discovered) detector on the smoothed series: peak, deep trough,
   second peak; revival fitted on post-trough data only */
function detectWaves(w, ts, rawCounts) {
  const n = w.length;
  if (n < 16) return null;
  const sm = w.map((_, i) => ((w[i - 1] ?? w[i]) + 2 * w[i] + (w[i + 1] ?? w[i])) / 4);
  let p1 = 0;
  for (let i = 0; i < n; i++) if (sm[i] > sm[p1]) p1 = i;
  let p2 = -1;
  for (let i = 0; i < n; i++) {
    if (Math.abs(i - p1) < 10) continue; // >=2.5y apart
    if (p2 === -1 || sm[i] > sm[p2]) p2 = i;
  }
  if (p2 === -1) return null;
  const [a, b] = p1 < p2 ? [p1, p2] : [p2, p1];
  let trough = a;
  for (let i = a; i <= b; i++) if (sm[i] < sm[trough]) trough = i;
  const lower = Math.min(sm[a], sm[b]);
  if (sm[b] < 0.35 * sm[a]) return null; // second peak too small
  if (sm[a] < 0.25 * sm[b]) return null; // "first wave" was just a slow start, not a real wave
  if (sm[trough] > 0.45 * lower) return null;     // no real dormant period
  const mass1 = rawCounts.slice(0, trough).reduce((x, y) => x + y, 0);
  const mass2 = rawCounts.slice(trough).reduce((x, y) => x + y, 0);
  if (mass1 < 8 || mass2 < 8) return null;
  const revivalFit = fitBell(w.slice(trough), ts.slice(trough));
  return { wave1: ts[a], trough: ts[trough], wave2: ts[b], revivalFit, troughIdx: trough };
}

function quarterLabelOf(mu) {
  const y = Math.floor(mu);
  const q = Math.min(4, Math.max(1, Math.floor((mu - y) * 4) + 1));
  return `${y} Q${q}`;
}

function themeStats(papers) {
  const now = new Date();
  const nowYear = now.getUTCFullYear();
  const nowQ = Math.floor(now.getUTCMonth() / 3); // 0..3
  const qStartMs = Date.UTC(nowYear, nowQ * 3, 1);
  const qEndMs = Date.UTC(nowYear, nowQ * 3 + 3, 1);
  const qFrac = Math.min(1, Math.max(0.15, (Date.now() - qStartMs) / (qEndMs - qStartMs)));

  const quarters = [];
  for (let y = 2016; y <= nowYear; y++) {
    for (let q = 0; q < 4; q++) {
      if (y === nowYear && q > nowQ) break;
      quarters.push({ y, q, t: y + (q + 0.5) / 4, label: `${y} Q${q + 1}` });
    }
  }
  const nowT = quarters[quarters.length - 1].t;
  const idxOf = (p) => {
    const y = +p.date.slice(0, 4), q = Math.floor((+p.date.slice(5, 7) - 1) / 3);
    const idx = (y - 2016) * 4 + q;
    return y >= 2016 && idx < quarters.length ? idx : -1;
  };

  // per-quarter corpus totals (for share-of-corpus normalization)
  const totals = new Array(quarters.length).fill(0);
  for (const p of papers) { const idx = idxOf(p); if (idx >= 0) totals[idx]++; }
  const share = state.themeMode !== 'abs';

  const csets = customSets();
  const defs = [
    ...THEME_NAMES.map((name, i) => ({ name, i, custom: false })),
    ...state.custom.map((name, k) => ({ name, i: 1000 + k, custom: true, set: csets.get(name) })),
  ];
  return defs.map(({ name, i, custom, set }) => {
    const raw = new Array(quarters.length).fill(0);
    for (const p of papers) {
      if (custom ? !set.has(p.id) : !hasTheme(p, i)) continue;
      const idx = idxOf(p);
      if (idx >= 0) raw[idx]++;
    }
    const total = raw.reduce((a, b) => a + b, 0);
    // displayed/fitted series: % of corpus (ratios cancel the partial quarter)
    // or absolute counts (current quarter scaled to a full-quarter rate)
    let counts, w;
    if (share) {
      counts = raw.map((c, idx) => {
        const qq = quarters[idx];
        const base = state.baseline?.get(qq.y * 4 + qq.q) || totals[idx];
        return base ? +((10000 * c) / base).toFixed(3) : 0;
      });
      w = counts;
    } else {
      counts = raw;
      w = raw.slice();
      w[w.length - 1] = w[w.length - 1] / qFrac;
    }
    const ts = quarters.map((q) => q.t);
    const fit = total >= 8 ? fitBell(w, ts) : null;
    const waves = total >= 16 ? detectWaves(w, ts, raw) : null;
    let status = '—';
    if (waves) {
      status = 'secondwave';
    } else if (fit && fit.r2 < 0.25) {
      status = 'unclear';
    } else if (fit) {
      const d = nowT - fit.mu;
      status = fit.openEnded || d < -0.5 ? 'rising' : d > 0.75 ? 'declining' : 'peaking';
    } else if (total >= 2) {
      // no usable fit: brand-new if all activity sits in the last 3 years (12 quarters)
      const lastIdx = quarters.length - 12;
      const recent = counts.reduce((s, c, idx) => s + (idx >= lastIdx ? c : 0), 0);
      if (recent === total) status = 'emerging';
    }
    return { i, name, counts, total, fit, waves, status, quarters, nowT, nowYear, custom };
  });
}

const STATUS_ORDER = { rising: 0, emerging: 1, secondwave: 2, peaking: 3, declining: 4, unclear: 5, '—': 6 };
const isSelected = (s) => s.custom ? state.customSel.has(s.name) : state.themeSel.has(s.i);
function toggleSel(s) {
  if (s.custom) { state.customSel.has(s.name) ? state.customSel.delete(s.name) : state.customSel.add(s.name); }
  else { state.themeSel.has(s.i) ? state.themeSel.delete(s.i) : state.themeSel.add(s.i); }
}

function renderThemes(papers) {
  if (!state.themeSel) {
    state.themeSel = new Set(THEME_NAMES.map((n, i) => THEME_DEFAULT.includes(n) ? i : -1).filter((i) => i >= 0));
  }
  const stats = themeStats(papers);
  const quarters = stats[0].quarters;
  const nowYear = stats[0].nowYear;

  // extend 8 quarters (2y) past the window for fit projections
  const ext = quarters.slice();
  let { y, q } = quarters[quarters.length - 1];
  for (let k = 0; k < 8; k++) {
    q++; if (q > 3) { q = 0; y++; }
    ext.push({ y, q, t: y + (q + 0.5) / 4, label: `${y} Q${q + 1}` });
  }

  /* chips: custom first, then by status (declining & sparse sink) */
  $('#theme-chips').innerHTML = stats
    .slice().sort((a, b) => (b.custom === true) - (a.custom === true) || (STATUS_ORDER[a.status] >= 4) - (STATUS_ORDER[b.status] >= 4) || b.total - a.total)
    .map((s) => `<button class="chip theme-chip ${s.custom ? 'custom' : ''} ${isSelected(s) ? 'active' : ''}" data-ti="${s.i}" data-name="${esc(s.name)}">${esc(s.name)} <span class="n">${s.total}</span>${s.custom ? '<span class="x" title="remove curve">×</span>' : ''}</button>`)
    .join('');
  $('#theme-chips').querySelectorAll('.theme-chip').forEach((b) =>
    b.addEventListener('click', (ev) => {
      const st = stats.find((x) => String(x.i) === b.dataset.ti);
      if (!st) return;
      if (st.custom && ev.target.classList.contains('x')) {
        state.custom = state.custom.filter((n) => n !== st.name);
        state.customSel.delete(st.name);
        saveCustom(); writeHash();
      } else {
        toggleSel(st);
      }
      renderThemes(papers);
    }));

  /* chart */
  const sel = stats.filter((s) => isSelected(s));
  const datasets = [];
  sel.forEach((s, k) => {
    const color = THEME_PALETTE[k % THEME_PALETTE.length];
    datasets.push({
      label: s.name,
      data: [...s.counts, ...new Array(8).fill(null)],
      borderColor: color, backgroundColor: color,
      tension: 0.3, pointRadius: 0, pointHitRadius: 6, borderWidth: 2.2, spanGaps: false,
    });
    if (s.custom && state.themeMode !== 'abs') {
      const cache = (state._fieldCurves ||= new Map());
      if (!cache.has(s.name)) {
        cache.set(s.name, 'loading');
        fetchFieldCurve(s.name).then((m) => {
          cache.set(s.name, m);
          if (m && state.view === 'analytics') renderAnalytics();
        });
      } else {
        const fc = cache.get(s.name);
        if (fc && fc !== 'loading') {
          datasets.push({
            label: s.name + ' — field-wide (OpenAlex)',
            data: ext.map((qq) => (qq.q === 1 && fc.has(qq.y) ? fc.get(qq.y) : null)),
            borderColor: color, backgroundColor: color,
            borderDash: [2, 3], pointRadius: 3, pointStyle: 'rectRot', borderWidth: 1.8,
            spanGaps: true,
          });
        }
      }
    }
    const fitFn = s.waves?.revivalFit || s.fit;
    const fitStart = s.waves ? s.waves.trough : -Infinity;
    if (state.showFit !== false && fitFn) {
      datasets.push({
        label: '_fit_' + s.name,
        data: ext.map((qq) => (qq.t >= fitStart ? +fitFn.value(qq.t).toFixed(2) : null)),
        borderColor: color + '88', backgroundColor: 'transparent',
        borderDash: [6, 5], pointRadius: 0, borderWidth: 1.6, tension: 0.4, spanGaps: false,
      });
    }
  });
  destroyChart('themes');
  let maxActual = Math.max(1, ...sel.flatMap((s) => s.counts));
  if (state._fieldCurves) {
    for (const s of sel) {
      if (!s.custom) continue;
      const fc = state._fieldCurves.get(s.name);
      if (fc && fc !== 'loading') maxActual = Math.max(maxActual, ...fc.values());
    }
  }
  state.charts.themes = new Chart($('#ch-themes'), {
    type: 'line',
    data: { labels: ext.map((qq) => qq.label), datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: {
        y: {
          beginAtZero: true,
          max: state.themeMode !== 'abs' ? +(maxActual * 1.6).toFixed(2) : Math.ceil(maxActual * 1.6),
          ticks: state.themeMode !== 'abs' ? { callback: (v) => v + '/10k' } : {},
        },
        x: {
          grid: { display: false },
          ticks: {
            autoSkip: false, maxRotation: 0,
            callback: (val, idx) => (ext[idx] && ext[idx].q === 0 ? String(ext[idx].y) : ''),
          },
        },
      },
      plugins: {
        legend: { position: 'top', labels: { filter: (item) => !item.text.startsWith('_fit_') } },
        tooltip: { filter: (item) => !item.dataset.label.startsWith('_fit_') },
      },
    },
  });

  /* status board: rising & emerging first, declining at the end */
  const arrow = { rising: '<span class="st st-up">▲ rising</span>', emerging: '<span class="st st-new">✦ emerging</span>', secondwave: '<span class="st st-wave">↻ 2nd wave</span>', peaking: '<span class="st st-peak">● near peak</span>', declining: '<span class="st st-down">▼ declining</span>', unclear: '<span class="st">~ no clear bell</span>', '—': '<span class="st">too sparse</span>' };
  $('#theme-board tbody').innerHTML = stats
    .slice().sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.total - a.total)
    .map((s) => {
      const f = s.waves?.revivalFit || s.fit;
      const peakCell = s.status === 'secondwave' && s.waves?.revivalFit
        ? '~' + quarterLabelOf(s.waves.revivalFit.mu) + (s.waves.revivalFit.mu > s.nowT ? ' (revival, projected)' : ' (revival)')
        : (s.fit && s.status !== 'unclear' ? (s.fit.openEnded ? 'not yet in sight' : '~' + quarterLabelOf(s.fit.mu) + (s.fit.mu > s.nowT ? ' (projected)' : '')) : '—');
      const fitCell = s.status === 'secondwave' && s.waves?.revivalFit
        ? Math.round(s.waves.revivalFit.r2 * 100) + '%'
        : (s.fit && s.fit.nonzero >= 6 ? Math.round(s.fit.r2 * 100) + '%' : '—');
      return `<tr data-ti="${s.i}" class="${isSelected(s) ? 'sel' : ''}">
      <td>${esc(s.name)}${s.custom ? ' <span class="st">(custom)</span>' : ''}</td>
      <td>${s.total}</td>
      <td>${peakCell}</td>
      <td>${arrow[s.status]}</td>
      <td>${fitCell}</td>
    </tr>`;
    })
    .join('');
  $('#theme-board tbody').querySelectorAll('tr').forEach((tr) =>
    tr.addEventListener('click', () => {
      const st = stats.find((x) => String(x.i) === tr.dataset.ti);
      if (st) { toggleSel(st); renderThemes(papers); }
    }));

  /* re-discovered themes card */
  const waved = stats.filter((s) => s.status === 'secondwave');
  const rc = $('#rediscovered-card');
  if (rc) {
    rc.hidden = !waved.length;
    if (waved.length) {
      $('#rediscovered-board tbody').innerHTML = waved
        .sort((a, b) => b.total - a.total)
        .map((s) => `<tr data-ti="${s.i}" class="${isSelected(s) ? 'sel' : ''}">
          <td>${esc(s.name)}</td>
          <td>${quarterLabelOf(s.waves.wave1)}</td>
          <td>${quarterLabelOf(s.waves.trough)}</td>
          <td>${s.waves.revivalFit ? '~' + quarterLabelOf(s.waves.revivalFit.mu) + (s.waves.revivalFit.mu > s.nowT ? ' (projected)' : '') : 'still building'}</td>
          <td>${s.waves.revivalFit ? Math.round(s.waves.revivalFit.r2 * 100) + '%' : '—'}</td>
        </tr>`)
        .join('');
      $('#rediscovered-board tbody').querySelectorAll('tr').forEach((tr) =>
        tr.addEventListener('click', () => {
          const st = stats.find((x) => String(x.i) === tr.dataset.ti);
          if (st) { toggleSel(st); renderThemes(papers); }
        }));
    }
  }
}

/* ---------------- timeline ---------------- */
async function loadTimeline() {
  if (state.timeline) return state.timeline;
  try {
    const res = await fetch('data/timeline.json?v=' + (state._v || '0'));
    const data = await res.json();
    const byId = new Map(state.papers.map((p) => [p.id, p]));
    state.timeline = (data.entries || []).map((e) => {
      const p = byId.get(e.id);
      return p ? { ...e, paper: p } : null;
    }).filter(Boolean);
  } catch (err) {
    state.timeline = [];
  }
  return state.timeline;
}

async function renderTimeline() {
  const entries = await loadTimeline();
  const el = $('#timeline');
  // timeline respects lab/topic/year filters (not search/type/page)
  const visible = entries.filter((e) => {
    const p = e.paper;
    if (state.orgs.size && !state.orgs.has(p.org)) return false;
    if (state.years.size && !state.years.has(p.date.slice(0, 4))) return false;
    if (state.topics.size && !state.topics.has(e.topic)) return false;
    return true;
  }).sort((a, b) => (a.paper.date < b.paper.date ? -1 : 1));

  $('#timeline-empty').hidden = visible.length > 0;
  let html = '';
  let lastYear = null;
  for (const e of visible) {
    const p = e.paper;
    const year = p.date.slice(0, 4);
    if (year !== lastYear) {
      html += `<div class="tl-year">${year}</div>`;
      lastYear = year;
    }
    const org = ORG_META[p.org] || ORG_META.other;
    const month = new Date(p.date + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' });
    html += `
      <div class="tl-item" style="--org-color:var(--${p.org in ORG_META ? p.org : 'other'})">
        <div class="tl-dot"></div>
        <div class="tl-body">
          <div class="tl-head">
            <a class="tl-title" href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.title)}</a>
            <span class="tl-meta">${month} · ${org.label}</span>
          </div>
          <p class="tl-why">${esc(e.why)}</p>
          <button class="tag tl-tag" data-topic="${esc(e.topic)}">${esc(e.topic)}</button>
        </div>
      </div>`;
  }
  el.innerHTML = html;
  el.querySelectorAll('.tl-tag').forEach((b) =>
    b.addEventListener('click', () => {
      const t = b.dataset.topic;
      if (!state.topics.has(t)) { state.topics.add(t); applyFilters(); }
    }));
}

/* ---------------- view & theme ---------------- */
function setView(view, sync = true) {
  state.view = view;
  document.querySelectorAll('.view-tab').forEach((t) => {
    const active = t.dataset.view === view;
    t.classList.toggle('active', active);
    t.setAttribute('aria-selected', active);
  });
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
  $(`#view-${view}`).classList.add('active');
  if (view === 'analytics') renderAnalytics();
  if (view === 'timeline') renderTimeline();
  if (sync) writeHash();
}

function setThemeIcon() {
  $('#theme-toggle').textContent = document.documentElement.dataset.theme === 'dark' ? '☀' : '☾';
}

/* ---------------- events ---------------- */
function init() {
  state.custom = loadCustom();
  setThemeIcon();

  const addCustom = () => {
    const v = $('#custom-input').value.trim();
    if (!v || v.length < 3) return;
    if (!state.custom.includes(v)) {
      if (state.custom.length >= 12) { state.custom.shift(); }
      state.custom.push(v);
    }
    state.customSel.add(v);
    $('#custom-input').value = '';
    saveCustom(); writeHash();
    if (state.view === 'analytics') renderAnalytics();
  };
  $('#custom-btn').addEventListener('click', addCustom);
  $('#custom-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') addCustom(); });

  const queueSource = () => {
    const v = $('#source-url').value.trim();
    if (!/^https?:\/\//.test(v)) { $('#source-url').focus(); return; }
    const title = encodeURIComponent('Add source: ' + v);
    const body = encodeURIComponent(v + '\n\nQueued from the AI Papers site — the next daily refresh will scrape this page, add its papers, and keep watching it.');
    window.open(`https://github.com/michaelofengend/ai-papers/issues/new?labels=source-request&title=${title}&body=${body}`, '_blank', 'noopener');
    $('#source-url').value = '';
  };
  $('#source-btn').addEventListener('click', queueSource);
  $('#source-url').addEventListener('keydown', (e) => { if (e.key === 'Enter') queueSource(); });
  $('#theme-toggle').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('frt-theme', next); } catch (e) {}
    setThemeIcon();
    if (state.view === 'analytics') renderAnalytics();
  });

  let debounce;
  $('#search').addEventListener('input', (e) => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      state.query = e.target.value;
      if (state.query && (state.sort === 'newest' || state.sort === 'featured')) { state.sort = 'match'; $('#sort').value = 'match'; }
      if (!state.query && state.sort === 'match') { state.sort = 'featured'; $('#sort').value = 'featured'; }
      applyFilters();
    }, 180);
  });

  $('#sort').addEventListener('change', (e) => { state.sort = e.target.value; applyFilters(); });

  $('#fit-toggle').addEventListener('change', (e) => {
    state.showFit = e.target.checked;
    if (state.view === 'analytics') renderAnalytics();
  });

  document.querySelectorAll('.mode-btn').forEach((b) =>
    b.addEventListener('click', () => {
      state.themeMode = b.dataset.mode;
      document.querySelectorAll('.mode-btn').forEach((x) => x.classList.toggle('active', x === b));
      if (state.view === 'analytics') renderAnalytics();
    }));

  $('#clear-filters').addEventListener('click', () => {
    state.kinds = new Set(['paper']);
    state.orgs.clear(); state.topics.clear(); state.years.clear();
    state.query = ''; $('#search').value = '';
    state.sort = 'featured'; $('#sort').value = 'featured';
    applyFilters();
  });

  document.querySelectorAll('.view-tab').forEach((tab) =>
    tab.addEventListener('click', () => setView(tab.dataset.view)));

  document.addEventListener('keydown', (e) => {
    if ((e.target instanceof Element && e.target.matches('input, select, textarea')) || e.metaKey || e.ctrlKey || e.altKey) return;
    if (state.view !== 'papers') return;
    if (e.key === 'ArrowLeft') gotoPage(state.page - 1);
    if (e.key === 'ArrowRight') gotoPage(state.page + 1);
  });

  window.addEventListener('hashchange', () => {
    if (suppressHash) return;
    readHash();
    $('#search').value = state.query;
    $('#sort').value = state.sort;
    setView(state.view, false);
    applyFilters(false);
  });

  // filters: collapsed by default on small screens, always open on desktop
  const mq = matchMedia('(max-width: 920px)');
  const syncDisclosure = () => { $('#filters-disclosure').open = !mq.matches; };
  syncDisclosure();
  mq.addEventListener('change', syncDisclosure);

  load().catch((err) => {
    $('#feed-empty').hidden = false;
    $('#feed-empty').textContent = 'Failed to load paper data: ' + err.message;
  });
}

init();
