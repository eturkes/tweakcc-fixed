// Cut leads for the stage-1 cut-hunt pass.
//
// Stage 1 on short packets leans "keep" on borderline cuts: on the CC 2.1.288
// replay it ruled 450/451 pristine-keep, missed the real run's one wipe (a
// sentence restated by a sibling tool result) and caught 1 of 10 recall
// seeds. The cut hunt re-reads only the keeps whose packet evidence makes a
// cut plausible, with an agent whose job is to argue the strongest legitimate
// cut and then say whether it holds.
//
// Selection is deterministic and evidence-only: it decides who gets a second
// read, never a verdict. Every lead names its carrier and why it counts; the
// score only ranks ids so the pass stays within its budget (a share of the
// keeps), strongest evidence first.
import { mdModel } from './auditPacketMd.mjs';
import { sameToolSchema } from './auditCorpus.mjs';

// Relations under which a carrier often renders with the target. Syntactic
// hints only — the hunt agent must prove co-render. "same-branch" is weak on
// its own: CC's switch-of-alternative-messages shape puts sibling messages
// that are chosen INSTEAD of each other in one branch.
const COREND = new Set(['same-tool', 'carrier-outside-target-branch', 'carrier-conditional', 'condition-relation', 'nested-function', 'module-scope']);

export const LEAD_THRESHOLDS = {
  claimShare: 0.5, // share of the id's claims a carrier restates
  termsScore: 0.6, // a bag-of-words claim hit counts at this score
  neighbour: 0.45, // nearest deployed body similarity
  sameTool: 0.25, // similarity to the tool's own description/schema
};

const cosine = (index, a, b) => {
  const va = index.vec[a];
  const vb = index.vec[b];
  if (!va || !vb) return 0;
  let dot = 0;
  for (const [t, x] of va.w) dot += x * (vb.w.get(t) || 0);
  return dot / ((va.n || 1) * (vb.n || 1));
};

// leads for one packet entry, each with a weight; [] = no reason to re-read.
export function cutLeads(index, prompt, t = LEAD_THRESHOLDS) {
  const m = mdModel({ index, src: null, prompt, entries: null });
  const leads = [];
  const claims = m.search.claims.length || 1;
  for (const c of m.search.carriers) {
    const doc = index.docs[c.idx];
    if (!doc || doc.suppressed || c.id === prompt.id) continue;
    const terms = [...c.terms].filter(([, s]) => s >= t.termsScore).map(([i]) => i);
    const hit = new Set([...c.exact, ...terms]);
    const share = hit.size / claims;
    if (share < t.claimShare) continue;
    const exact = c.exact.size / claims;
    let w;
    if (COREND.has(c.rel)) w = share >= 0.99 ? 3 : 2;
    else if (c.rel === 'same-branch') w = share >= 0.99 ? 1.5 : 1;
    else if (c.rel === 'exclusive-arms') w = 0;
    else w = exact >= 0.99 ? 1 : 0.5; // restated in another function or module
    if (w > 0) leads.push({ kind: c.exact.size ? 'restated' : 'restated-terms', carrier: c.id, rel: c.rel, share: Number(share.toFixed(2)), weight: w });
  }
  for (const s of m.leads.siblings || []) {
    if (s.rel === 'same-branch' || s.rel === 'same-tool') leads.push({ kind: 'emitter-sibling', carrier: s.id, rel: s.rel, weight: s.rel === 'same-tool' ? 1.5 : 0.5 });
  }
  for (const tl of m.leads.tool || []) {
    if (tl.similarity >= t.sameTool) leads.push({ kind: 'same-tool-schema', carrier: tl.id, rel: 'same-tool', similarity: tl.similarity, weight: 3 });
    else if (tl.similarity >= 0.15 && prompt.pristineBodies.join('').length <= 300) {
      // A short tool-result suffix whose words its own tool's schema owns
      // (CC 2.1.224 ledger: a version-token hint restating if_version).
      leads.push({ kind: 'tool-result-suffix-vs-schema', carrier: tl.id, rel: 'same-tool', similarity: tl.similarity, weight: 2 });
    }
  }
  // A fragment of a tool's description against the rest of that tool's
  // description and parameters: they render together whenever the tool is
  // offered.
  const self = index.byId.get(prompt.id);
  if (self !== undefined && /^tool-(description|parameter)-/.test(prompt.id)) {
    const fam = [];
    index.docs.forEach((d, i) => {
      if (i !== self && !d.suppressed && sameToolSchema(prompt.id, d.id)) fam.push([d.id, cosine(index, self, i)]);
    });
    fam.sort((a, b) => b[1] - a[1]);
    for (const [id, sim] of fam.slice(0, 2)) if (sim >= t.sameTool) leads.push({ kind: 'same-tool-schema', carrier: id, rel: 'same-tool', similarity: Number(sim.toFixed(3)), weight: 3 });
  }
  for (const n of m.leads.neighbours || []) {
    const sim = Number(n.similarity);
    if (!(sim >= t.neighbour) || n.rel === 'exclusive-arms') continue;
    leads.push({ kind: 'near-body', carrier: n.id, rel: n.rel, similarity: sim, weight: COREND.has(n.rel) ? (sim >= 0.6 ? 2 : 1) : sim >= 0.7 ? 1 : 0.25 });
  }
  const best = new Map();
  for (const l of leads) {
    const k = `${l.kind}|${l.carrier}`;
    if (!best.has(k) || best.get(k).weight < l.weight) best.set(k, l);
  }
  return [...best.values()].sort((a, b) => b.weight - a.weight);
}

// Rank score: the strongest carrier, where a carrier named by two kinds of
// evidence (it restates a claim AND is the nearest body) counts both, plus a
// little for the other carriers.
export const leadScore = leads => {
  if (!leads.length) return 0;
  const per = new Map();
  for (const l of leads) {
    const e = per.get(l.carrier) || { w: 0, kinds: new Set() };
    e.w = Math.max(e.w, l.weight);
    e.kinds.add(l.kind.replace(/-terms$/, ''));
    per.set(l.carrier, e);
  }
  const w = [...per.values()].map(e => e.w + (e.kinds.size > 1 ? 1 : 0)).sort((a, b) => b - a);
  return Number((w[0] + 0.25 * w.slice(1, 4).reduce((a, b) => a + b, 0)).toFixed(3));
};
