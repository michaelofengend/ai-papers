/* Add one or more arXiv papers to the dataset by id.
   Usage: node scripts/add-paper.mjs 2310.02226 [2401.12345 ...] */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normTitle, tagTopics, autoSummary, computeImportance, serializeDb } from './lib.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data', 'papers.json');
const ids = process.argv.slice(2).map((s) => (s.match(/(\d{4}\.\d{4,5})/) || [])[1]).filter(Boolean);
if (!ids.length) { console.error('usage: node scripts/add-paper.mjs <arxiv-id> [...]'); process.exit(1); }

const dec = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const MONTHS = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
const ORG_RE = { anthropic: /\banthropic\b/i, openai: /\bopenai\b/i, deepmind: /deepmind/i };

async function fetchPaper(id) {
  const res = await fetch(`https://arxiv.org/abs/${id}`, { headers: { 'User-Agent': 'ai-papers-tracker (michaelofengend@gmail.com)' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${id}`);
  const h = await res.text();
  const title = dec((h.match(/<h1 class="title[^"]*">(?:<span[^>]*>[^<]*<\/span>)?\s*([\s\S]*?)<\/h1>/) || [])[1] || '').replace(/<[^>]+>/g, '').trim();
  const abstract = dec((h.match(/<blockquote class="abstract[^"]*">[\s\S]*?<\/span>\s*([\s\S]*?)<\/blockquote>/) || [])[1] || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const authors = [...h.matchAll(/searchtype=author[^>]*>([^<]+)</g)].map((m) => dec(m[1]).trim()).slice(0, 12);
  const dl = (h.match(/\[Submitted on (\d+) (\w+) (\d{4})/) || []);
  const date = dl.length ? `${dl[3]}-${MONTHS[dl[2].slice(0, 3)] || '01'}-${String(dl[1]).padStart(2, '0')}` : null;
  if (!title || !date) throw new Error(`could not parse ${id}`);
  let org = 'other';
  for (const [o, re] of Object.entries(ORG_RE)) if (re.test(abstract) || re.test(h.slice(0, 4000))) { org = o; break; }
  return { title, abstract, authors, date, org };
}

const db = JSON.parse(readFileSync(DATA, 'utf8'));
const seen = new Set(db.papers.flatMap((p) => [p.arxiv_id && 'axv:' + p.arxiv_id, 'ttl:' + normTitle(p.title)].filter(Boolean)));
let nextId = Math.max(0, ...db.papers.map((p) => p.id)) + 1;
let added = 0;

for (const id of ids) {
  if (seen.has('axv:' + id)) { console.log(`skip ${id}: already present`); continue; }
  const m = await fetchPaper(id);
  if (seen.has('ttl:' + normTitle(m.title))) { console.log(`skip ${id}: title already present`); continue; }
  const rec = {
    id: nextId++,
    title: m.title,
    authors: m.authors,
    org: m.org,
    date: m.date,
    url: `https://arxiv.org/abs/${id}`,
    pdf_url: `https://arxiv.org/pdf/${id}`,
    arxiv_id: id,
    abstract: m.abstract.slice(0, 1500),
    summary: autoSummary(m.abstract),
    topics: tagTopics(`${m.title} ${m.abstract}`),
    venue: 'arXiv',
    cited_by: null,
    sources: ['manual'],
    kind: 'paper',
  };
  rec.importance = computeImportance(rec);
  db.papers.push(rec);
  seen.add('axv:' + id); seen.add('ttl:' + normTitle(m.title));
  added++;
  console.log(`added ${id}: ${m.title.slice(0, 70)} [${m.org}] ${m.date}`);
  await new Promise((r) => setTimeout(r, 1500));
}

if (added) {
  db.papers.sort((a, b) => (a.date < b.date ? 1 : -1));
  db.count = db.papers.length;
  writeFileSync(DATA, serializeDb(db));
}
console.log(`total: ${db.count}`);
