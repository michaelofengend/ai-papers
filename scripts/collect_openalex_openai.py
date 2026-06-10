#!/usr/bin/env python3
"""Collect OpenAI works from the OpenAlex API into the standard paper schema."""
import json
import re
import subprocess
import sys
import time
import urllib.parse

INST_ID = "I4210161460"
MAILTO = "michaelofengend@gmail.com"
OUT = "/Users/michaelofengenden/Desktop/ResearchPubs/data/raw/openalex-openai.json"
SKIP_TYPES = {"paratext", "erratum", "editorial"}

BASE = "https://api.openalex.org/works"


def fetch(url):
    for attempt in range(4):
        r = subprocess.run(["curl", "-s", "--max-time", "60", url],
                           capture_output=True, text=True)
        if r.returncode == 0 and r.stdout.strip():
            try:
                return json.loads(r.stdout)
            except json.JSONDecodeError:
                pass
        time.sleep(3 * (attempt + 1))
    raise RuntimeError(f"failed to fetch {url}")


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
    text = re.sub(r"\s+", " ", text).strip()
    return text or None


ARXIV_RE = re.compile(r"arxiv\.org/(?:abs|pdf)/([0-9]{4}\.[0-9]{4,5})(v\d+)?", re.I)


def extract_arxiv(work):
    """Return (arxiv_id, abs_url, pdf_url) from any location pointing at arXiv."""
    arxiv_id = abs_url = pdf_url = None
    locs = [l for l in (work.get("locations") or []) if l]
    for loc in locs:
        src = loc.get("source") or {}
        lp = loc.get("landing_page_url") or ""
        pdf = loc.get("pdf_url") or ""
        is_arxiv_src = (src.get("id") == "https://openalex.org/S4306400194"
                        or (src.get("display_name") or "").lower() == "arxiv")
        m = ARXIV_RE.search(lp) or ARXIV_RE.search(pdf)
        if is_arxiv_src or m:
            if m and not arxiv_id:
                arxiv_id = m.group(1)
            if not abs_url and lp:
                abs_url = lp
            if not pdf_url and pdf:
                pdf_url = pdf
    # also check the work-level ids / doi for arxiv-style DOIs (10.48550/arxiv.XXXX)
    doi = work.get("doi") or ""
    m = re.search(r"10\.48550/arxiv\.([0-9]{4}\.[0-9]{4,5})", doi, re.I)
    if m and not arxiv_id:
        arxiv_id = m.group(1)
    if arxiv_id:
        abs_url = f"https://arxiv.org/abs/{arxiv_id}"
        if not pdf_url:
            pdf_url = f"https://arxiv.org/pdf/{arxiv_id}"
    return arxiv_id, abs_url, pdf_url


def norm_title(t):
    return re.sub(r"[^a-z0-9]+", "", (t or "").lower())


def main():
    import os
    cache = "/tmp/openalex_openai_raw.json"
    if os.path.exists(cache):
        raw_works = json.load(open(cache))
        pages = 0
        print(f"loaded {len(raw_works)} works from cache", file=sys.stderr)
        process(raw_works, pages)
        return
    cursor = "*"
    raw_works = []
    pages = 0
    while cursor:
        params = {
            "filter": f"authorships.institutions.lineage:{INST_ID},from_publication_date:2019-01-01",
            "per-page": "200",
            "cursor": cursor,
            "mailto": MAILTO,
        }
        url = BASE + "?" + urllib.parse.urlencode(params)
        data = fetch(url)
        results = data.get("results", [])
        raw_works.extend(results)
        pages += 1
        cursor = (data.get("meta") or {}).get("next_cursor")
        count = (data.get("meta") or {}).get("count")
        print(f"page {pages}: got {len(results)} (total so far {len(raw_works)} / {count})",
              file=sys.stderr)
        if not results:
            break
        time.sleep(1)
    process(raw_works, pages)


def process(raw_works, pages):
    papers = []
    seen_doi = set()
    seen_title = set()
    skipped_type = 0
    skipped_dupe = 0
    skipped_notitle = 0

    for w in raw_works:
        wtype = w.get("type")
        if wtype in SKIP_TYPES:
            skipped_type += 1
            continue
        title = (w.get("title") or w.get("display_name") or "").strip()
        if not title:
            skipped_notitle += 1
            continue

        doi = (w.get("doi") or "").lower().replace("https://doi.org/", "").strip() or None
        nt = norm_title(title)
        if doi and doi in seen_doi:
            skipped_dupe += 1
            continue
        if nt and nt in seen_title:
            skipped_dupe += 1
            continue
        if doi:
            seen_doi.add(doi)
        if nt:
            seen_title.add(nt)

        # authors
        names = []
        for a in (w.get("authorships") or []):
            n = a.get("raw_author_name") or (a.get("author") or {}).get("display_name")
            if n:
                names.append(n.strip())
        if len(names) > 12:
            names = names[:12] + ["et al."]

        # date
        date = w.get("publication_date")
        if not date and w.get("publication_year"):
            date = f"{w['publication_year']}-01-01"

        # arxiv / urls
        arxiv_id, arxiv_abs, arxiv_pdf = extract_arxiv(w)
        prim = w.get("primary_location") or {}
        landing = prim.get("landing_page_url")
        prim_pdf = prim.get("pdf_url")

        if arxiv_id:
            url = arxiv_abs
            pdf_url = arxiv_pdf
        else:
            url = landing or (w.get("doi")) or w.get("id")
            pdf_url = prim_pdf
        # never use a pdf link as the canonical url if avoidable
        if url and url.endswith(".pdf") and landing and not landing.endswith(".pdf"):
            url = landing

        # venue
        venue = None
        src = prim.get("source") or {}
        if src.get("display_name"):
            venue = src["display_name"]
        elif arxiv_id:
            venue = "arXiv"

        papers.append({
            "title": title,
            "authors": names,
            "org": "openai",
            "date": date,
            "url": url,
            "pdf_url": pdf_url,
            "arxiv_id": arxiv_id,
            "abstract": reconstruct_abstract(w.get("abstract_inverted_index")),
            "source": "openalex",
            "venue": venue,
            "cited_by": w.get("cited_by_count"),
        })

    papers.sort(key=lambda p: p["date"] or "", reverse=True)
    with open(OUT, "w") as f:
        json.dump(papers, f, indent=2, ensure_ascii=False)

    dates = sorted(p["date"] for p in papers if p["date"])
    stats = {
        "pages": pages,
        "raw": len(raw_works),
        "kept": len(papers),
        "skipped_type": skipped_type,
        "skipped_dupe": skipped_dupe,
        "skipped_notitle": skipped_notitle,
        "earliest": dates[0] if dates else None,
        "latest": dates[-1] if dates else None,
        "with_abstract": sum(1 for p in papers if p["abstract"]),
        "with_arxiv": sum(1 for p in papers if p["arxiv_id"]),
    }
    print(json.dumps(stats))


if __name__ == "__main__":
    main()
