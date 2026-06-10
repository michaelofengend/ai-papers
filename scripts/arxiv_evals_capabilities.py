#!/usr/bin/env python3
"""arXiv API sweep for theme 'evals-capabilities'.

Fetches Atom XML via curl, paginates back to 2022, filters for papers with
Anthropic / OpenAI / Google DeepMind authors (or squarely-notable frontier
model safety papers), writes a JSON array.
"""
import json
import os
import re
import subprocess
import sys
import time
import urllib.parse
import xml.etree.ElementTree as ET

OUT = "/Users/michaelofengenden/Desktop/ResearchPubs/data/raw/arxiv-evals-capabilities.json"
TMP_DIR = "/Users/michaelofengenden/Desktop/ResearchPubs/data/tmp"

# Structured arXiv API equivalents of the requested free-text queries.
# (arXiv's Lucene-ish parser needs explicit AND/OR and '+'-encoded spaces;
# the raw free-text forms return 0 results or match the whole corpus.)
QUERIES = [
    'all:"dangerous capabilities" AND all:evaluation',
    'all:"language model" AND all:evaluation AND all:benchmark AND all:frontier',
    'all:"scaling laws" AND all:"language model"',
    'all:"emergent abilities" OR all:"capability elicitation"',
    '(all:jailbreak OR all:"adversarial robustness") AND all:"language model" AND all:safety',
]

NS = {
    "atom": "http://www.w3.org/2005/Atom",
    "arxiv": "http://arxiv.org/schemas/atom",
    "opensearch": "http://a9.com/-/spec/opensearch/1.1/",
}

PAGE = 150
MAX_PAGES = 7  # per query
CUTOFF = "2022-01-01"

# --- affiliation signals -----------------------------------------------------
LAB_TEXT_PATTERNS = [
    (re.compile(r"google\s+deepmind|deepmind", re.I), "deepmind"),
    (re.compile(r"\banthropic\b", re.I), "anthropic"),
    (re.compile(r"\bopenai\b", re.I), "openai"),
]

# Distinctive researcher names (best-guess org mapping). Conservative list of
# names that are strongly identified with each lab during 2022-present.
ANTHROPIC_AUTHORS = {
    "jared kaplan", "sam mccandlish", "jack clark", "dario amodei",
    "daniela amodei", "chris olah", "christopher olah", "catherine olsson",
    "nicholas joseph", "deep ganguli", "ethan perez", "saurav kadavath",
    "amanda askell", "yuntao bai", "jackson kernion", "nova dassarma",
    "zac hatfield-dodds", "danny hernandez", "tom henighan", "tristan hume",
    "liane lovitt", "kamal ndousse", "samuel r. bowman", "mrinank sharma",
    "meg tong", "evan hubinger", "monte macdiarmid", "carson denison",
    "fabien roger", "joe benton", "esin durmus", "alex tamkin",
    "sandipan kundu", "shauna kravec", "newton cheng", "timothy maxwell",
    "nicholas schiefer", "oliver rausch",
}
OPENAI_AUTHORS = {
    "john schulman", "ilya sutskever", "jacob hilton", "lilian weng",
    "long ouyang", "ryan lowe", "jeff wu", "leo gao", "collin burns",
    "william saunders", "karl cobbe", "hunter lightman", "bowen baker",
    "tejal patwardhan", "aleksander madry", "jakub pachocki", "yuri burda",
    "harri edwards", "todor markov", "miles brundage", "vineet kosaraju",
    "alec radford", "pamela mishkin", "girish sastry",
    "lama ahmad", "sandhini agarwal", "joanne jang", "boaz barak",
    "gabriel goh", "wojciech zaremba", "johannes heidecke",
}
DEEPMIND_AUTHORS = {
    "rohin shah", "anca dragan", "allan dafoe", "toby shevlane",
    "mary phuong", "iason gabriel", "laura weidinger", "william isaac",
    "jack w. rae", "oriol vinyals", "pushmeet kohli", "shane legg",
    "victoria krakovna", "zachary kenton", "tom everitt",
    "sebastian farquhar", "david lindner", "neel nanda", "katherine lee",
    "demis hassabis", "koray kavukcuoglu",
    "samuel albanie", "geoffrey irving", "tim rocktaschel",
    "tim rocktäschel", "lewis ho",
    "sebastien borgeaud", "jordan hoffmann", "arthur mensch",
    "laurent sifre", "po-sen huang", "john aslanides", "nat mcaleese",
    "maja trebacz", "vladimir mikulik", "ramana kumar", "matthew rahtz",
    "janos kramar", "jonathan uesato", "noah y. siegel",
}

