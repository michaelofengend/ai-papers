/* Daily refresh: pull recent papers from OpenAlex, arXiv, transformer-circuits
   and the Anthropic alignment blog; append anything new to data/papers.json.
   Deterministic (no LLM) — new papers get rule-based topics and
   abstract-derived summaries. Usage: node scripts/update.mjs [--days 90] */
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normTitle, extractArxivId, tagTopics, autoSummary, isSpam, classifyKind } from './lib.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data', 'papers.json');
const MAILTO = 'michaelofengend@gmail.com';
const DAYS = Number(process.argv[process.argv.indexOf('--days') + 1]) || 90;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const today = new Date().toISOString().slice(0, 10);
const sinceDate = new Date(Date.now() - DAYS * 864e5).toISOString().slice(0, 10);

async function fetchText(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': `research-tracker (${MAILTO})` } });
      if (res.ok) return await res.text();
      if (res.status === 429 || res.status >= 500) { await sleep(4000 * (i + 1)); continue; }
      throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      if (i === tries - 1) { console.warn(`fetch failed ${url}: ${e.message}`); return null; }
      await sleep(3000);
    }
  }
  return null;
}

function deinvert(idx) {
  if (!idx) return null;
  const words = [];
  for (const [w, positions] of Object.entries(idx)) for (const p of positions) words[p] = w;
  return words.join(' ');
}

/* ---------- OpenAlex: recent works for the three institutions ---------- */
async function openalexRecent() {
  const out = [];
  const orgs = [
    { org: 'anthropic', search: 'Anthropic' },
    { org: 'openai', search: 'OpenAI' },
    { org: 'deepmind', search: 'DeepMind' },
  ];
  for (const { org, search } of orgs) {
    const instText = await fetchText(`https://api.openalex.org/institutions?search=${search}&mailto=${MAILTO}`);
    if (!instText) continue;
    const inst = JSON.parse(instText).results.filter((r) =>
      r.display_name.toLowerCase().includes(search.toLowerCase()) &&
      (r.type === 'company' || r.works_count > 100));
    const ids = inst.slice(0, 2).map((r) => r.id.split('/').pop());
    for (const id of ids) {
      let cursor = '*';
      for (let page = 0; page < 10 && cursor; page++) {
        const url = `https://api.openalex.org/works?filter=authorships.institutions.lineage:${id},from_publication_date:${sinceDate}&per-page=100&cursor=${encodeURIComponent(cursor)}&mailto=${MAILTO}`;
        const text = await fetchText(url);
        if (!text) break;
        const json = JSON.parse(text);
        for (const w of json.results || []) {
          if (['paratext', 'erratum', 'editorial', 'peer-review'].includes(w.type)) continue;
          if (!w.title) continue;
          const loc = w.primary_location || {};
          const arxivLoc = (w.locations || []).find((l) => /arxiv/i.test(l.source?.display_name || '') || /arxiv\.org/.test(l.landing_page_url || ''));
          out.push({
            title: w.title,
            authors: (w.authorships || []).map((a) => a.raw_author_name || a.author?.display_name).filter(Boolean),
            org,
            date: w.publication_date,
            url: loc.landing_page_url || arxivLoc?.landing_page_url || w.doi || w.id,
            pdf_url: loc.pdf_url || arxivLoc?.pdf_url || null,
            arxiv_id: extractArxivId(arxivLoc?.landing_page_url) || extractArxivId(arxivLoc?.pdf_url),
            abstract: deinvert(w.abstract_inverted_index),
            source: 'openalex',
            venue: loc.source?.display_name || null,
            cited_by: w.cited_by_count ?? null,
          });
        }
        cursor = json.meta?.next_cursor || null;
        await sleep(1000);
      }
    }
  }
  return out;
}

/* ---------- arXiv: topic sweeps, keep org-affiliated ---------- */
const ARXIV_QUERIES = [
  'all:"mechanistic interpretability"',
  'all:"sparse autoencoder" AND cat:cs.LG',
  'all:"chain of thought" AND all:faithfulness',
  'all:"reward hacking" OR all:"alignment faking"',
  'all:"AI safety" AND cat:cs.LG',
  'all:"language model" AND all:interpretability',
  'all:"test-time compute" OR all:"reasoning model"',
];
const ORG_RE = /\b(anthropic|openai|google deepmind|deepmind)\b/i;

