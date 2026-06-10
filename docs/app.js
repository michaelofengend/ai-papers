/* Frontier AI Research Tracker */
'use strict';

const ORG_META = {
  anthropic: { label: 'Anthropic', color: '#d97757' },
  openai:    { label: 'OpenAI',    color: '#10a37f' },
  deepmind:  { label: 'DeepMind',  color: '#5e8bff' },
  other:     { label: 'Other',     color: '#8a93a6' },
};
const PAGE_SIZE = 30;

const state = {
  papers: [],
  filtered: [],
  orgs: new Set(),      // empty = all
  topics: new Set(),    // empty = all
  years: new Set(),     // empty = all
  query: '',
  sort: 'newest',
  rendered: 0,
  view: 'feed',
  charts: {},
};

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------------- data load ---------------- */
async function load() {
  const res = await fetch('data/papers.json');
  const data = await res.json();
  state.papers = (data.papers || data).map((p, i) => ({
    ...p,
    id: p.id || i,
    date: p.date || '1970-01-01',
    topics: p.topics || [],
    authors: p.authors || [],
    _ts: Date.parse(p.date || '1970-01-01') || 0,
    _hay: [p.title, (p.authors || []).join(' '), p.summary, p.abstract, (p.topics || []).join(' '), p.venue]
      .join(' ').toLowerCase(),
  }));
  state.papers.sort((a, b) => b._ts - a._ts);

  $('#stat-count').textContent = state.papers.length.toLocaleString();
  if (data.updated) {
    $('#stat-updated').textContent = ` · updated ${new Date(data.updated).toISOString().slice(0, 10)}`;
  }
  buildChips();
  applyFilters();
}

/* ---------------- chips ---------------- */
function buildChips() {
  const orgCounts = {}, topicCounts = {}, yearCounts = {};
  for (const p of state.papers) {
    orgCounts[p.org] = (orgCounts[p.org] || 0) + 1;
    for (const t of p.topics) topicCounts[t] = (topicCounts[t] || 0) + 1;
    const y = p.date.slice(0, 4);
    yearCounts[y] = (yearCounts[y] || 0) + 1;
  }

  $('#org-chips').innerHTML = Object.entries(ORG_META)
    .filter(([k]) => orgCounts[k])
    .map(([k, m]) =>
      `<button class="chip org-chip" data-org="${k}" style="--dot:${m.color}">
        <span class="dot"></span>${m.label} <span class="n">${orgCounts[k]}</span></button>`)
    .join('');

  const topics = Object.entries(topicCounts).sort((a, b) =>
    (a[0] === 'Other') - (b[0] === 'Other') || b[1] - a[1]);
  $('#topic-chips').innerHTML = topics
    .map(([t, n]) => `<button class="chip topic-chip" data-topic="${esc(t)}">${esc(t)} <span class="n">${n}</span></button>`)
    .join('');

  const years = Object.keys(yearCounts).sort();
  $('#year-chips').innerHTML = years
    .map((y) => `<button class="chip year-chip" data-year="${y}">${y}</button>`)
    .join('');

  document.querySelectorAll('.org-chip').forEach((b) =>
    b.addEventListener('click', () => { toggle(state.orgs, b.dataset.org); b.classList.toggle('active'); applyFilters(); }));
  document.querySelectorAll('.topic-chip').forEach((b) =>
    b.addEventListener('click', () => { toggle(state.topics, b.dataset.topic); b.classList.toggle('active'); applyFilters(); }));
  document.querySelectorAll('.year-chip').forEach((b) =>
    b.addEventListener('click', () => { toggle(state.years, b.dataset.year); b.classList.toggle('active'); applyFilters(); }));
}

function toggle(set, v) { set.has(v) ? set.delete(v) : set.add(v); }

/* ---------------- filtering & sorting ---------------- */
function applyFilters() {
  const q = state.query.trim().toLowerCase();
  const terms = q ? q.split(/\s+/).filter(Boolean) : [];

  state.filtered = state.papers.filter((p) => {
    if (state.orgs.size && !state.orgs.has(p.org)) return false;
    if (state.years.size && !state.years.has(p.date.slice(0, 4))) return false;
    if (state.topics.size && !p.topics.some((t) => state.topics.has(t))) return false;
    if (terms.length && !terms.every((t) => p._hay.includes(t))) return false;
    return true;
  });

  if (terms.length) {
    for (const p of state.filtered) {
      let score = 0;
      const title = p.title.toLowerCase();
      for (const t of terms) {
        if (title.includes(t)) score += 5;
        if ((p.summary || '').toLowerCase().includes(t)) score += 2;
        score += 1; // matched somewhere
      }
      p._score = score;
    }
  }

  const sort = state.sort === 'match' && !terms.length ? 'newest' : state.sort;
  const cmp = {
    newest: (a, b) => b._ts - a._ts,
    oldest: (a, b) => a._ts - b._ts,
    cited:  (a, b) => (b.cited_by || 0) - (a.cited_by || 0) || b._ts - a._ts,
    match:  (a, b) => (b._score || 0) - (a._score || 0) || b._ts - a._ts,
  }[sort];
  state.filtered.sort(cmp);

  const anyFilter = state.orgs.size || state.topics.size || state.years.size || q;
  $('#clear-filters').hidden = !anyFilter;
  $('#result-count').textContent = anyFilter
    ? `${state.filtered.length.toLocaleString()} of ${state.papers.length.toLocaleString()} papers`
    : `${state.papers.length.toLocaleString()} papers`;

  resetFeed();
  if (state.view === 'analytics') renderAnalytics();
}

