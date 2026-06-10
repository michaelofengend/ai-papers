import json, os, re, glob, html as htmllib
from datetime import datetime

TMP = '/Users/michaelofengenden/Desktop/ResearchPubs/tmp'
OUT = '/Users/michaelofengenden/Desktop/ResearchPubs/data/raw/anthropic.json'

def clean(s):
    if s is None: return None
    s = re.sub(r'<[^>]+>', '', s)
    s = htmllib.unescape(s)
    s = re.sub(r'\s+', ' ', s).strip()
    return s or None

papers = []

# ---------- (a) Research site posts from publicationList card data ----------
research = json.load(open(f'{TMP}/research_posts.json'))
def parse_iso(d):
    # handles "2026-06-08T13:20:00.000Z" and "2021-12-01T00:00:00-08:00"
    m = re.match(r'(\d{4})-(\d{2})-(\d{2})', d)
    return f"{m.group(1)}-{m.group(2)}-{m.group(3)}" if m else None

seen_research = set()
for p in research:
    slug = p.get('slug', {}).get('current')
    if not slug or slug in seen_research:
        continue
    seen_research.add(slug)
    date = parse_iso(p['publishedOn']) if p.get('publishedOn') else None
    papers.append({
        'title': clean(p.get('title')),
        'authors': None,
        'org': 'anthropic',
        'date': date,
        'url': f'https://www.anthropic.com/research/{slug}',
        'pdf_url': None,
        'arxiv_id': None,
        'abstract': clean(p.get('summary')),
        'source': 'anthropic-site',
        'venue': 'Anthropic Research',
        'cited_by': None,
    })

print('research posts:', len(seen_research))

# ---------- (b) Alignment Science blog ----------
align = json.load(open(f'{TMP}/alignment_index.json'))

MONTHS = {m:i for i,m in enumerate(
    ['January','February','March','April','May','June','July','August',
     'September','October','November','December'], 1)}

def month_to_date(s):
    parts = s.split()
    if len(parts) == 2 and parts[0] in MONTHS:
        return f"{parts[1]}-{MONTHS[parts[0]]:02d}-01"
    return None

# index files by slug substring
files = glob.glob(f'{TMP}/align_pages/*.html')

def find_file(href):
    slug = href.replace('/index.html','').rstrip('/').split('/')[-1]
    year = href.split('/')[0]
    for f in files:
        b = os.path.basename(f)
        if slug in b and year in b:
            return f
    return None

def split_names(nameblock):
    nameblock = re.sub(r'<sup>.*?</sup>', '', nameblock, flags=re.S)
    # treat element boundaries as name separators
    nameblock = re.sub(r'</p>|</div>|<br\s*/?>|</li>', ',', nameblock, flags=re.I)
    nameblock = re.sub(r'<[^>]*>', '', nameblock)   # complete tags
    nameblock = re.sub(r'<[^>]*$', '', nameblock)   # any trailing incomplete tag
    nameblock = htmllib.unescape(nameblock)
    nameblock = re.sub(r'\s+', ' ', nameblock).strip()
    out = []
    for n in nameblock.split(','):
        n = n.strip()
        n = re.sub(r'^and\s+', '', n)        # leading "and "
        n = re.sub(r'\s+and$', '', n)
        n = n.strip().strip('*').strip()
        if not n: continue
        for part in re.split(r'\s+and\s+', n):
            part = re.sub(r'^[^A-Za-z]+', '', part).strip().strip('*').strip(' .,;')
            if not part or not (1 <= len(part.split()) <= 6):
                continue
            if part.lower().startswith('http'):
                continue
            if re.search(r'\d|:', part):     # labels / years / dates are not names
                continue
            if not part[0].isupper():        # prose fragments ("with organizing from ...")
                continue
            out.append(part)
    return out

def extract_div(html, start):
    """Return inner content of the <div ...> beginning at index `start`, matching nested divs."""
    open_end = html.index('>', start) + 1
    depth = 1
    i = open_end
    tag = re.compile(r'<(/?)div\b', re.I)
    while depth > 0:
        m = tag.search(html, i)
        if not m: return html[open_end:open_end+2500]
        depth += -1 if m.group(1) else 1
        i = m.end()
    return html[open_end:m.start()]