# Date-dependent moves between labs.
def special_author_org(name_l: str, date: str):
    if name_l == "jan leike":
        return "openai" if date < "2024-06-01" else "anthropic"
    if name_l == "nicholas carlini":
        return "deepmind" if date < "2025-03-01" else "anthropic"
    if name_l == "jason wei":
        return "openai" if date >= "2023-03-01" else "other"
    if name_l == "paul christiano":
        return "other"  # ARC during this window
    if name_l == "jascha sohl-dickstein":
        return "deepmind" if date < "2024-02-01" else "anthropic"
    return None

FRONTIER_TITLE = re.compile(
    r"gpt-4|gpt-5|gpt-3\.5|chatgpt|\bclaude\b|\bgemini\b|frontier (ai|model)", re.I
)
SAFETY_THEME = re.compile(
    r"safety|jailbreak|red.?team|adversarial|risk|capabilit|evaluat|benchmark|"
    r"alignment|misuse|dangerous|scaling law|emergent", re.I
)

VENUE_RE = re.compile(
    r"(NeurIPS|ICML|ICLR|ACL|EMNLP|NAACL|AAAI|COLM|AISTATS|CVPR|FAccT|"
    r"AIES|SaTML|S&P|USENIX Security|CCS|COLT|TMLR|JMLR)\s*('?\d{2,4})?", re.I
)


def fetch(query: str, start: int) -> bytes:
    url = (
        "https://export.arxiv.org/api/query?search_query="
        + urllib.parse.quote_plus(query)
        + f"&sortBy=submittedDate&sortOrder=descending&start={start}&max_results={PAGE}"
    )
    for attempt in range(6):
        r = subprocess.run(
            ["curl", "-sL", "--max-time", "90",
             "-w", "\n%{http_code}",
             "-A", "ResearchPubs-sweep/0.1 (michaelofengend@gmail.com)", url],
            capture_output=True,
        )
        body, _, code = r.stdout.rpartition(b"\n")
        code = code.strip().decode("ascii", "replace")
        if r.returncode == 0 and code == "200" and b"<feed" in body:
            return body
        wait = 60 * (attempt + 1) if code == "429" else 10
        print(f"  fetch retry (status={code}, rc={r.returncode}), "
              f"sleeping {wait}s", file=sys.stderr)
        time.sleep(wait)
    return b""


def text_of(el, path):
    node = el.find(path, NS)
    if node is None or node.text is None:
        return None
    return re.sub(r"\s+", " ", node.text).strip()


def parse_entries(xml_bytes: bytes):
    out = []
    try:
        root = ET.fromstring(xml_bytes)
    except ET.ParseError:
        return out, 0
    total_node = root.find("opensearch:totalResults", NS)
    total = int(total_node.text) if total_node is not None and total_node.text else 0
    for e in root.findall("atom:entry", NS):
        eid = text_of(e, "atom:id") or ""
        m = re.search(r"arxiv\.org/abs/(.+)$", eid)
        raw_id = m.group(1) if m else None
        arxiv_id = re.sub(r"v\d+$", "", raw_id) if raw_id else None
        published = text_of(e, "atom:published") or ""
        date = published[:10] if published else None
        authors, affs = [], []
        for a in e.findall("atom:author", NS):
            nm = text_of(a, "atom:name")
            if nm:
                authors.append(nm)
            af = text_of(a, "arxiv:affiliation")
            if af:
                affs.append(af)
        pdf_url = None
        for ln in e.findall("atom:link", NS):
            if ln.get("title") == "pdf" or ln.get("type") == "application/pdf":
                pdf_url = ln.get("href")
        out.append({
            "title": text_of(e, "atom:title"),
            "authors_full": authors,
            "affiliations": affs,
            "date": date,
            "arxiv_id": arxiv_id,
            "abstract": text_of(e, "atom:summary"),
            "comment": text_of(e, "arxiv:comment"),
            "pdf_url": pdf_url,
        })
    return out, total


