/* Generic listing-page scraper for user-submitted sources.
   Strategy: harvest links from the page HTML; if the page is JS-rendered and
   yields nothing, fall back to the site's sitemap.xml filtered to the
   submitted path prefix. Detail pages give og:title/description/date. */
import { cleanText, extractArxivId } from './lib.mjs';

const ASSET_RE = /\.(png|jpe?g|gif|svg|css|js|ico|pdf|zip|xml|webp|mp4)(\?|$)/i;
const LANG_RE = /^\/(es|zh|zh-hans|fr|de|ja|ko|ru|pt)([/-]|$)/i;

function absolutize(href, baseUrl) {
  try { return new URL(href, baseUrl).href.split('#')[0]; } catch (e) { return null; }
}

function meta(html, name) {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]+content=["']([^"']+)["']`, 'i');
  const re2 = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${name}["']`, 'i');
  return (html.match(re) || html.match(re2) || [])[1] || null;
}

function pageDate(html, fallback) {
  const d = meta(html, 'article:published_time') || meta(html, 'og:article:published_time')
    || (html.match(/<time[^>]+datetime=["']([^"']+)["']/i) || [])[1]
    || meta(html, 'date') || fallback;
  if (!d) return null;
  const iso = String(d).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : null;
}

async function sitemapUrls(origin, prefix, fetchText, depth = 0) {
  if (depth > 1) return [];
  const xml = await fetchText(`${origin}/sitemap.xml`);
  if (!xml) return [];
  const out = [];
  // sitemap index?
  const subs = [...xml.matchAll(/<sitemap>\s*<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim()).slice(0, 5);
  for (const m of xml.matchAll(/<url>\s*<loc>([^<]+)<\/loc>(?:\s*<lastmod>([^<]+)<\/lastmod>)?/g)) {
    const loc = m[1].trim().split('#')[0];
    if (loc.startsWith(origin + prefix)) out.push({ url: loc, lastmod: m[2] ? m[2].slice(0, 10) : null });
  }
  for (const sub of subs) {
    const sx = await fetchText(sub);
    if (!sx) continue;
    for (const m of sx.matchAll(/<url>\s*<loc>([^<]+)<\/loc>(?:\s*<lastmod>([^<]+)<\/lastmod>)?/g)) {
      const loc = m[1].trim().split('#')[0];
      if (loc.startsWith(origin + prefix)) out.push({ url: loc, lastmod: m[2] ? m[2].slice(0, 10) : null });
    }
  }
  return out;
}

/* Returns { items: [{title, date, url, abstract, arxiv_id}], skipped } */
export async function scrapeListing(listUrl, fetchText, { cap = 30, knownUrls = new Set(), sleepMs = 700 } = {}) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const u = new URL(listUrl);
  const origin = u.origin;
  let prefix = u.pathname.replace(/\/$/, '');
  if (!prefix) prefix = '';

  const candidates = new Map(); // url -> {lastmod}
  const arxivIds = new Set();

  const html = await fetchText(listUrl);
  if (html) {
    for (const m of html.matchAll(/<a[^>]+href=["']([^"']+)["']/g)) {
      const abs = absolutize(m[1], listUrl);
      if (!abs) continue;
      const ax = extractArxivId(abs);
      if (ax) { arxivIds.add(ax); continue; }
      if (!abs.startsWith(origin)) continue;
      const path = new URL(abs).pathname;
      if (ASSET_RE.test(path) || LANG_RE.test(path)) continue;
      if (!path.replace(/\/$/, '').startsWith(prefix) || path.replace(/\/$/, '') === prefix) continue;
      candidates.set(abs.replace(/\/$/, ''), { lastmod: null });
    }
  }
  // JS-rendered listing or sparse links -> sitemap fallback (also augments)
  if (candidates.size < 3) {
    for (const { url, lastmod } of await sitemapUrls(origin, prefix, fetchText)) {
      const clean = url.replace(/\/$/, '');
      if (LANG_RE.test(new URL(clean).pathname)) continue;
      if (clean === origin + prefix) continue;
      if (!candidates.has(clean)) candidates.set(clean, { lastmod });
    }
  }
  // submitted section may itself be a JS aggregator of other sections (e.g.
  // metr.org/research aggregates /blog/ and /evaluations/) -> whole-site
  // sitemap with content heuristics
  if (candidates.size < 3) {
    const NONCONTENT = /\/(about|careers?|team|privacy|terms|contact|donate|jobs|hiring|press|brand|imprint|legal|search|tags?|categories)(\/|$)/i;
    for (const { url, lastmod } of await sitemapUrls(origin, '', fetchText)) {
      const clean = url.replace(/\/$/, '');
      const path = new URL(clean).pathname;
      if (LANG_RE.test(path) || NONCONTENT.test(path) || ASSET_RE.test(path)) continue;
      const depth = path.split('/').filter(Boolean).length;
      const contentish = /\/(blog|research|publications?|evaluations?|posts?|news|writing|reports?|papers?)\//i.test(path) || /\d{4}/.test(path);
      if (depth >= 2 && contentish && !candidates.has(clean)) candidates.set(clean, { lastmod });
    }
  }

  const fresh = [...candidates.entries()].filter(([url]) => !knownUrls.has(url) && !knownUrls.has(url + '/'));
  const items = [];
  for (const [url, info] of fresh.slice(0, cap)) {
    const page = await fetchText(url);
    await sleep(sleepMs);
    if (!page) continue;
    const rawTitle = meta(page, 'og:title') || (page.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
    const title = cleanText(rawTitle.split(/\s*[|•·]\s*|\s+[—–-]\s+(?=[A-Z][a-z]+(\s|$))/)[0] || rawTitle);
    if (!title || title.length < 8) continue;
    const desc = cleanText(meta(page, 'og:description') || meta(page, 'description') || '');
    const date = pageDate(page, info.lastmod) || info.lastmod;
    const ax = extractArxivId((page.match(/href=["'](https?:\/\/arxiv\.org\/(?:abs|pdf)\/\d{4}\.\d{4,5})["']/) || [])[1]);
    items.push({ title, date: date || null, url, abstract: desc || null, arxiv_id: ax || null });
  }
  return { items, arxivIds: [...arxivIds], totalCandidates: candidates.size };
}
