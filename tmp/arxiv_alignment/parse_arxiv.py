#!/usr/bin/env python3
"""Parse arXiv Atom XML results for the alignment-safety sweep, filter to
org-affiliated (Anthropic / OpenAI / Google DeepMind) or highly notable
frontier-lab-safety papers, and emit the normalized JSON array."""
import glob
import json
import os
import re
import sys
import xml.etree.ElementTree as ET

NS = {
    "atom": "http://www.w3.org/2005/Atom",
    "arxiv": "http://arxiv.org/schemas/atom",
}

BASE = "/Users/michaelofengenden/Desktop/ResearchPubs/tmp/arxiv_alignment"
OUT = "/Users/michaelofengenden/Desktop/ResearchPubs/data/raw/arxiv-alignment-safety.json"

# --- org detection -----------------------------------------------------------
ANTHROPIC_PAT = re.compile(r"\banthropic\b", re.I)
OPENAI_PAT = re.compile(r"\bopen\s?ai\b", re.I)
DEEPMIND_PAT = re.compile(r"\b(google\s+)?deepmind\b|\bgoogle\s+deep\s+mind\b", re.I)

# Known-author lists (last-resort affiliation inference; arXiv API rarely
# includes affiliation metadata). Names matched exactly against author strings.
ANTHROPIC_AUTHORS = {
    "jared kaplan", "sam mccandlish", "chris olah", "christopher olah",
    "jan leike", "ethan perez", "samuel r. bowman", "sam bowman",
    "samuel bowman", "deep ganguli", "jack clark", "nicholas schiefer",
    "amanda askell", "yuntao bai", "saurav kadavath", "jackson kernion",
    "tom henighan", "nicholas joseph", "catherine olsson", "dario amodei",
    "daniela amodei", "tom brown", "tom b. brown", "ben mann",
    "nova dassarma", "zac hatfield-dodds", "danny hernandez",
    "andy jones", "kamal ndousse", "dawn drain", "stanislav fort",
    "sheer el showk", "liane lovitt", "kamilė lukošiūtė",
    "kamile lukosiute", "anna chen", "anna goldie", "azalia mirhoseini",
    "cem anil", "carson denison", "monte macdiarmid", "evan hubinger",
    "fabien roger", "joe benton", "akbir khan",
    "mrinank sharma", "meg tong", "jesse mu",
    "jerry wei", "trenton bricken", "adam jermyn", "tomek korbak",
    "david duvenaud", "sara price", "jan brauner", "holden karnofsky",
    "miles mccain", "alex tamkin", "esin durmus",
    "jack lindsey", "emmanuel ameisen", "adly templeton",
    "joshua batson", "brian chen", "craig citro", "shan carter",
    "kelley rivoire", "thomas conerly", "adam pearce",
    "nelson elhage", "tristan hume", "shauna kravec", "tamera lanham",
    "robin larson", "scott johnston", "ansh radhakrishnan",
    "newton cheng",
    "samuel marks", "johannes treutlein",
    "rowan wang", "euan ong",
}
OPENAI_AUTHORS = {
    "john schulman", "ilya sutskever", "alec radford", "wojciech zaremba",
    "lilian weng", "ryan lowe", "long ouyang", "pamela mishkin",
    "paul christiano", "leo gao", "jacob hilton", "william saunders",
    "jeffrey wu", "daniel ziegler", "nisan stiennon",
    "collin burns", "pavel izmailov", "leopold aschenbrenner",
    "bowen baker", "ilge akkaya", "mark chen", "barret zoph",
    "todor markov", "tyna eloundou", "teddy lee", "sandhini agarwal",
    "jakub pachocki", "szymon sidor", "harri edwards", "yura burda",
    "stephanie lin", "owain evans", "karl cobbe", "vineet kosaraju",
    "hunter lightman", "yuri burda", "nat mcaleese", "jan hendrik kirchner",
    "aleksander madry", "lama ahmad", "joanne jang", "miles brundage",
    "girish sastry", "david robinson", "kai xiao", "johannes heidecke",
    "alex beutel", "andrea vallone", "ian kivlichan", "boaz barak",
    "gabriel goh", "joost huizinga", "tejal patwardhan", "amelia glaese",
    "dan mossing", "cathy yeh", "manas joglekar", "spencer papay",
}
DEEPMIND_AUTHORS = {
    "shane legg", "geoffrey irving", "rohin shah", "victoria krakovna",
    "zachary kenton", "ramana kumar", "tom everitt", "marcus hutter",
    "iason gabriel", "laura weidinger", "william isaac", "lisa anne hendricks",
    "nando de freitas", "oriol vinyals", "demis hassabis", "koray kavukcuoglu",
    "pushmeet kohli", "csaba szepesvari", "anca dragan", "been kim",
    "samuel albanie", "sebastian farquhar", "david lindner", "mary phuong",
    "vladimir mikulik", "matthew rahtz", "toby shevlane", "allan dafoe",
    "jonathan uesato", "po-sen huang", "francis song", "john aslanides",
    "amelia glaese", "nat mcaleese", "maja trebacz", "vikrant varma",
    "janos kramar",
    "noah y. siegel", "noah siegel", "rishabh agarwal", "lewis ho", "arthur conmy",
    "janina hoffmann", "anian ruoss", "tim genewein", "joel veness",
    "edward hughes", "michael dennis", "tom schaul", "andras gyorgy",
    "claudia shi", "alexander matt turner", "neel nanda",
}


