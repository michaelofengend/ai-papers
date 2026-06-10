/* Apply data/enriched/batch-*.json (agent output) back onto data/papers.json.
   Usage: node scripts/apply-enrichment.mjs */
import { readdirSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOPICS } from './lib.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENRICHED = join(ROOT, 'data', 'enriched');
const DATA = join(ROOT, 'data', 'papers.json');

const db = JSON.parse(readFileSync(DATA, 'utf8'));
const byId = new Map(db.papers.map((p) => [p.id, p]));
const valid = new Set(TOPICS);

let applied = 0, badTopic = 0, missing = 0;
for (const f of readdirSync(ENRICHED).filter((f) => f.endsWith('.json')).sort()) {
  let arr;
  try { arr = JSON.parse(readFileSync(join(ENRICHED, f), 'utf8')); }
  catch (e) { console.warn(`skip ${f}: ${e.message}`); continue; }
  if (!Array.isArray(arr)) arr = arr.items || [];
  for (const e of arr) {
    const p = byId.get(e.id);
    if (!p) { missing++; continue; }
    if (e.summary && e.summary.length > 30) p.summary = String(e.summary).replace(/\s+/g, ' ').trim();
    if (Array.isArray(e.topics)) {
      const t = e.topics.filter((x) => valid.has(x)).slice(0, 3);
      if (t.length) p.topics = t; else badTopic++;
    }
    if (e.abstract && (!p.abstract || p.abstract.length < 120)) p.abstract = String(e.abstract).slice(0, 2000);
    applied++;
  }
}

db.updated = new Date().toISOString().slice(0, 10);
writeFileSync(DATA, JSON.stringify(db, null, 1));
const siteData = join(ROOT, 'docs', 'data');
if (!existsSync(siteData)) mkdirSync(siteData, { recursive: true });
copyFileSync(DATA, join(siteData, 'papers.json'));
console.log(`applied ${applied} enrichments (${badTopic} invalid-topic sets dropped, ${missing} unknown ids)`);
console.log(`still missing summary: ${db.papers.filter((p) => !p.summary).length}`);