def classify(entry):
    """Return (keep: bool, org: str)."""
    date = entry["date"] or "9999-99-99"
    blob = " ".join(filter(None, [entry["abstract"], entry["comment"],
                                  " ".join(entry["affiliations"])]))
    # 1) explicit lab mention in affiliation/comment/abstract
    for pat, org in LAB_TEXT_PATTERNS:
        aff_blob = " ".join(entry["affiliations"])
        if aff_blob and pat.search(aff_blob):
            return True, org
    org_votes = []
    for pat, org in LAB_TEXT_PATTERNS:
        if pat.search(blob):
            org_votes.append(org)
    # 2) author-name match
    for name in entry["authors_full"]:
        nl = re.sub(r"\s+", " ", name).strip().lower()
        sp = special_author_org(nl, date)
        if sp in ("anthropic", "openai", "deepmind"):
            return True, sp
        if nl in ANTHROPIC_AUTHORS:
            return True, "anthropic"
        if nl in OPENAI_AUTHORS:
            return True, "openai"
        if nl in DEEPMIND_AUTHORS:
            return True, "deepmind"
    # 3) lab mentioned in abstract/comment but no author match -> likely about
    #    the lab's models; keep, org=other unless the comment reads like an
    #    affiliation statement (rare). Be conservative: org="other".
    title = entry["title"] or ""
    if org_votes and SAFETY_THEME.search(title + " " + blob):
        return True, "other"
    # 4) squarely about frontier-lab models/safety: frontier model named in
    #    the title + safety/evals theme.
    if FRONTIER_TITLE.search(title) and SAFETY_THEME.search(title + " " + blob):
        return True, "other"
    return False, "other"


def venue_from_comment(comment):
    if not comment:
        return "arXiv"
    m = VENUE_RE.search(comment)
    if m:
        name = m.group(1)
        canon = {
            "neurips": "NeurIPS", "icml": "ICML", "iclr": "ICLR", "acl": "ACL",
            "emnlp": "EMNLP", "naacl": "NAACL", "aaai": "AAAI", "colm": "COLM",
            "aistats": "AISTATS", "cvpr": "CVPR", "facct": "FAccT",
            "aies": "AIES", "satml": "SaTML", "s&p": "IEEE S&P",
            "usenix security": "USENIX Security", "ccs": "CCS",
            "colt": "COLT", "tmlr": "TMLR", "jmlr": "JMLR",
        }.get(name.lower(), name)
        yr = m.group(2)
        if yr:
            yr = yr.lstrip("'")
            if len(yr) == 2:
                yr = "20" + yr
            return f"{canon} {yr}"
        return canon
    return "arXiv"


def main():
    seen = {}
    stats = []
    for qi, q in enumerate(QUERIES):
        total_reported = None
        fetched = 0
        for page in range(MAX_PAGES):
            start = page * PAGE
            cache = f"{TMP_DIR}/q{qi}_p{page}.xml"
            xml_bytes = b""
            if os.path.exists(cache) and os.path.getsize(cache) > 500:
                with open(cache, "rb") as f:
                    cached = f.read()
                if b"<feed" in cached:
                    xml_bytes = cached
                    print(f"query {qi} page {page}: using cache", file=sys.stderr)
            if not xml_bytes:
                xml_bytes = fetch(q, start)
                if xml_bytes:
                    with open(cache, "wb") as f:
                        f.write(xml_bytes)
                time.sleep(3)
            entries, total = parse_entries(xml_bytes)
            if total_reported is None:
                total_reported = total
            fetched += len(entries)
            oldest = min((e["date"] or "9999" for e in entries), default=None)
            for e in entries:
                key = e["arxiv_id"] or e["title"]
                if key not in seen:
                    seen[key] = e
            print(f"query {qi} page {page}: {len(entries)} entries "
                  f"(total={total}, oldest={oldest})", file=sys.stderr)
            if len(entries) < PAGE:
                break
            if oldest is not None and oldest < CUTOFF:
                break
        stats.append({"query": q, "total_reported": total_reported,
                      "fetched": fetched})

    papers = []
    for e in seen.values():
        if not e["date"] or e["date"] < CUTOFF:
            continue
        keep, org = classify(e)
        if not keep:
            continue
        authors = e["authors_full"]
        if len(authors) > 12:
            authors = authors[:12] + ["et al."]
        papers.append({
            "title": e["title"],
            "authors": authors,
            "org": org,
            "date": e["date"],
            "url": f"https://arxiv.org/abs/{e['arxiv_id']}" if e["arxiv_id"] else None,
            "pdf_url": e["pdf_url"],
            "arxiv_id": e["arxiv_id"],
            "abstract": e["abstract"],
            "source": "arxiv-sweep",
            "venue": venue_from_comment(e["comment"]),
            "cited_by": None,
        })

    papers.sort(key=lambda p: p["date"], reverse=True)
    with open(OUT, "w") as f:
        json.dump(papers, f, indent=2, ensure_ascii=False)
    print(json.dumps({
        "count": len(papers),
        "unique_fetched": len(seen),
        "earliest": papers[-1]["date"] if papers else None,
        "latest": papers[0]["date"] if papers else None,
        "by_org": {o: sum(1 for p in papers if p["org"] == o)
                   for o in ("anthropic", "openai", "deepmind", "other")},
        "stats": stats,
    }, indent=2))


if __name__ == "__main__":
    main()