/* ---------------- feed rendering ---------------- */
function resetFeed() {
  $('#feed').innerHTML = '';
  state.rendered = 0;
  $('#feed-empty').hidden = state.filtered.length > 0;
  $('#feed-end').hidden = true;
  $('#sentinel').style.display = state.filtered.length ? 'flex' : 'none';
  renderMore();
}

function renderMore() {
  const slice = state.filtered.slice(state.rendered, state.rendered + PAGE_SIZE);
  if (!slice.length) {
    $('#sentinel').style.display = 'none';
    $('#feed-end').hidden = state.filtered.length === 0;
    return;
  }
  const frag = document.createDocumentFragment();
  for (const p of slice) frag.appendChild(card(p));
  $('#feed').appendChild(frag);
  state.rendered += slice.length;
  if (state.rendered >= state.filtered.length) {
    $('#sentinel').style.display = 'none';
    $('#feed-end').hidden = false;
  }
}

function card(p) {
  const org = ORG_META[p.org] || ORG_META.other;
  const el = document.createElement('article');
  el.className = 'card';
  el.style.setProperty('--org-color', org.color);

  const authors = p.authors.length
    ? esc(p.authors.slice(0, 6).join(', ')) + (p.authors.length > 6 ? ' et al.' : '')
    : '';
  const date = p.date && p.date !== '1970-01-01'
    ? new Date(p.date + 'T12:00:00Z').toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
    : '';
  const cites = p.cited_by ? `<span class="sep">·</span><span class="cites">${p.cited_by.toLocaleString()} citations</span>` : '';
  const venue = p.venue ? `<span class="sep">·</span><span class="venue">${esc(p.venue)}</span>` : '';
  const hasAbstract = p.abstract && p.abstract.length > 40 && p.abstract !== p.summary;

  el.innerHTML = `
    <div class="card-head">
      <a class="card-title" href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.title)}</a>
    </div>
    <div class="card-meta">
      <span class="org-badge">${org.label}</span>
      ${date ? `<span>${date}</span>` : ''}
      ${authors ? `<span class="sep">·</span><span class="authors">${authors}</span>` : ''}
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
      if (!state.topics.has(t)) {
        state.topics.add(t);
        document.querySelectorAll(`.topic-chip`).forEach((c) => { if (c.dataset.topic === t) c.classList.add('active'); });
        applyFilters();
        window.scrollTo({ top: 0 });
      }
    }));
  return el;
}

/* ---------------- analytics ---------------- */
const CHART_DEFAULTS = {
  color: '#9aa4b5',
  borderColor: '#232b3a',
};

function quarterKey(d) {
  const y = d.slice(0, 4), m = +d.slice(5, 7);
  return `${y} Q${Math.ceil(m / 3) || 1}`;
}

function destroyChart(key) {
  if (state.charts[key]) { state.charts[key].destroy(); delete state.charts[key]; }
}

function renderAnalytics() {
  if (typeof Chart === 'undefined') return;
  Chart.defaults.color = CHART_DEFAULTS.color;
  Chart.defaults.borderColor = CHART_DEFAULTS.borderColor;
  Chart.defaults.font.family = 'Inter, sans-serif';
  Chart.defaults.font.size = 11.5;

  const papers = state.filtered;
  $('#an-count').textContent = papers.length.toLocaleString();

  /* --- publications over time, stacked by org --- */
  const quarters = [...new Set(papers.map((p) => quarterKey(p.date)))].sort();
  const byOrgQ = {};
  for (const o of Object.keys(ORG_META)) byOrgQ[o] = Object.fromEntries(quarters.map((q) => [q, 0]));
  for (const p of papers) byOrgQ[p.org in ORG_META ? p.org : 'other'][quarterKey(p.date)]++;
  destroyChart('time');
  state.charts.time = new Chart($('#ch-time'), {
    type: 'bar',
    data: {
      labels: quarters,
      datasets: Object.entries(ORG_META)
        .filter(([o]) => papers.some((p) => p.org === o))
        .map(([o, m]) => ({ label: m.label, data: quarters.map((q) => byOrgQ[o][q]), backgroundColor: m.color, stack: 's' })),
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: { x: { stacked: true, grid: { display: false } }, y: { stacked: true, beginAtZero: true } },
      plugins: { legend: { position: 'top' } },
    },
  });

  /* --- org share doughnut --- */
  const orgCounts = {};
  for (const p of papers) orgCounts[p.org] = (orgCounts[p.org] || 0) + 1;
  const orgEntries = Object.entries(ORG_META).filter(([o]) => orgCounts[o]);
  destroyChart('org');
  state.charts.org = new Chart($('#ch-org'), {
    type: 'doughnut',
    data: {
      labels: orgEntries.map(([, m]) => m.label),
      datasets: [{ data: orgEntries.map(([o]) => orgCounts[o]), backgroundColor: orgEntries.map(([, m]) => m.color), borderWidth: 0 }],
    },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'right' } }, cutout: '62%' },
  });

  /* --- topic counts --- */
  const topicCounts = {};
  for (const p of papers) for (const t of p.topics) topicCounts[t] = (topicCounts[t] || 0) + 1;
  const topTopics = Object.entries(topicCounts).sort((a, b) => b[1] - a[1]).slice(0, 12);
  destroyChart('topics');
  state.charts.topics = new Chart($('#ch-topics'), {
    type: 'bar',
    data: {
      labels: topTopics.map(([t]) => t),
      datasets: [{ data: topTopics.map(([, n]) => n), backgroundColor: '#7aa2f7cc', borderRadius: 4 }],
    },
    options: {
      indexAxis: 'y', responsive: true, maintainAspectRatio: false,
      scales: { x: { beginAtZero: true }, y: { grid: { display: false } } },
      plugins: { legend: { display: false } },
    },
  });

  /* --- topic trends per year (top 6) --- */
  const years = [...new Set(papers.map((p) => p.date.slice(0, 4)))].sort();
  const top6 = topTopics.slice(0, 6).map(([t]) => t);
  const palette = ['#7aa2f7', '#d97757', '#10a37f', '#e0af68', '#bb9af7', '#7dcfff'];
  const trendData = top6.map((t, i) => ({
    label: t,
    data: years.map((y) => papers.filter((p) => p.date.startsWith(y) && p.topics.includes(t)).length),
    borderColor: palette[i], backgroundColor: palette[i],
    tension: 0.3, pointRadius: 2.5, borderWidth: 2,
  }));
  destroyChart('trends');
  state.charts.trends = new Chart($('#ch-trends'), {
    type: 'line',
    data: { labels: years, datasets: trendData },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: { y: { beginAtZero: true }, x: { grid: { display: false } } },
      plugins: { legend: { position: 'top' } },
    },
  });

  /* --- top cited list --- */
  const topCited = [...papers].filter((p) => p.cited_by).sort((a, b) => b.cited_by - a.cited_by).slice(0, 10);
  $('#top-cited').innerHTML = topCited.map((p) => {
    const org = ORG_META[p.org] || ORG_META.other;
    return `<li><a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.title)}</a>
      <span class="tc-meta"> — ${org.label}, ${p.date.slice(0, 4)}, ${p.cited_by.toLocaleString()} citations</span></li>`;
  }).join('') || '<li class="tc-meta">No citation data in this selection.</li>';
}

/* ---------------- events ---------------- */
function init() {
  let debounce;
  $('#search').addEventListener('input', (e) => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      state.query = e.target.value;
      if (state.query && state.sort === 'newest') { state.sort = 'match'; $('#sort').value = 'match'; }
      applyFilters();
    }, 180);
  });

  $('#sort').addEventListener('change', (e) => { state.sort = e.target.value; applyFilters(); });

  $('#clear-filters').addEventListener('click', () => {
    state.orgs.clear(); state.topics.clear(); state.years.clear();
    state.query = ''; $('#search').value = '';
    state.sort = 'newest'; $('#sort').value = 'newest';
    document.querySelectorAll('.chip.active').forEach((c) => c.classList.remove('active'));
    applyFilters();
  });

  document.querySelectorAll('.view-tab').forEach((tab) =>
    tab.addEventListener('click', () => {
      document.querySelectorAll('.view-tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      state.view = tab.dataset.view;
      document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
      $(`#view-${state.view}`).classList.add('active');
      if (state.view === 'analytics') renderAnalytics();
    }));

  new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting) renderMore();
  }, { rootMargin: '600px' }).observe($('#sentinel'));

  load().catch((err) => {
    $('#feed-empty').hidden = false;
    $('#feed-empty').textContent = 'Failed to load paper data: ' + err.message;
    $('#sentinel').style.display = 'none';
  });
}

init();
