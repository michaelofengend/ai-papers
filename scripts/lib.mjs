/* Shared helpers for the research-paper pipeline. */

export const TOPICS = [
  'Interpretability',
  'Alignment',
  'Safety',
  'Reasoning',
  'Evaluations',
  'Robustness & Security',
  'Agents',
  'Training & Scaling',
  'Multimodal',
  'Reinforcement Learning',
  'Science Applications',
  'Policy & Society',
  'Other',
];

/* Keyword rules for fallback tagging (CI updates run without an LLM).
   Order matters: earlier rules become the primary topic. */
const RULES = [
  ['Interpretability', /\b(interpretab|mechanistic|sparse autoencoder|SAE|superposition|circuit|feature visuali[sz]|probing|activation patch|attribution graph|crosscoder|transcoder|induction head|monosemantic|polysemantic|dictionary learning|attention head|residual stream|steering vector|representation engineering|introspect)\b/i],
  ['Safety', /\b(safety|dangerous capabilit|misuse|biorisk|bioweapon|catastrophic|existential|model organism|deceptive alignment|alignment faking|sandbagging|scheming|sabotage|AI control|responsible scaling|model welfare|situational awareness|self-exfiltration|blackmail)\b/i],
  ['Alignment', /\b(alignment|RLHF|reinforcement learning from human feedback|constitutional AI|DPO|preference (learning|model|optimization)|instruction.?tun|fine.?tun|reward model|reward hack|reward tamper|weak.to.strong|scalable oversight|debate|recursive reward|value learning|honesty|sycophan|character training|post.?training)\b/i],
  ['Robustness & Security', /\b(jailbreak|adversarial|prompt injection|backdoor|poison|robustness|red.?team|attack|exploit|universal trigger|unlearning|extraction attack|watermark)\b/i],
  ['Reasoning', /\b(reasoning|chain.of.thought|chain of thought|CoT|test.time compute|inference.time|scratchpad|theorem prov|mathematical|olympiad|deliberat|thinking model|o1|process supervision|process reward)\b/i],
  ['Evaluations', /\b(benchmark|evaluation|eval(s)?\b|leaderboard|capability elicitation|METR|task suite|HELM|BIG.bench|SWE.bench|GPQA|MMLU)\b/i],
  ['Agents', /\b(agent(s|ic)?\b|tool use|computer use|web navigation|multi.agent|autonomous|assistant)\b/i],
  ['Multimodal', /\b(multimodal|vision.language|image (generation|recognition)|video|audio|speech|text.to.image|diffusion|VLM|CLIP|DALL)\b/i],
  ['Reinforcement Learning', /\b(reinforcement learning|deep RL|RL agent|Atari|AlphaGo|AlphaZero|AlphaStar|MuZero|policy gradient|Q.learning|exploration|reward shaping|StarCraft|self.play)\b/i],
  ['Training & Scaling', /\b(scaling law|pretrain|pre.train|emergen(t|ce)|transformer architecture|mixture.of.experts|MoE|efficient training|optimizer|distillation|quantization|in.context learning|grokking|memori[sz]ation|data curation|tokeni[sz]|language model(s|ing)?\b)\b/i],
  ['Science Applications', /\b(protein|AlphaFold|drug|genomic|biology|chemistry|materials|weather|climate|fusion|mathematics discovery|FunSearch|AlphaTensor|AlphaDev|healthcare|medical|clinical)\b/i],
  ['Policy & Society', /\b(policy|governance|regulation|societal|economic impact|labor|election|democra|copyright|privacy|fairness|bias|ethic)\b/i],
];

export function tagTopics(text) {
  const tags = [];
  for (const [topic, re] of RULES) {
    if (re.test(text)) tags.push(topic);
    if (tags.length >= 3) break;
  }
  return tags.length ? tags : ['Other'];
}

