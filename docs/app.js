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
  sort: 'newest',
  page: 1,
  view: 'papers',
  charts: {},
  timeline: null, // lazy-loaded entries
};

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const orgColor = (org) => getComputedStyle(document.documentElement).getPropertyValue(`--${org in ORG_META ? org : 'other'}`).trim();

/* ---------------- URL state ---------------- */
function readHash() {
  const h = new URLSearchParams(location.hash.replace(/^#/, ''));
  state.query = h.get('q') || '';
  state.sort = ['newest', 'oldest', 'cited', 'match'].includes(h.get('sort')) ? h.get('sort') : 'newest';
  state.page = Math.max(1, parseInt(h.get('page'), 10) || 1);
  state.view = ['analytics', 'timeline'].includes(h.get('view')) ? h.get('view') : 'papers';
  const show = h.get('show');
  state.kinds = show === 'posts' ? new Set(['post']) : show === 'all' ? new Set() : new Set(['paper']);
  state.orgs = new Set((h.get('labs') || '').split(',').filter(Boolean));
  state.topics = new Set((h.get('topics') || '').split('|').filter(Boolean));
  state.years = new Set((h.get('years') || '').split(',').filter(Boolean));
}

let suppressHash = false;
function writeHash() {
  const h = new URLSearchParams();
  if (state.query) h.set('q', state.query);
  if (state.sort !== 'newest') h.set('sort', state.sort);
  if (state.page > 1) h.set('page', String(state.page));
  if (state.view !== 'papers') h.set('view', state.view);
  if (!(state.kinds.size === 1 && state.kinds.has('paper'))) {
    h.set('show', state.kinds.size === 1 && state.kinds.has('post') ? 'posts' : 'all');
  }
  if (state.orgs.size) h.set('labs', [...state.orgs].join(','));
  if (state.topics.size) h.set('topics', [...state.topics].join('|'));
  if (state.years.size) h.set('years', [...state.years].join(','));
  const str = h.toString().replace(/%2C/g, ',').replace(/%7C/g, '|');
  suppressHash = true;
  history.replaceState(null, '', str ? '#' + str : location.pathname + location.search);
  setTimeout(() => { suppressHash = false; });
}

/* ---------------- data load ---------------- */
async function load() {
  const res = await fetch('data/papers.json');
  const data = await res.json();
  state.papers = (data.papers || data).map((p, i) => ({
    ...p,
    id: p.id ?? i,
    date: p.date || '1970-01-01',
    topics: p.topics || [],
    authors: p.authors || [],
    _ts: Date.parse(p.date || '1970-01-01') || 0,
    kind: p.kind === 'post' ? 'post' : 'paper',
    _hay: [p.title, (p.authors || []).join(' '), p.summary, p.abstract, (p.topics || []).join(' '), p.venue]
      .join(' ').toLowerCase(),
  }));
  state.papers.sort((a, b) => b._ts - a._ts);

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

  const sort = state.sort === 'match' && !state._terms.length ? 'newest' : state.sort;
  const cmp = {
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
}

/* ---------------- timeline ---------------- */
async function loadTimeline() {
  if (state.timeline) return state.timeline;
  try {
    const res = await fetch('data/timeline.json');
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
  setThemeIcon();
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
      if (state.query && state.sort === 'newest') { state.sort = 'match'; $('#sort').value = 'match'; }
      if (!state.query && state.sort === 'match') { state.sort = 'newest'; $('#sort').value = 'newest'; }
      applyFilters();
    }, 180);
  });

  $('#sort').addEventListener('change', (e) => { state.sort = e.target.value; applyFilters(); });

  $('#clear-filters').addEventListener('click', () => {
    state.kinds = new Set(['paper']);
    state.orgs.clear(); state.topics.clear(); state.years.clear();
    state.query = ''; $('#search').value = '';
    state.sort = 'newest'; $('#sort').value = 'newest';
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