async function arxivRecent() {
  const out = [];
  for (const q of ARXIV_QUERIES) {
    const url = `http://export.arxiv.org/api/query?search_query=${encodeURIComponent(q)}&sortBy=submittedDate&sortOrder=descending&max_results=60`;
    const xml = await fetchText(url);
    await sleep(3500);
    if (!xml) continue;
    for (const entry of xml.split('<entry>').slice(1)) {
      const get = (tag) => (entry.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`)) || [])[1]?.replace(/\s+/g, ' ').trim();
      const id = (get('id') || '').match(/abs\/(\d{4}\.\d{4,5})/)?.[1];
      const date = (get('published') || '').slice(0, 10);
      if (!id || !date || date < sinceDate) continue;
      const abstract = decode(get('summary') || '');
      const comment = decode(get('arxiv:comment') || '');
      const affText = entry.match(/<arxiv:affiliation[^>]*>([\s\S]*?)<\/arxiv:affiliation>/g)?.join(' ') || '';
      const orgMatch = (abstract + ' ' + comment + ' ' + affText).match(ORG_RE);
      if (!orgMatch) continue; // only org-affiliated finds in CI mode
      const orgRaw = orgMatch[1].toLowerCase();
      out.push({
        title: decode(get('title') || ''),
        authors: [...entry.matchAll(/<name>([\s\S]*?)<\/name>/g)].map((m) => decode(m[1].trim())),
        org: orgRaw.includes('deepmind') ? 'deepmind' : orgRaw.includes('anthropic') ? 'anthropic' : 'openai',
        date,
        url: `https://arxiv.org/abs/${id}`,
        pdf_url: `https://arxiv.org/pdf/${id}`,
        arxiv_id: id,
        abstract,
        source: 'arxiv-sweep',
        venue: 'arXiv',
        cited_by: null,
      });
    }
  }
  return out;
}