def parse_byline(html):
    """Return (authors, exact_date, tldr, arxiv_id, paper_url)"""
    authors = exact_date = tldr = arxiv_id = paper_url = None

    def set_date(ds):
        nonlocal exact_date
        ds = clean(ds)
        if not ds: return
        ds = re.sub(r'\s+', ' ', ds)
        for fmt in ('%B %d, %Y', '%b %d, %Y'):
            try:
                exact_date = datetime.strptime(ds, fmt).strftime('%Y-%m-%d'); return
            except ValueError:
                pass

    # Format A: <div class="section-authors" ...> ... </div>
    sm = re.search(r'<div class="section-authors"', html)
    if sm:
        opentag = re.match(r'<div class="section-authors"[^>]*>', html[sm.start():])
        opentag = opentag.group(0) if opentag else ''
        block = extract_div(html, sm.start())

        # truncate block at the affiliations definition list (font-size:0.75em etc.),
        # cutting at the opening '<' of that tag so no partial tag leaks into names.
        amk = re.search(r'font-siz', block)
        if amk:
            cut = block.rfind('<', 0, amk.start())
            nameblock = block[:cut] if cut != -1 else block[:amk.start()]
        else:
            nameblock = block

        # date: data-published attr, float:right div, or any date-looking element
        dp = re.search(r'data-published="([^"]*)"', opentag)
        if dp and dp.group(1).strip():
            set_date(dp.group(1))
        if not exact_date:
            dm = re.search(r'float:\s*right;?\s*">([^<]+(?:\n[^<]+)?)</div>', block, re.S)
            if dm:
                set_date(dm.group(1))
        if not exact_date:
            for cand in re.findall(r'>\s*([A-Z][a-z]+ \d{1,2},?\s*\n?\s*\d{4})\s*<', block):
                set_date(cand)
                if exact_date: break

        # authors: prefer data-author attribute, else gather from all name elements
        da = re.search(r'data-author="([^"]*)"', opentag)
        names = []
        if da and da.group(1).strip():
            names = split_names(da.group(1))
        if not names:
            # remove float date div and any standalone date element, then take all text
            nb = re.sub(r'<div style="float: right;">.*?</div>', ' ', nameblock, flags=re.S)
            # remove the opening section-authors tag itself
            nb = re.sub(r'^<div class="section-authors"[^>]*>', ' ', nb)
            raw = split_names(nb)
            # filter out date-like / affiliation-like tokens
            for n in raw:
                if re.search(r'\b\d{4}\b', n):  # contains a year -> a date string
                    continue
                if re.match(r'^(January|February|March|April|May|June|July|August|September|October|November|December)\b', n):
                    continue
                if ';' in n:
                    continue
                names.append(n)
        if names:
            authors = names[:12] + (['et al.'] if len(names) > 12 else [])

    # Format B: "Authors:" or "Authors" label followed by names
    if not authors:
        bm = re.search(r"Authors:\s*</span>\s*(.*?)</p>", html, re.S) \
             or re.search(r"Authors\s*</span>\s*</p>\s*<p>(.*?)</p>", html, re.S)
        if bm:
            names = split_names(bm.group(1))
            if names:
                authors = names[:12] + (['et al.'] if len(names) > 12 else [])

    # Format C: first paragraph after <d-article> is an italic author line
    if not authors:
        cm = re.search(r"<d-article>\s*<p><span style='font-style: italic;'>([^<]+)</span></p>", html)
        if cm and ',' in cm.group(1):
            names = split_names(cm.group(1))
            if names:
                authors = names[:12] + (['et al.'] if len(names) > 12 else [])

    # tl;dr
    tm = re.search(r'<span class="tldr">tl;dr</span>\s*<p>(.*?)</p>', html, re.S)
    if tm:
        tldr = clean(tm.group(1))

    # explicit "Arxiv link:" paragraph (highest confidence for the post's own paper)
    al = re.search(r"Arxiv link:\s*</span>\s*<a href=['\"]([^'\"]+)['\"]", html)
    if al:
        paper_url = htmllib.unescape(al.group(1))

    # Identify the post's OWN paper link by anchor text (vs. citations which use "X et al.").
    PAPER_WORDS = {'paper','readthefullpaper','readthepaper','readpaper','fullpaper',
                   'ourpaper','thepaper','arxivpaper','arxiv','pdf'}
    am = re.search(r'<d-article>', html)
    art = html[am.start():] if am else html
    for m in re.finditer(r"<a href=['\"]([^'\"]+)['\"][^>]*>(.*?)</a>", art, re.S):
        href, atext = m.group(1), m.group(2)
        norm = re.sub(r'[^a-z]', '', re.sub(r'<[^>]+>', '', htmllib.unescape(atext)).lower())
        is_paper = norm in PAPER_WORDS or href.rstrip('/') == re.sub(r'<[^>]+>','',atext).strip().rstrip('/')
        if is_paper:
            ax = re.search(r'arxiv\.org/abs/(\d{4}\.\d{4,5})', href)
            if ax:
                arxiv_id = ax.group(1)
                if not paper_url: paper_url = htmllib.unescape(href)
                break
            if not paper_url and ('arxiv.org' in href or href.lower().endswith('.pdf')):
                paper_url = htmllib.unescape(href)

    if not arxiv_id and paper_url:
        ax = re.search(r'arxiv\.org/abs/(\d{4}\.\d{4,5})', paper_url)
        if ax: arxiv_id = ax.group(1)

    return authors, exact_date, tldr, arxiv_id, paper_url

