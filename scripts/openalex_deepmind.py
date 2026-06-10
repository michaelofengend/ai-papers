#!/usr/bin/env python3
"""Collect Google DeepMind works from OpenAlex via cursor pagination (curl fetches)."""
import json
import re
import subprocess
import sys
import time
import urllib.parse

INST_ID = "I4210090411"  # Google DeepMind (United Kingdom) — only DeepMind record in OpenAlex
MAILTO = "michaelofengend@gmail.com"
OUT = "/Users/michaelofengenden/Desktop/ResearchPubs/data/raw/openalex-deepmind.json"
SKIP_TYPES = {"paratext", "erratum", "editorial"}
ARXIV_RE = re.compile(r"arxiv\.org/(?:abs|pdf)/([0-9]{4}\.[0-9]{4,5})(?:v[0-9]+)?", re.I)

SELECT = ",".join([
    "id", "doi", "title", "display_name", "publication_date", "type",
    "authorships", "primary_location", "best_oa_location", "locations",
    "abstract_inverted_index", "cited_by_count", "is_paratext",
])


def fetch(url):
    for attempt in range(4):
        p = subprocess.run(["curl", "-sS", "--max-time", "90", url],
                           capture_output=True, text=True)
        if p.returncode == 0 and p.stdout.strip():
            try:
                return json.loads(p.stdout)
            except json.JSONDecodeError:
                pass
        time.sleep(3 * (attempt + 1))
    raise RuntimeError(f"failed to fetch {url}: {p.stderr[:200]}")


def reconstruct_abstract(inv):
    if not inv:
        return None
    pos = {}
    for word, idxs in inv.items():
        for i in idxs:
            pos[i] = word
    if not pos:
        return None
    text = " ".join(pos[i] for i in sorted(pos))
    return text.strip() or None


def arxiv_from_locations(work):
    locs = []
    if work.get("primary_location"):
        locs.append(work["primary_location"])
    locs.extend(work.get("locations") or [])
    if work.get("best_oa_location"):
        locs.append(work["best_oa_location"])
    for loc in locs:
        if not loc:
            continue
        src = loc.get("source") or {}
        urls = [loc.get("landing_page_url") or "", loc.get("pdf_url") or ""]
        is_arxiv_src = (src.get("id") == "https://openalex.org/S4306400194"
                        or (src.get("display_name") or "").lower() == "arxiv")
        for u in urls:
            m = ARXIV_RE.search(u)
            if m:
                return m.group(1)
        if is_arxiv_src:
            # arXiv source but no parseable URL; try the work's ids
            pass
    ids = work.get("ids") or {}
    m = ARXIV_RE.search(ids.get("arxiv", "") or "")
    return m.group(1) if m else None


def norm_title(t):
    return re.sub(r"[^a-z0-9]+", "", (t or "").lower())


def main():
    base = "https://api.openalex.org/works"
    params = {
        "filter": f"authorships.institutions.lineage:{INST_ID},from_publication_date:2019-01-01",
        "per-page": "200",
        "select": SELECT,
        "mailto": MAILTO,
    }
    cursor = "*"
    papers = []
    seen_doi = set()
    seen_title = set()
    skipped_type = 0
    dup = 0
    page = 0

    while cursor:
        q = dict(params)
        q["cursor"] = cursor
        url = base + "?" + urllib.parse.urlencode(q)
        data = fetch(url)
        page += 1
        results = data.get("results", [])
        cursor = (data.get("meta") or {}).get("next_cursor")
        for w in results:
            if (w.get("type") or "") in SKIP_TYPES or w.get("is_paratext"):
                skipped_type += 1
                continue
            title = w.get("title") or w.get("display_name")
            if not title:
                skipped_type += 1
                continue
            doi = (w.get("doi") or "").lower().replace("https://doi.org/", "").strip() or None
            nt = norm_title(title)
            if (doi and doi in seen_doi) or (nt and nt in seen_title):
                dup += 1
                continue
            if doi:
                seen_doi.add(doi)
            if nt:
                seen_title.add(nt)

            names = []
            for a in (w.get("authorships") or []):
                n = a.get("raw_author_name") or (a.get("author") or {}).get("display_name")
                if n:
                    names.append(n)
            if len(names) > 12:
                names = names[:12] + ["et al."]

            arxiv_id = arxiv_from_locations(w)
            ploc = w.get("primary_location") or {}
            boa = w.get("best_oa_location") or {}
            landing = ploc.get("landing_page_url")
            if arxiv_id:
                url_canon = f"https://arxiv.org/abs/{arxiv_id}"
            elif landing:
                url_canon = landing
            elif w.get("doi"):
                url_canon = w["doi"]
            else:
                url_canon = w.get("id")

            pdf_url = ploc.get("pdf_url") or boa.get("pdf_url")
            if not pdf_url and arxiv_id:
                pdf_url = f"https://arxiv.org/pdf/{arxiv_id}"

            src = ploc.get("source") or {}
            venue = src.get("display_name")
            if not venue and arxiv_id:
                venue = "arXiv"

            papers.append({
                "title": title,
                "authors": names,
                "org": "deepmind",
                "date": w.get("publication_date"),
                "url": url_canon,
                "pdf_url": pdf_url,
                "arxiv_id": arxiv_id,
                "abstract": reconstruct_abstract(w.get("abstract_inverted_index")),
                "source": "openalex",
                "venue": venue,
                "cited_by": w.get("cited_by_count"),
            })
        print(f"page {page}: +{len(results)} (kept {len(papers)}, skipped {skipped_type}, dup {dup})",
              flush=True)
        if not results:
            break
        time.sleep(1)

    papers.sort(key=lambda p: p["date"] or "", reverse=True)
    with open(OUT, "w") as f:
        json.dump(papers, f, ensure_ascii=False, indent=1)
    dates = [p["date"] for p in papers if p["date"]]
    print(json.dumps({
        "count": len(papers),
        "earliest": min(dates) if dates else None,
        "latest": max(dates) if dates else None,
        "skipped_type_or_untitled": skipped_type,
        "deduped": dup,
        "pages": page,
    }))


if __name__ == "__main__":
    main()
