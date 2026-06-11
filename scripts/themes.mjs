/* Hyper-specific research themes: regex (for tagging) + OpenAlex search
   queries (for bulk topic collection). Order defines the client bitmask —
   append only, never reorder. */
export const THEMES = [
  ['Reward hacking', /reward.?(hack|tamper|gam(e|ing))|specification gaming|reward overoptimi/, ['"reward hacking"', '"specification gaming"', '"reward tampering"']],
  ['Sparse autoencoders', /sparse autoencoder|\bsaes?\b|dictionary learning|crosscoder|transcoder/, ['"sparse autoencoder"', '"crosscoders"']],
  ['Superposition', /superposition|polysemantic|monosemantic/, ['"polysemanticity"', '"monosemanticity"', '"superposition" AND "neural networks"']],
  ['Circuits & features', /induction head|attribution graph|circuit (analysis|tracing|discovery)|transformer circuit|feature circuit/, ['"induction heads"', '"circuit discovery" AND "interpretability"', '"attribution graphs" AND "language models"']],
  ['CoT faithfulness & monitoring', /(chain.of.thought|\bcot\b|reasoning trace)[^.]{0,80}(faithful|monitor|legib)|(faithful|monitor)[^.]{0,80}(chain.of.thought|\bcot\b|reasoning trace)/, ['"chain-of-thought" AND "faithfulness"', '"chain-of-thought monitoring"', '"unfaithful reasoning"']],
  ['Alignment faking & deception', /alignment faking|deceptive alignment|scheming|sandbagging|sleeper agent|strategic deception/, ['"alignment faking"', '"deceptive alignment"', '"sleeper agents"', '"sandbagging" AND "language models"']],
  ['Jailbreaks & prompt injection', /jailbreak|prompt injection|universal (adversarial|attack)/, ['"jailbreak" AND "language models"', '"prompt injection"']],
  ['RLHF & preference learning', /\brlhf\b|human feedback|preference (model|learning|optimi)|\bdpo\b/, ['"reinforcement learning from human feedback"', '"direct preference optimization"']],
  ['Constitutional AI & RLAIF', /constitutional ai|\brlaif\b|ai feedback/, ['"constitutional AI"', '"RLAIF"']],
  ['Scaling laws', /scaling law|compute.optimal|chinchilla/, ['"scaling laws" AND "language models"', '"compute-optimal"']],
  ['Emergent abilities', /emergent (abilit|behavi|capabilit)|emergence of/, ['"emergent abilities" AND "language models"']],
  ['In-context learning', /in.context learning|few.shot learn/, ['"in-context learning"']],
  ['Test-time compute', /test.time (compute|scaling|search)|inference.time (compute|scaling)|reasoning model|thinking (budget|tokens)/, ['"test-time compute"', '"test-time scaling"', '"inference-time scaling"']],
  ['Process supervision', /process (supervision|reward)|\bprm\b|step.level (reward|verif)/, ['"process supervision" AND "language models"', '"process reward model"']],
  ['Scalable oversight & debate', /weak.to.strong|scalable oversight|recursive reward|ai safety via debate|\bdebate\b/, ['"scalable oversight"', '"weak-to-strong generalization"', '"AI safety via debate"']],
  ['Sycophancy', /sycophan/, ['"sycophancy"']],
  ['Introspection & self-awareness', /situational awareness|introspect|self.aware|self.knowledge/, ['"situational awareness" AND "language models"', '"introspection" AND "language models"']],
  ['AI control', /ai control|control protocol|untrusted (model|monitor)|trusted monitoring/, ['"AI control" AND "untrusted"', '"trusted monitoring" AND "AI"']],
  ['Model welfare', /model welfare|ai welfare|moral (status|patienthood)|digital minds/, ['"model welfare"', '"AI welfare"', '"moral patienthood"']],
  ['Dangerous-capability evals', /dangerous capabilit|biorisk|biosecurity|\bcbrn\b|uplift (stud|trial|evaluation)|frontier safety/, ['"dangerous capabilities" AND "AI"', '"biosecurity" AND "language models"']],
  ['Steering & activation editing', /steering vector|activation (steering|engineering|patch|addition)|representation engineering/, ['"activation steering"', '"steering vectors" AND "language models"', '"representation engineering"', '"activation patching"']],
  ['Probing & linear representations', /linear (probe|representation|direction)|probing classifier/, ['"linear probe" AND "language models"', '"linear representations" AND "language models"', '"probing classifiers"']],
  ['Influence & data attribution', /influence function|(training )?data attribution/, ['"influence functions" AND "neural"', '"training data attribution"']],
  ['Hallucination & calibration', /hallucinat|confabul|calibrat/, ['"hallucination" AND "language models"', '"calibration" AND "language models"']],
  ['Unlearning', /unlearn/, ['"machine unlearning"']],
  ['Watermarking', /watermark/, ['"watermarking" AND "language models"', '"watermark" AND "generative models"']],
  ['Backdoors & poisoning', /backdoor|data poison|poisoning attack/, ['"backdoor attack" AND "language models"', '"data poisoning" AND "neural"']],
  ['Mixture of experts', /mixture.of.experts|\bmoe\b|sparse expert/, ['"mixture of experts" AND "language models"']],
  ['Automated auditing', /automated audit|auditing agent|alignment audit|audit(ing)? game|blind audit/, ['"alignment auditing"', '"auditing agents" AND "AI"', '"automated auditing" AND "models"']],
  ['Mid-training', /mid.?train/, ['"mid-training" AND "language models"', '"midtraining"']],
  ['Emergent misalignment', /emergent misalignment|broad(ly)? misalign|misalignment generali|narrow(ly trained)? task.{0,40}misalign/, ['"emergent misalignment"']],
  ['Subliminal learning', /subliminal|hidden signals in data|trait transmission|behaviou?ral traits (via|through)/, ['"subliminal learning" AND "language models"']],
  ['Reversal curse & negation', /reversal curse|negation/, ['"reversal curse"', '"negation" AND "language models"']],
  ['Evaluation awareness', /evaluation awareness|eval.?aware|test.?aware|recogni[sz]e[^.]{0,40}(being )?(test|evaluat)|knows? (it is|they are) being (test|evaluat)/, ['"evaluation awareness" AND "models"']],
  ['Model organisms', /model organism/, ['"model organisms" AND "misalignment"']],
  ['Persona & character', /persona vector|character train|assistant persona|model persona/, ['"persona vectors"', '"character training" AND "language models"']],
  // emerging themes mined from 2025-26 titles (June 2026)
  ['Retrieval-augmented generation', /retrieval.augmented|retrieval augmentation|\brag\b/, ['"retrieval-augmented generation"']],
  ['Multi-agent systems', /multi.agent|agent (framework|team|societ|swarm)|llm.based agents/, ['"multi-agent" AND "large language models"']],
  ['Computer-use & web agents', /computer.use|web (agent|navigation)|gui agent|browser agent|\bos agents?\b/, ['"web agents"', '"GUI agents"', '"computer use" AND "agents"']],
  ['Tool use & MCP', /model context protocol|\bmcp\b|function calling|tool (calling|use|learning)/, ['"model context protocol"', '"function calling" AND "language models"', '"tool use" AND "language models"']],
  ['Reward models', /reward model/, ['"reward model" AND "language models"', '"reward modeling"']],
  ['Inference efficiency', /kv.cache|speculative decod|inference (efficien|acceler)|efficient (inference|serving)/, ['"KV cache"', '"speculative decoding"', '"efficient inference" AND "language models"']],
  ['World models & video gen', /world model|video (generation|diffusion)|interactive environment/, ['"world models" AND (learning OR agents)', '"video generation"']],
  ['Spatial reasoning', /spatial reasoning|spatial (understanding|intelligence)/, ['"spatial reasoning" AND "models"']],
];

/* umbrella queries that keep the broad topic curves honest */
export const UMBRELLA_QUERIES = [
  '"mechanistic interpretability"',
  '"AI alignment"',
  '"AI safety" AND "language models"',
  '"interpretability" AND "large language models"',
  '"red teaming" AND "language models"',
  '"adversarial robustness" AND "language models"',
  '"language model" AND "evaluation benchmark"',
  '"LLM agents"',
];

export function themeMask(hay) {
  let lo = 0, hi = 0;
  for (let i = 0; i < THEMES.length; i++) {
    if (THEMES[i][1].test(hay)) { if (i < 28) lo |= (1 << i); else hi |= (1 << (i - 28)); }
  }
  return [lo, hi];
}
