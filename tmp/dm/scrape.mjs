#!/usr/bin/env node
// Scrape DeepMind publication detail pages listed in urls.txt -> NDJSON
import { readFileSync, appendFileSync, existsSync } from 'node:fs';

const URLS_FILE = '/Users/michaelofengenden/Desktop/ResearchPubs/tmp/dm/urls.txt';
const OUT_NDJSON = '/Users/michaelofengenden/Desktop/ResearchPubs/tmp/dm/pubs.ndjson';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function decodeEntities(s) {
  if (s == null) return s;
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .trim();
}

function stripTags(s) {
  return decodeEntities(s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' '));
}

function parsePage(html, pageUrl) {
  const rec = {
    title: null, authors: [], org: 'deepmind', date: null,
    url: pageUrl, pdf_url: null, arxiv_id: null, abstract: null,
    source: 'deepmind-site', venue: null, cited_by: null,
  };

  // JSON-LD ScholarlyArticle
  const ldRe = /<script type="?application\/ld\+json"?>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = ldRe.exec(html)) !== null) {
    try {
      const d = JSON.parse(m[1]);
      if (d['@type'] === 'ScholarlyArticle') {
        rec.title = d.headline || null;
        if (d.datePublished) rec.date = d.datePublished.slice(0, 10);
        const desc = d.mainEntityOfPage?.description || d.description || null;
        if (desc) rec.abstract = desc.trim();
        break;
      }
    } catch {}
  }

  // Fallback title from <h1>
  if (!rec.title) {
    const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
    if (h1) rec.title = stripTags(h1[1]);
  }

  // Authors
  const am = html.match(/publication-authors__content[^>]*>([\s\S]*?)<\/div>/);
  if (am) {
    const txt = stripTags(am[1]);
    let names = txt.split(/,\s*(?:and\s+)?/).map((s) => s.trim()).filter(Boolean);
    // handle "A and B" in last element
    if (names.length && / and /.test(names[names.length - 1]) && names[names.length - 1].length < 80) {
      const last = names.pop();
      names.push(...last.split(/\s+and\s+/).map((s) => s.trim()).filter(Boolean));
    }
    names = names.filter((n) => !/^et\.? al\.?$/i.test(n));
    const hadEtAl = /et\.? al\.?\s*$/i.test(txt);
    if (names.length > 12) { names = names.slice(0, 12); names.push('et al.'); }
    else if (hadEtAl) names.push('et al.');
    rec.authors = names;
  }

  // Venue
  const vm = html.match(/publication-venue__content[^>]*>([\s\S]*?)<\/div>/);
  if (vm) {
    const v = stripTags(vm[1]);
    if (v) rec.venue = v;
  }

  // External "View publication" link
  const ext = html.match(/data-event-content-name="?View publication"?[^>]*href=("([^"]+)"|([^\s>]+))/);
  let extUrl = ext ? decodeEntities(ext[2] || ext[3]) : null;
  // Download link (pdf)
  const dl = html.match(/data-event-content-name="?Download"?[^>]*href=("([^"]+)"|([^\s>]+))/);
  let dlUrl = dl ? decodeEntities(dl[2] || dl[3]) : null;

  // arXiv detection
  const probe = `${extUrl || ''} ${dlUrl || ''}`;
  const ax = probe.match(/arxiv\.org\/(?:abs|pdf)\/([0-9]{4}\.[0-9]{4,5})(?:v\d+)?/i);
  if (ax) {
    rec.arxiv_id = ax[1];
    rec.url = `https://arxiv.org/abs/${ax[1]}`;
    rec.pdf_url = `https://arxiv.org/pdf/${ax[1]}`;
  } else {
    if (extUrl) rec.url = extUrl;
    if (dlUrl && /\.pdf(\?|$)/i.test(dlUrl)) rec.pdf_url = dlUrl;
    else if (dlUrl && /openreview\.net\/pdf|\/pdf\//i.test(dlUrl)) rec.pdf_url = dlUrl;
  }

  if (rec.title) rec.title = decodeEntities(rec.title);
  if (rec.abstract) rec.abstract = decodeEntities(rec.abstract);
  return rec;
}

async function fetchPage(url) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html' } });
      if (res.ok) return await res.text();
      console.error(`HTTP ${res.status} for ${url} (attempt ${attempt})`);
    } catch (e) {
      console.error(`fetch error for ${url}: ${e.message} (attempt ${attempt})`);
    }
    await sleep(2000 * attempt);
  }
  return null;
}

const urls = readFileSync(URLS_FILE, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
const done = new Set();
if (existsSync(OUT_NDJSON)) {
  for (const line of readFileSync(OUT_NDJSON, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { done.add(JSON.parse(line)._page); } catch {}
  }
}

let i = 0;
for (const url of urls) {
  i++;
  if (done.has(url)) continue;
  const html = await fetchPage(url);
  if (html === null) {
    appendFileSync(OUT_NDJSON, JSON.stringify({ _page: url, _error: 'fetch_failed' }) + '\n');
  } else {
    const rec = parsePage(html, url);
    rec._page = url;
    appendFileSync(OUT_NDJSON, JSON.stringify(rec) + '\n');
  }
  if (i % 25 === 0) console.log(`progress: ${i}/${urls.length}`);
  await sleep(900);
}
console.log('DONE');
