/* Split papers into enrichment batches for summary/topic generation.
   Usage: node scripts/make-batches.mjs [batchSize] */
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BATCH_DIR = join(ROOT, 'data', 'enrich');
const SIZE = Number(process.argv[2]) || 25;

const db = JSON.parse(readFileSync(join(ROOT, 'data', 'papers.json'), 'utf8'));

if (existsSync(BATCH_DIR)) rmSync(BATCH_DIR, { recursive: true });
mkdirSync(BATCH_DIR, { recursive: true });
mkdirSync(join(ROOT, 'data', 'enriched'), { recursive: true });

/* Everything gets an LLM pass: papers with abstracts get condensed; those
   without get flagged so the agent fetches the page. */
const items = db.papers.map((p) => ({
  id: p.id,
  title: p.title,
  org: p.org,
  date: p.date,
  venue: p.venue,
  url: p.url,
  abstract: p.abstract ? p.abstract.slice(0, 1500) : null,
  needs_fetch: !p.abstract || p.abstract.length < 120,
}));

let n = 0;
for (let i = 0; i < items.length; i += SIZE) {
  writeFileSync(join(BATCH_DIR, `batch-${String(n).padStart(3, '0')}.json`), JSON.stringify(items.slice(i, i + SIZE), null, 1));
  n++;
}
console.log(`${items.length} papers -> ${n} batches of ${SIZE} in ${BATCH_DIR}`);
console.log(`needs_fetch: ${items.filter((i) => i.needs_fetch).length}`);