function decode(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

/* ---------- transformer-circuits.pub index ---------- */
async function circuitsRecent() {
  const html = await fetchText('https://transformer-circuits.pub/');
  if (!html) return [];
  const out = [];
  const linkRe = /<a[^>]+href="(20\d\d\/[^"]+|[^"]*?\.html?)"[^>]*>([\s\S]*?)<\/a>/g;
  for (const m of html.matchAll(linkRe)) {
    let href = m[1];
    if (/^https?:/.test(href)) continue;
    const title = decode(m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
    if (!title || title.length < 8) continue;
    const ym = href.match(/^(20\d\d)\/([a-z0-9-]+)/i);
    const date = ym ? `${ym[1]}-01-01` : null; // refined below if month folder style
    const dm = href.match(/^(20\d\d)\/(?:.*?)(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i);
    const months = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
    out.push({
      title,
      authors: [],
      org: 'anthropic',
      date: dm ? `${dm[1]}-${months[dm[2].toLowerCase()]}-01` : date || today,
      url: 'https://transformer-circuits.pub/' + href,
      pdf_url: null,
      arxiv_id: null,
      abstract: null,
      source: 'transformer-circuits',
      venue: 'Transformer Circuits Thread',
      cited_by: null,
    });
  }
  return out;
}

/* ---------- Anthropic Alignment Science blog ---------- */
async function alignmentBlogRecent() {
  const html = await fetchText('https://alignment.anthropic.com/');
  if (!html) return [];
  const out = [];
  for (const m of html.matchAll(/<a[^>]+href="(\/20\d\d\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/g)) {
    const title = decode(m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
    if (!title || title.length < 8) continue;
    const ym = m[1].match(/\/(20\d\d)\//);
    out.push({
      title,
      authors: [],
      org: 'anthropic',
      date: ym ? `${ym[1]}-01-01` : today,
      url: 'https://alignment.anthropic.com' + m[1],
      pdf_url: null, arxiv_id: null, abstract: null,
      source: 'alignment-blog',
      venue: 'Anthropic Alignment Science Blog',
      cited_by: null,
    });
  }
  return out;
}

/* ---------- OpenAI: sitemaps + news RSS (HTML pages are Cloudflare-blocked) ---------- */
async function openaiRecent() {
  const out = [];
  const rssXml = await fetchText('https://openai.com/news/rss.xml');
  const rss = new Map(); // url -> {title, date, desc}
  if (rssXml) {
    for (const item of rssXml.split('<item>').slice(1)) {
      const get = (tag) => (item.match(new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`)) || [])[1]?.replace(/\s+/g, ' ').trim();
      const link = (get('link') || '').replace(/\/$/, '');
      if (!link) continue;
      const pub = get('pubDate');
      rss.set(link, {
        title: decode(get('title') || ''),
        date: pub ? new Date(pub).toISOString().slice(0, 10) : null,
        desc: decode((get('description') || '').replace(/<[^>]+>/g, ' ')).trim(),
      });
    }
  }
  for (const sm of ['publication', 'research']) {
    const xml = await fetchText(`https://openai.com/sitemap.xml/${sm}/`);
    if (!xml) continue;
    for (const m of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) {
      const url = m[1].trim().replace(/\/$/, '');
      // only individual post pages (openai.com/index/<slug>); skip section/listing URLs
      if (!/openai\.com\/index\/[a-z0-9][a-z0-9-]{3,}$/i.test(url)) continue;
      const meta = rss.get(url);
      const slugTitle = decodeURIComponent((url.split('/').pop() || '').replace(/-/g, ' ')).replace(/\b\w/g, (c) => c.toUpperCase());
      out.push({
        title: meta?.title || slugTitle,
        authors: [],
        org: 'openai',
        date: meta?.date || today,
        url,
        pdf_url: null, arxiv_id: null,
        abstract: meta?.desc || null,
        source: 'openai-site',
        venue: 'OpenAI Blog',
        cited_by: null,
      });
    }
    await sleep(800);
  }
  return out;
}

/* ---------- DeepMind: sitemap -> JSON-LD on new detail pages only ---------- */
async function deepmindRecent(knownUrls) {
  const xml = await fetchText('https://deepmind.google/sitemap.xml');
  if (!xml) return [];
  const urls = [...xml.matchAll(/<loc>(https:\/\/deepmind\.google\/research\/publications\/\d+\/?)<\/loc>/g)]
    .map((m) => m[1].replace(/\/$/, '') + '/');
  const fresh = urls.filter((u) => !knownUrls.has(u.replace(/\/$/, '')) && !knownUrls.has(u));
  const out = [];
  for (const u of fresh.slice(0, 40)) { // bound per-run fetches
    const html = await fetchText(u);
    await sleep(900);
    if (!html) continue;
    const ld = (html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/) || [])[1];
    let meta = null;
    try { meta = JSON.parse(ld); } catch (e) { /* ignore */ }
    if (!meta || !meta.headline) continue;
    const outLink = (html.match(/href="(https:\/\/arxiv\.org\/[^"]+|https?:\/\/[^"]+)"[^>]*>\s*(?:View publication|Download)/i) || [])[1] || null;
    const axv = extractArxivId(outLink);
    const venue = (html.match(/publication-venue__content[^>]*>\s*([^<]+)/) || [])[1]?.trim() || null;
    const authors = (html.match(/publication-authors__content[^>]*>\s*([^<]+)/) || [])[1]
      ?.split(/,\s*/).map((a) => a.trim()).filter(Boolean).slice(0, 12) || [];
    out.push({
      title: decode(meta.headline),
      authors,
      org: 'deepmind',
      date: (meta.datePublished || '').slice(0, 10) || today,
      url: axv ? `https://arxiv.org/abs/${axv}` : u,
      pdf_url: axv ? `https://arxiv.org/pdf/${axv}` : null,
      arxiv_id: axv,
      abstract: meta.description ? decode(String(meta.description)).replace(/\s+/g, ' ').trim() : null,
      source: 'deepmind-site',
      venue,
      cited_by: null,
    });
  }
  return out;
}

/* ---------- main ---------- */
const db = JSON.parse(readFileSync(DATA, 'utf8'));
const seen = new Set();
const knownUrls = new Set();
for (const p of db.papers) {
  if (p.arxiv_id) seen.add('axv:' + p.arxiv_id);
  seen.add('ttl:' + normTitle(p.title));
  seen.add('url:' + p.url);
  knownUrls.add(p.url.replace(/\/$/, ''));
}

const fetched = (await Promise.all([openalexRecent(), arxivRecent(), circuitsRecent(), alignmentBlogRecent(), openaiRecent(), deepmindRecent(knownUrls)])).flat();
const found = fetched.filter((p) => !isSpam(p));
console.log(`spam filtered: ${fetched.length - found.length}`);
let nextId = Math.max(0, ...db.papers.map((p) => p.id)) + 1;
let added = 0;

for (const p of found) {
  if (!p.title || !p.date || p.date > today) continue;
  const keys = ['ttl:' + normTitle(p.title), 'url:' + p.url];
  if (p.arxiv_id) keys.push('axv:' + p.arxiv_id);
  if (keys.some((k) => seen.has(k))) {
    // refresh citation counts on existing papers when OpenAlex reports more
    if (p.cited_by) {
      const existing = db.papers.find((e) => (p.arxiv_id && e.arxiv_id === p.arxiv_id) || normTitle(e.title) === normTitle(p.title));
      if (existing && (existing.cited_by || 0) < p.cited_by) existing.cited_by = p.cited_by;
    }
    continue;
  }
  keys.forEach((k) => seen.add(k));
  const text = `${p.title} ${p.abstract || ''}`;
  db.papers.push({
    id: nextId++,
    ...p,
    topics: tagTopics(text),
    summary: autoSummary(p.abstract) || null,
    sources: [p.source],
    kind: classifyKind({ ...p, sources: [p.source] }) || 'post',
  });
  added++;
}

db.papers.sort((a, b) => (a.date < b.date ? 1 : -1));
db.updated = today;
db.count = db.papers.length;
writeFileSync(DATA, JSON.stringify(db, null, 1));

const siteData = join(ROOT, 'docs', 'data');
if (!existsSync(siteData)) mkdirSync(siteData, { recursive: true });
copyFileSync(DATA, join(siteData, 'papers.json'));
console.log(`update: ${found.length} fetched, ${added} new, total ${db.count}`);
