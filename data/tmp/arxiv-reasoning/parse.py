#!/usr/bin/env python3
"""Parse arXiv Atom XML sweep results, filter for frontier-lab papers, emit JSON."""
import glob
import json
import os
import re
import xml.etree.ElementTree as ET

NS = {
    "a": "http://www.w3.org/2005/Atom",
    "arxiv": "http://arxiv.org/schemas/atom",
}

TMP = "/Users/michaelofengenden/Desktop/ResearchPubs/data/tmp/arxiv-reasoning"
OUT = "/Users/michaelofengenden/Desktop/ResearchPubs/data/raw/arxiv-reasoning.json"

# Authors strongly associated with each lab (best-effort, current as of 2025-2026)
KNOWN_AUTHORS = {
    "anthropic": [
        "Ethan Perez", "Evan Hubinger", "Jan Leike", "Samuel R. Bowman",
        "Jared Kaplan", "Fabien Roger", "Joe Benton", "Mrinank Sharma",
        "Nicholas Carlini", "Chris Olah", "Neel Nanda",  # Nanda is GDM, handled below first
        "Emmanuel Ameisen", "Jack Lindsey", "Monte MacDiarmid", "Akbir Khan",
    ],
    "openai": [
        "Noam Brown", "Hunter Lightman", "Karl Cobbe", "Jakub Pachocki",
        "Bowen Baker", "Leo Gao", "Jerry Tworek", "Aleksander Madry",
        "Jason Wei", "Dan Roberts", "Ahmed El-Kishky", "Alexander Wei",
    ],
    "deepmind": [
        "Oriol Vinyals", "David Silver", "Denny Zhou", "Xuezhi Wang",
        "Quoc V. Le", "Rohin Shah", "Anca Dragan", "Thang Luong",
        "Xinyun Chen", "Swaroop Mishra", "Azade Nova", "Noah Fiedel",
        "Aja Huang", "Golnaz Ghiasi", "Yuhuai Wu", "Behnam Neyshabur",
        "Hanie Sedghi", "Rishabh Agarwal", "Hugo Larochelle",
        "Erik Jenner", "David Lindner", "Scott Emmons", "Victoria Krakovna",
    ],
}
# Neel Nanda is Google DeepMind — fix ordering by checking deepmind names first.
KNOWN_AUTHORS["anthropic"].remove("Neel Nanda")
KNOWN_AUTHORS["deepmind"].append("Neel Nanda")

LAB_PATTERNS = [
    ("anthropic", re.compile(r"\banthropic\b", re.I)),
    ("deepmind", re.compile(r"\bdeep\s?mind\b", re.I)),
    ("openai", re.compile(r"\bopen\s?ai\b", re.I)),
]

FRONTIER_MODEL_RE = re.compile(
    r"\bGPT-4(\.\d|o|\.1)?\b|\bGPT-5\b|\bo1(-preview|-mini)?\b|\bo3(-mini)?\b|\bo4-mini\b"
    r"|\bClaude(\s+\d|\s+Opus|\s+Sonnet|\s+Haiku|\s+3(\.\d)?|\s+4(\.\d)?)?\b"
    r"|\bGemini(\s+\d(\.\d)?|\s+Pro|\s+Ultra|\s+Flash)?\b|\bAlphaProof\b|\bAlphaGeometry\b",
    re.I,
)
SAFETY_RE = re.compile(
    r"faithfulness|unfaithful|monitor|deceptio|deceptive|scheming|sandbagging|"
    r"reward hacking|alignment|misalign|oversight|safety|interpretab|hidden reasoning|"
    r"obfuscat|steganograph|biosecurity|dangerous capabilit|frontier (model|lab|AI)",
    re.I,
)

# Squarely-on-theme safety core: CoT/reasoning-trace monitoring, faithfulness,
# obfuscation, evasion — the frontier-lab safety agenda around reasoning models.
COT_SAFETY_RE = re.compile(
    r"(chain[- ]of[- ]thought|\bCoT\b|reasoning (trace|model)s?|chains? of thought)"
    r"[^.]{0,120}(monitor|faithful|unfaithful|obfuscat|hidden|steganograph|evade|evasion|controllab|legib)"
    r"|(monitor|faithful|unfaithful|obfuscat|steganograph)[^.]{0,120}(chain[- ]of[- ]thought|\bCoT\b|reasoning trace)"
    r"|reward hacking|alignment faking|scheming|sandbagging",
    re.I,
)

# Manually reviewed false positives: generic-method papers or surveys whose
# abstracts only mention safety phrases in passing (no lab affiliation).
EXCLUDE_IDS = {
    "2606.10184",  # Dropout-GRPO — matched on "continuous hidden states"
    "2606.08728",  # math-reasoning survey — passing "reward hacking" mention
    "2605.30451",  # VeriGate — generic GRPO training method
    "2605.20098",  # neurosymbolic argumentation — generic method
    "2508.17298",  # visual-reasoning survey — passing CoT-faithfulness mention
}

