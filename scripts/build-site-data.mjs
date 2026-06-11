/* Write the browser payload: data/papers.json -> docs/data/papers.json
   with abstracts truncated to keep the transfer small.
   Usage: node scripts/build-site-data.mjs */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const db = JSON.parse(readFileSync(join(ROOT, 'data', 'papers.json'), 'utf8'));

const slim = db.papers.map((p) => ({
  ...p,
  abstract: p.abstract && p.abstract.length > 700 ? p.abstract.slice(0, 697).trimEnd() + '…' : p.abstract,
}));

const out = join(ROOT, 'docs', 'data');
if (!existsSync(out)) mkdirSync(out, { recursive: true });
const json = JSON.stringify({ updated: db.updated, count: slim.length, papers: slim });
writeFileSync(join(out, 'papers.json'), json);
const tl = join(ROOT, 'data', 'timeline.json');
if (existsSync(tl)) writeFileSync(join(out, 'timeline.json'), readFileSync(tl, 'utf8'));
console.log(`docs/data/papers.json: ${slim.length} papers, ${(json.length / 1e6).toFixed(2)} MB`);