n_ext = 0
for p in align:
    href = p['href']
    title = clean(p['title'])
    desc = clean(p['desc'])
    month_date = month_to_date(p['month'])

    if href.startswith('http'):
        n_ext += 1
        url = href
        arxiv_id = None
        am = re.search(r'arxiv\.org/abs/(\d{4}\.\d{4,5})', href)
        if am: arxiv_id = am.group(1)
        venue = 'arXiv' if arxiv_id else 'Alignment Science Blog'
        papers.append({
            'title': title, 'authors': None, 'org': 'anthropic',
            'date': month_date,
            'url': url, 'pdf_url': None, 'arxiv_id': arxiv_id,
            'abstract': desc, 'source': 'alignment-blog',
            'venue': venue, 'cited_by': None,
        })
        continue

    url = 'https://alignment.anthropic.com/' + href.replace('index.html','').rstrip('/') + '/'
    f = find_file(href)
    authors = exact_date = tldr = arxiv_id = paper_url = None
    if f:
        h = open(f, encoding='utf-8', errors='replace').read()
        authors, exact_date, tldr, arxiv_id, paper_url = parse_byline(h)
    abstract = tldr or desc
    pdf_url = paper_url if (paper_url and paper_url.lower().endswith('.pdf')) else None
    papers.append({
        'title': title,
        'authors': authors,
        'org': 'anthropic',
        'date': exact_date or month_date,
        'url': url,
        'pdf_url': pdf_url,
        'arxiv_id': arxiv_id,
        'abstract': abstract,
        'source': 'alignment-blog',
        'venue': 'Alignment Science Blog',
        'cited_by': None,
    })

print('alignment posts:', sum(1 for x in papers if x['source']=='alignment-blog'), '(external:', n_ext, ')')

# stats
dates = sorted([x['date'] for x in papers if x['date']])
print('total:', len(papers))
print('date range:', dates[0], '->', dates[-1])
print('with abstract:', sum(1 for x in papers if x['abstract']))
print('with authors:', sum(1 for x in papers if x['authors']))
print('with arxiv:', sum(1 for x in papers if x['arxiv_id']))
print('null date:', sum(1 for x in papers if not x['date']))

json.dump(papers, open(OUT,'w'), indent=2, ensure_ascii=False)
print('wrote', OUT)
EOF = None