def org_mentions(text):
    t = text or ""
    hits = []
    if ANTHROPIC_PAT.search(t):
        hits.append("anthropic")
    if OPENAI_PAT.search(t):
        hits.append("openai")
    if DEEPMIND_PAT.search(t):
        hits.append("deepmind")
    return hits


def detect_org(entry):
    """Affiliation strength ordering:
    1. known-author match (strong)
    2. arXiv affiliation metadata or comment-field lab mention (strong)
    3. abstract-only lab mention (weak -> keep as 'other': papers often just
       *evaluate* lab models; 'anthropic' is also a physics term)
    Returns (org_or_None, how)."""
    a = author_org(entry["authors"])
    if a:
        return a, "author"
    strong = org_mentions(" ".join([entry["comment"], " ".join(entry["affiliations"])]))
    if strong:
        return strong[0], "comment/affiliation"
    if org_mentions(entry["summary"]):
        return "other", "abstract-mention-only"
    return None, None


def author_org(authors):
    counts = {"anthropic": 0, "openai": 0, "deepmind": 0}
    for name in authors:
        n = name.strip().lower()
        if n in ANTHROPIC_AUTHORS:
            counts["anthropic"] += 1
        if n in OPENAI_AUTHORS:
            counts["openai"] += 1
        if n in DEEPMIND_AUTHORS:
            counts["deepmind"] += 1
    best = max(counts, key=counts.get)
    if counts[best] == 0:
        return None
    return best


# Core frontier-lab safety topics: a paper squarely on one of these themes is
# kept (org="other") even without a lab affiliation signal.
NOTABLE_PAT = re.compile(
    r"(alignment faking|deceptive alignment|deceptively aligned|sandbag|"
    r"reward hacking|reward tampering|specification gaming|"
    r"weak-to-strong generali[sz]ation|constitutional ai|"
    r"scalable oversight|superalignment|ai control protocol|"
    r"chain-of-thought monitor|cot monitor|scheming|"
    r"frontier (ai )?(model|lab)s? safety|frontier model safety)",
    re.I,
)

# Minimal AI-relevance gate (filters out e.g. astrophysics "anthropic
# principle" papers that match the Anthropic regex).
AI_RELEVANCE_PAT = re.compile(
    r"(language model|llm|artificial intelligence|\bai\b|rlhf|machine learning|"
    r"neural network|reinforcement learning|chatbot|alignment)",
    re.I,
)

# Broader safety/alignment theme gate for papers kept only because the
# abstract mentions a lab (filters off-theme papers that merely use Claude/GPT
# as a tool, e.g. LLM agents for astroparticle physics).
THEME_PAT = re.compile(
    r"(alignment|misalign|\bsafety\b|\bsafe\b|rlhf|"
    r"reinforcement learning from human feedback|reward hack|reward tampering|"
    r"reward model|sandbag|scheming|deceptive|alignment faking|jailbreak|"
    r"red.team|scalable oversight|weak-to-strong|harmless|refusal|"
    r"biosecurity|dangerous capabilit)",
    re.I,
)


