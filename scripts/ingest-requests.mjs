/* Process user source-requests filed as GitHub issues (label: source-request).
   - arXiv link  -> add that single paper
   - listing URL -> register in data/sources.json (scraped every daily run)
                    and do an initial backfill scrape now
   Closes each processed issue with a report comment.
   Runs in CI with GITHUB_TOKEN; locally with a keychain/env token.
   Usage: node scripts/ingest-requests.mjs */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normTitle, extractArxivId, tagTopics, autoSummary, computeImportance, serializeDb, cleanText, classifyKind } from './lib.mjs';
import { scrapeListing } from './generic-source.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data', 'papers.json');
const SOURCES = join(ROOT, 'data', 'sources.json');
const REPO = process.env.GITHUB_REPOSITORY || 'michaelofengend/ai-papers';
const TOKEN = process.env.GITHUB_TOKEN;
if (!TOKEN) { console.log('no GITHUB_TOKEN — skipping source-request ingestion'); process.exit(0); }

const gh = async (path, opts = {}) => {
  const res = await fetch(`https://api.github.com${path}`, {
    ...opts,
    headers: { Authorization: `token ${TOKEN}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  return res.ok ? (res.status === 204 ? {} : await res.json()) : null;
};
const fetchText = async (u) => {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(u, { headers: { 'User-Agent': 'ai-papers-tracker (michaelofengend@gmail.com)' } });
      if (r.ok) return await r.text();
      if (r.status === 429 || r.status >= 500) { await new Promise((x) => setTimeout(x, 2500)); continue; }
      return null;
    } catch (e) { await new Promise((x) => setTimeout(x, 2000)); }
  }
  return null;
};

const issues = await gh(`/repos/${REPO}/issues?labels=source-request&state=open&per_page=20`);
if (!issues || !issues.length) { console.log('no open source requests'); process.exit(0); }

const db = JSON.parse(readFileSync(DATA, 'utf8'));
const sources = existsSync(SOURCES) ? JSON.parse(readFileSync(SOURCES, 'utf8')) : { sources: [] };
const seen = new Set();
const knownUrls = new Set();
for (const p of db.papers) {
  if (p.arxiv_id) seen.add('axv:' + p.arxiv_id);
  seen.add('ttl:' + normTitle(p.title));
  knownUrls.add((p.url || '').replace(/\/$/, ''));
}
let nextId = Math.max(0, ...db.papers.map((p) => p.id)) + 1;
const today = new Date().toISOString().slice(0, 10);
let dbDirty = false;

function addRecord(it, host, source) {
  if (!it.title || seen.has('ttl:' + normTitle(it.title))) return false;
  if (it.arxiv_id && seen.has('axv:' + it.arxiv_id)) return false;
  const text = `${it.title} ${it.abstract || ''}`;
  const rec = {
    id: nextId++,
    title: cleanText(it.title),
    authors: it.authors || [],
    org: /anthropic|openai|deepmind/.test(text.toLowerCase()) ? (text.toLowerCase().match(/anthropic|openai|deepmind/) || [])[0] : 'other',
    date: it.date && it.date <= today ? it.date : today,
    url: it.url,
    pdf_url: it.arxiv_id ? `https://arxiv.org/pdf/${it.arxiv_id}` : null,
    arxiv_id: it.arxiv_id || null,
    abstract: it.abstract ? cleanText(it.abstract).slice(0, 1200) : null,
    summary: autoSummary(it.abstract) || null,
    topics: tagTopics(text),
    venue: it.venue || host,
    cited_by: null,
    sources: [source],
    kind: 'paper',
  };
  const k = classifyKind({ ...rec, sources: [] });
  if (k === 'post') rec.kind = 'post';
  rec.importance = computeImportance(rec);
  db.papers.push(rec);
  seen.add('ttl:' + normTitle(rec.title));
  if (rec.arxiv_id) seen.add('axv:' + rec.arxiv_id);
  knownUrls.add(rec.url.replace(/\/$/, ''));
  dbDirty = true;
  return true;
}

for (const issue of issues) {
  try {
    const text = `${issue.title}\n${issue.body || ''}`;
    const url = (text.match(/https?:\/\/[^\s)>\]"']+/) || [])[0];
    let report;
    if (!url) {
      report = 'No URL found in this request — please file again with a link.';
    } else {
      const ax = extractArxivId(url);
      if (ax) {
        const page = await fetchText(`https://arxiv.org/abs/${ax}`);
        const title = cleanText((page?.match(/<h1 class="title[^"]*">(?:<span[^>]*>[^<]*<\/span>)?\s*([\s\S]*?)<\/h1>/) || [])[1] || '');
        const abstract = cleanText((page?.match(/<blockquote class="abstract[^"]*">[\s\S]*?<\/span>\s*([\s\S]*?)<\/blockquote>/) || [])[1] || '');
        const dl = (page?.match(/\[Submitted on (\d+) (\w{3})\w* (\d{4})/) || []);
        const M = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
        const date = dl.length ? `${dl[3]}-${M[dl[2]] || '01'}-${String(dl[1]).padStart(2, '0')}` : today;
        const added = title ? addRecord({ title, abstract, date, url: `https://arxiv.org/abs/${ax}`, arxiv_id: ax, venue: 'arXiv' }, 'arxiv.org', 'user-request') : false;
        report = added ? `Added [${title}](https://arxiv.org/abs/${ax}) to the tracker. It will appear on the site after the next data deploy.` : 'That paper is already in the tracker (or could not be parsed).';
      } else {
        const clean = url.replace(/\/$/, '');
        const host = new URL(clean).hostname.replace(/^www\./, '');
        const already = sources.sources.some((s) => s.url === clean);
        if (!already) sources.sources.push({ url: clean, host, added: today, via: `issue #${issue.number}` });
        const res = await scrapeListing(clean, fetchText, { cap: 60, knownUrls, sleepMs: 700 });
        let added = 0;
        for (const it of res.items) if (addRecord(it, host, `site:${host}`)) added++;
        for (const ax2 of res.arxivIds.slice(0, 20)) {
          if (seen.has('axv:' + ax2)) continue;
          const page = await fetchText(`https://arxiv.org/abs/${ax2}`);
          await new Promise((x) => setTimeout(x, 1500));
          const title = cleanText((page?.match(/<h1 class="title[^"]*">(?:<span[^>]*>[^<]*<\/span>)?\s*([\s\S]*?)<\/h1>/) || [])[1] || '');
          if (title) { if (addRecord({ title, date: today, url: `https://arxiv.org/abs/${ax2}`, arxiv_id: ax2, venue: 'arXiv' }, 'arxiv.org', `site:${host}`)) added++; }
        }
        report = `Registered **${host}** as a tracked source${already ? ' (was already registered)' : ''} — found ${res.totalCandidates} content pages, added ${added} new item(s) now. This source is scraped on every daily refresh from now on.`;
      }
    }
    await gh(`/repos/${REPO}/issues/${issue.number}/comments`, { method: 'POST', body: JSON.stringify({ body: `🤖 ${report}` }) });
    await gh(`/repos/${REPO}/issues/${issue.number}`, { method: 'PATCH', body: JSON.stringify({ state: 'closed' }) });
    console.log(`issue #${issue.number}: ${report.slice(0, 120)}`);
  } catch (e) {
    console.warn(`issue #${issue.number} failed: ${e.message}`);
  }
}

if (dbDirty) {
  db.papers.sort((a, b) => (a.date < b.date ? 1 : -1));
  db.updated = today;
  db.count = db.papers.length;
  writeFileSync(DATA, serializeDb(db));
}
writeFileSync(SOURCES, JSON.stringify(sources, null, 1));
console.log(`done — ${sources.sources.length} registered source(s), total ${db.count} papers`);