VENUE_RE = re.compile(
    r"\b(NeurIPS|ICML|ICLR|ACL|EMNLP|NAACL|AAAI|COLM|CVPR|ICCV|ECCV|AISTATS|CoLLAs|TMLR|UAI|COLT)\b"
    r"(\s*'?\s*(20\d\d))?",
    re.I,
)


def text(el):
    return re.sub(r"\s+", " ", el.text or "").strip() if el is not None else ""


def classify(authors, affiliations, comment, abstract, title):
    """Return (org, keep_reason) or (None, None) if paper should be dropped."""
    # 1. Explicit affiliation tags / comment mention
    strong_ctx = " ".join(affiliations) + " || " + comment
    for org, pat in LAB_PATTERNS:
        if pat.search(strong_ctx):
            return org, "affiliation/comment"
    # 2. Known lab authors
    for org in ("deepmind", "openai", "anthropic"):
        for name in KNOWN_AUTHORS[org]:
            if name in authors:
                return org, f"known author: {name}"
    # 3. Lab named in abstract in an authorship-ish way ("we at OpenAI", "Anthropic's ...")
    abs_title = (abstract or "") + " " + (title or "")
    for org, pat in LAB_PATTERNS:
        if pat.search(abs_title):
            # Lab is mentioned; could be affiliation or just subject matter.
            first_party = re.search(
                r"\b(we|our)\b.{0,40}\b(at|from)\s+(Anthropic|OpenAI|Google DeepMind|DeepMind)",
                abs_title, re.I)
            if first_party:
                return org, "first-party abstract"
            # Lab mentioned only as subject — keep only if also safety-relevant.
            if SAFETY_RE.search(abs_title):
                return "other", f"mentions {org} + safety relevance"
            return None, None
    # 4. Squarely about the CoT-monitoring/faithfulness safety agenda — keep as other
    if COT_SAFETY_RE.search(abs_title):
        return "other", "CoT-safety core topic"
    return None, None


def parse_entry(entry):
    raw_id = text(entry.find("a:id", NS))
    m = re.search(r"abs/([^v]+(?:v\d+)?)", raw_id)
    vid = m.group(1) if m else None
    arxiv_id = re.sub(r"v\d+$", "", vid) if vid else None

    title = text(entry.find("a:title", NS))
    abstract = text(entry.find("a:summary", NS)) or None
    published = text(entry.find("a:published", NS))
    date = published[:10] if published else None
    comment = text(entry.find("arxiv:comment", NS))

    authors, affiliations = [], []
    for au in entry.findall("a:author", NS):
        nm = text(au.find("a:name", NS))
        if nm:
            authors.append(nm)
        for aff in au.findall("arxiv:affiliation", NS):
            affiliations.append(text(aff))

    if arxiv_id in EXCLUDE_IDS:
        return None
    org, reason = classify(authors, affiliations, comment, abstract, title)
    if org is None:
        return None
    if date and date < "2022-01-01":
        return None

    out_authors = authors[:12] + (["et al."] if len(authors) > 12 else [])

    venue = "arXiv"
    vm = VENUE_RE.search(comment)
    if vm:
        venue = vm.group(1)
        if vm.group(3):
            venue += " " + vm.group(3)

    return {
        "title": title,
        "authors": out_authors,
        "org": org,
        "date": date,
        "url": f"https://arxiv.org/abs/{arxiv_id}" if arxiv_id else raw_id,
        "pdf_url": f"https://arxiv.org/pdf/{arxiv_id}" if arxiv_id else None,
        "arxiv_id": arxiv_id,
        "abstract": abstract,
        "source": "arxiv-sweep",
        "venue": venue,
        "cited_by": None,
        "_reason": reason,
    }


def main():
    papers, seen = {}, set()
    total_entries = 0
    per_file = {}
    for path in sorted(glob.glob(os.path.join(TMP, "q*.xml"))):
        try:
            root = ET.parse(path).getroot()
        except ET.ParseError as e:
            print(f"PARSE ERROR {path}: {e}")
            continue
        entries = root.findall("a:entry", NS)
        per_file[os.path.basename(path)] = len(entries)
        total_entries += len(entries)
        for entry in entries:
            p = parse_entry(entry)
            if not p:
                continue
            key = p["arxiv_id"] or p["title"].lower()
            if key in seen:
                continue
            seen.add(key)
            papers[key] = p

    out = sorted(papers.values(), key=lambda p: p["date"] or "", reverse=True)
    reasons, org_counts = {}, {}
    for p in out:
        r = p.pop("_reason")
        rkey = "known author" if r.startswith("known author") else r
        reasons[rkey] = reasons.get(rkey, 0) + 1
        org_counts[p["org"]] = org_counts.get(p["org"], 0) + 1

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as f:
        json.dump(out, f, indent=2, ensure_ascii=False)

    dates = [p["date"] for p in out if p["date"]]
    print(json.dumps({
        "entries_per_file": per_file,
        "total_entries": total_entries,
        "kept": len(out),
        "org_counts": org_counts,
        "keep_reasons": reasons,
        "earliest": min(dates) if dates else None,
        "latest": max(dates) if dates else None,
    }, indent=2))


if __name__ == "__main__":
    main()