def parse_file(path):
    tree = ET.parse(path)
    root = tree.getroot()
    entries = []
    for entry in root.findall("atom:entry", NS):
        eid = entry.findtext("atom:id", default="", namespaces=NS)
        m = re.search(r"arxiv\.org/abs/([0-9]{4}\.[0-9]{4,5})(v\d+)?", eid)
        arxiv_id = m.group(1) if m else None
        title = re.sub(r"\s+", " ", entry.findtext("atom:title", default="", namespaces=NS)).strip()
        summary = re.sub(r"\s+", " ", entry.findtext("atom:summary", default="", namespaces=NS)).strip()
        published = entry.findtext("atom:published", default="", namespaces=NS)[:10]
        authors = [
            a.findtext("atom:name", default="", namespaces=NS).strip()
            for a in entry.findall("atom:author", NS)
        ]
        affils = [
            aff.text.strip()
            for a in entry.findall("atom:author", NS)
            for aff in a.findall("arxiv:affiliation", NS)
            if aff.text
        ]
        comment = entry.findtext("arxiv:comment", default="", namespaces=NS) or ""
        journal_ref = entry.findtext("arxiv:journal_ref", default="", namespaces=NS) or ""
        pdf_url = None
        for link in entry.findall("atom:link", NS):
            if link.get("title") == "pdf":
                pdf_url = link.get("href")
        entries.append({
            "arxiv_id": arxiv_id,
            "title": title,
            "summary": summary,
            "published": published,
            "authors": authors,
            "affiliations": affils,
            "comment": re.sub(r"\s+", " ", comment).strip(),
            "journal_ref": re.sub(r"\s+", " ", journal_ref).strip(),
            "pdf_url": pdf_url,
        })
    return entries


def venue_from(comment, journal_ref):
    text = journal_ref or comment
    if not text:
        return "arXiv"
    m = re.search(
        r"\b(NeurIPS|ICML|ICLR|ACL|EMNLP|NAACL|AAAI|AIES|FAccT|COLM|CVPR|UAI|"
        r"AISTATS|CoRL|SaTML|IJCAI|TMLR)\b[^,.;]*?((19|20)\d{2})?",
        text, re.I,
    )
    if m:
        venue = m.group(1)
        year = m.group(2)
        return f"{venue} {year}".strip() if year else venue
    return "arXiv"


def main():
    seen = {}
    files = sorted(glob.glob(os.path.join(BASE, "q*.xml")))
    raw_total = 0
    for path in files:
        if os.path.getsize(path) < 1000:
            print(f"skipping empty/incomplete file: {path}", file=sys.stderr)
            continue
        for e in parse_file(path):
            raw_total += 1
            if not e["arxiv_id"]:
                continue
            if e["arxiv_id"] not in seen:
                seen[e["arxiv_id"]] = e

    kept = []
    for e in seen.values():
        if not e["published"] or e["published"] < "2022-01-01":
            continue
        title_abs = " ".join([e["title"], e["summary"]])
        if not AI_RELEVANCE_PAT.search(title_abs):
            continue  # not an AI paper (e.g. anthropic-principle astrophysics)
        org, how = detect_org(e)
        if org in ("anthropic", "openai", "deepmind"):
            pass  # lab-affiliated: keep
        elif org == "other":
            # mentions a lab but affiliation unsure: keep per instructions,
            # provided the paper is actually on the safety/alignment theme
            if not THEME_PAT.search(title_abs):
                continue
        elif NOTABLE_PAT.search(e["title"]):
            org = "other"  # title squarely on a frontier-lab safety theme
        else:
            continue
        authors = e["authors"][:12] + (["et al."] if len(e["authors"]) > 12 else [])
        kept.append({
            "title": e["title"],
            "authors": authors,
            "org": org,
            "date": e["published"],
            "url": f"https://arxiv.org/abs/{e['arxiv_id']}",
            "pdf_url": e["pdf_url"] or f"https://arxiv.org/pdf/{e['arxiv_id']}",
            "arxiv_id": e["arxiv_id"],
            "abstract": e["summary"] or None,
            "source": "arxiv-sweep",
            "venue": venue_from(e["comment"], e["journal_ref"]),
            "cited_by": None,  # arXiv API does not provide citation counts
        })

    kept.sort(key=lambda p: p["date"], reverse=True)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as f:
        json.dump(kept, f, indent=2, ensure_ascii=False)
    dates = [p["date"] for p in kept]
    orgs = {}
    for p in kept:
        orgs[p["org"]] = orgs.get(p["org"], 0) + 1
    print(json.dumps({
        "raw_entries": raw_total,
        "unique": len(seen),
        "kept": len(kept),
        "earliest": min(dates) if dates else None,
        "latest": max(dates) if dates else None,
        "org_counts": orgs,
        "files": files,
    }, indent=2))


if __name__ == "__main__":
    main()