export function normTitle(t) {
  return String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/* Classify record as research 'paper' vs company 'post' (announcement, product
   news, feature launch). Returns null when ambiguous (needs LLM review). */
const POST_TITLE = /^(introducing|announcing|launching|expanding|bringing|previewing|update on|updates? to|our (approach|response|commitment|partnership)|partnering|a (letter|message) |now (available|rolling)|available (now|today)|new (ways|features|tools|funding|capabilities|models? available)|sam & jony|openai and|anthropic and|claude (can )?now|gpt-\S+ (is here|in|now)|strengthening|memory and new|improvements to|start using|how (we|to) use)/i;
const POST_HINT = /\b(api|pricing|enterprise|customers?|partnership|acquisition|hiring|joins?|board|policy update|terms of|brand|rebrand|store|app store|mobile app|desktop app|general availability|ga today|waitlist|rolling out|sign ?up)\b/i;
const PAPER_VENUE = /arxiv|neurips|icml|iclr|aaai|acl\b|emnlp|cvpr|nature|science\b|pnas|jmlr|tmlr|transactions|journal|proceedings|workshop|circuits thread|alignment science/i;

export function classifyKind(p) {
  if (p.arxiv_id) return 'paper';
  const src = Array.isArray(p.sources) ? p.sources.join(',') : (p.source || '');
  if (/openalex|arxiv|deepmind-site|transformer-circuits|alignment-blog/.test(src)) return 'paper';
  if (p.venue && PAPER_VENUE.test(p.venue)) return 'paper';
  if (POST_TITLE.test(p.title)) return 'post';
  if (POST_HINT.test(p.title)) return 'post';
  return null; // ambiguous lab-site record
}

/* OpenAlex affiliation pollution: AI-generated podcast records (Open MIND /
   myweirdprompts), Zenodo/Figshare software releases, GitHub release entries. */
const SPAM_URL = /zenodo\.org|figshare|myweirdprompts\.com|osf\.io/i;
const SPAM_VENUE = /^(open mind|zenodo|figshare)/i;
const SPAM_AUTHOR = /chatterbox|^(claude|gemini|chatgpt|gpt)[ ,-]|\((flash|pro|mini)\)|^rosehill, daniel/i;
const SPAM_TITLE = /^[\w.-]+\/[\w.-]+:/; // "owner/repo: v1.2.3" release records

export function isSpam(p) {
  if (SPAM_URL.test(p.url || '') || SPAM_URL.test(p.pdf_url || '')) return true;
  if (SPAM_VENUE.test(p.venue || '')) return true;
  if (SPAM_TITLE.test(p.title || '')) return true;
  const authors = Array.isArray(p.authors) ? p.authors : [];
  if (authors.some((a) => SPAM_AUTHOR.test(String(a)))) return true;
  return false;
}

export function extractArxivId(url) {
  const m = String(url || '').match(/arxiv\.org\/(?:abs|pdf|html)\/(\d{4}\.\d{4,5})/i);
  return m ? m[1] : null;
}

/* First ~2 sentences of an abstract, for fallback summaries. */
export function autoSummary(abstract) {
  if (!abstract) return null;
  const clean = abstract.replace(/\s+/g, ' ').trim();
  const sentences = clean.match(/[^.!?]+[.!?]+(?:\s|$)/g) || [clean];
  let out = '';
  for (const s of sentences) {
    out += s;
    if (out.length > 180) break;
  }
  out = out.trim();
  return out.length > 420 ? out.slice(0, 417).trimEnd() + '…' : out;
}

const SOURCE_PRIORITY = ['transformer-circuits', 'alignment-blog', 'anthropic-site', 'openai-site', 'deepmind-site', 'arxiv-sweep', 'arxiv', 'openalex'];

export function sourceRank(s) {
  const i = SOURCE_PRIORITY.indexOf(s);
  return i === -1 ? SOURCE_PRIORITY.length : i;
}

/* Merge duplicate records: keep richest fields, prefer lab-site canonical URLs. */
export function mergeRecords(a, b) {
  const [hi, lo] = sourceRank(a.source) <= sourceRank(b.source) ? [a, b] : [b, a];
  return {
    ...lo,
    ...Object.fromEntries(Object.entries(hi).filter(([, v]) => v != null && v !== '' && !(Array.isArray(v) && !v.length))),
    authors: (hi.authors && hi.authors.length ? hi.authors : lo.authors) || [],
    abstract: longest(hi.abstract, lo.abstract),
    summary: hi.summary || lo.summary || null,
    topics: (hi.topics && hi.topics.length ? hi.topics : lo.topics) || [],
    arxiv_id: hi.arxiv_id || lo.arxiv_id || null,
    pdf_url: hi.pdf_url || lo.pdf_url || null,
    venue: hi.venue || lo.venue || null,
    cited_by: Math.max(hi.cited_by || 0, lo.cited_by || 0) || null,
    org: hi.org !== 'other' ? hi.org : lo.org,
    sources: [...new Set([...(hi.sources || [hi.source]), ...(lo.sources || [lo.source])])],
  };
}

function longest(a, b) {
  return (a || '').length >= (b || '').length ? a || null : b || null;
}
