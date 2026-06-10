/* Merge data/raw/*.json into data/papers.json: normalize, dedupe, tag.
   Usage: node scripts/merge.mjs */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normTitle, extractArxivId, mergeRecords, tagTopics, autoSummary } from './lib.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RAW = join(ROOT, 'data', 'raw');
const OUT = join(ROOT, 'data', 'papers.json');

const MIN_DATE = '2014-01-01';
const today = new Date().toISOString().slice(0, 10);

let all = [];
for (const f of readdirSync(RAW).filter((f) => f.endsWith('.json'))) {
  try {
    const arr = JSON.parse(readFileSync(join(RAW, f), 'utf8'));
    if (!Array.isArray(arr)) { console.warn(`skip ${f}: not an array`); continue; }
    console.log(`${f}: ${arr.length}`);
    all = all.concat(arr.map((p) => ({ ...p, _file: f })));
  } catch (e) {
    console.warn(`skip ${f}: ${e.message}`);
  }
}

/* spam filter: OpenAlex carries AI-generated podcast/software-release records
   falsely affiliated to the labs (Zenodo/Figshare/Open MIND pollution) */
const SPAM_URL = /zenodo\.org|figshare|myweirdprompts\.com|osf\.io/i;
const SPAM_VENUE = /^(open mind|zenodo|figshare)/i;
const SPAM_AUTHOR = /chatterbox|^(claude|gemini|chatgpt|gpt)[ ,-]|\((flash|pro|mini)\)|^rosehill, daniel/i;
function isSpam(p) {
  if (SPAM_URL.test(p.url || '') || SPAM_URL.test(p.pdf_url || '')) return true;
  if (SPAM_VENUE.test(p.venue || '')) return true;
  const authors = Array.isArray(p.authors) ? p.authors : [];
  if (authors.some((a) => SPAM_AUTHOR.test(String(a)))) return true;
  return false;
}

/* normalize */
const cleaned = [];
let spam = 0;
for (const p of all) {
  if (!p || !p.title || String(p.title).trim().length < 4) continue;
  if (isSpam(p)) { spam++; continue; }
  let date = String(p.date || '').slice(0, 10);
  if (/^\d{4}-\d{2}$/.test(date)) date = date + '-01';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
  if (date < MIN_DATE || date > today) continue;
  let authors = p.authors;
  if (typeof authors === 'string') authors = authors.split(/,\s*|\sand\s/).filter(Boolean);
  if (!Array.isArray(authors)) authors = [];
  authors = authors.map((a) => String(a).trim()).filter((a) => a && a.length < 60).slice(0, 12);
  const url = String(p.url || '').trim();
  if (!/^https?:\/\//.test(url)) continue;
  const arxiv_id = p.arxiv_id || extractArxivId(url) || extractArxivId(p.pdf_url);
  cleaned.push({
    title: String(p.title).replace(/\s+/g, ' ').trim(),
    authors,
    org: ['anthropic', 'openai', 'deepmind'].includes(p.org) ? p.org : 'other',
    date,
    url,
    pdf_url: p.pdf_url || (arxiv_id ? `https://arxiv.org/pdf/${arxiv_id}` : null),
    arxiv_id,
    abstract: p.abstract ? String(p.abstract).replace(/\s+/g, ' ').trim() : null,
    summary: p.summary || null,
    topics: Array.isArray(p.topics) ? p.topics : [],
    source: p.source || p._file.replace(/\.json$/, ''),
    venue: p.venue || null,
    cited_by: Number.isFinite(p.cited_by) ? p.cited_by : null,
  });
}

/* dedupe: arxiv id first, then normalized title */
const byKey = new Map();
for (const p of cleaned) {
  const keys = [];
  if (p.arxiv_id) keys.push('axv:' + p.arxiv_id);
  keys.push('ttl:' + normTitle(p.title));
  let existingKey = keys.find((k) => byKey.has(k));
  if (existingKey) {
    const merged = mergeRecords(byKey.get(existingKey), p);
    for (const k of [...keys, ...(byKey.get(existingKey)._keys || [])]) {
      merged._keys = [...new Set([...(merged._keys || []), k])];
      byKey.set(k, merged);
    }
  } else {
    p._keys = keys;
    p.sources = [p.source];
    for (const k of keys) byKey.set(k, p);
  }
}
const unique = [...new Set(byKey.values())];

/* finalize */
const papers = unique.map((p, i) => {
  const { _keys, _file, source, ...rest } = p;
  const text = `${p.title} ${p.abstract || ''} ${p.venue || ''}`;
  return {
    id: i,
    ...rest,
    topics: rest.topics.length ? rest.topics : tagTopics(text),
    summary: rest.summary || autoSummary(rest.abstract),
  };
}).sort((a, b) => (a.date < b.date ? 1 : -1));

writeFileSync(OUT, JSON.stringify({ updated: today, count: papers.length, papers }, null, 1));
console.log(`\nmerged: ${all.length} raw (${spam} spam dropped) -> ${papers.length} unique papers -> ${OUT}`);
const byOrg = {};
for (const p of papers) byOrg[p.org] = (byOrg[p.org] || 0) + 1;
console.log('by org:', byOrg);
console.log('missing summary:', papers.filter((p) => !p.summary).length);
console.log('missing topics (Other only):', papers.filter((p) => p.topics.length === 1 && p.topics[0] === 'Other').length);
