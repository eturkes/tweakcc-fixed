// Continuity hints for classify candidates: which id a string LOST this
// release it most likely still is. A verbatim port of the showtime driver's
// attachContinuity (driver.mjs classify-candidates), so the evidence builder
// can fill hints a candidate file arrived without: on the CC 2.1.288 replay,
// seven candidates whose 2.1.286 id had left the catalogue reached the
// packets without reusedFrom/possibleSuccessorOf, were minted fresh ids, and
// would have orphaned their LCC overrides. Keep the two copies identical.
export function attachContinuity(cands, currentPrompts, prevPrompts, { log = () => {}, prevVer = 'previous' } = {}) {
  if (!cands.length || !prevPrompts.length) return;

  const body = (p) => (p.pieces || []).filter((x) => typeof x === 'string').join('') || p.content || '';
  const CAP = 20000; // the 100KB HTML templates dominate cost and need no more

  // Shingles must be SHIFT-INVARIANT. Sampling at fixed character offsets
  // (`i += 4`) looks equivalent and is not: inserting one character rebases every
  // later window, so skill-artifact-pr-review-html-template — 81,580 of 81,581
  // bytes unchanged, one edit at offset 491 — scored 0.33. Word shingles keyed by
  // a hash of their CONTENT are unaffected by position, and hash-sampling keeps
  // the index small without reintroducing an offset dependency.
  const shingles = (s) => {
    const t = s.slice(0, CAP).toLowerCase().split(/\s+/).filter(Boolean).slice(0, 4000);
    const out = new Set();
    const n = Math.max(0, t.length - 4);
    // Hash-sampling exists to bound the index on 4,000-word templates. A short
    // prompt has few windows to begin with, so sampling it throws away the signal
    // instead of bounding anything — keep every window below the cutoff. Dropping
    // to 2-word windows instead would trade that for false matches between the
    // near-identical sibling tool-results this catalogue is full of.
    const sample = n >= 512;
    for (let i = 0; i + 5 <= t.length; i++) {
      let h = 5381;
      const w = t[i] + ' ' + t[i + 1] + ' ' + t[i + 2] + ' ' + t[i + 3] + ' ' + t[i + 4];
      for (let j = 0; j < w.length; j++) h = (Math.imul(h, 33) ^ w.charCodeAt(j)) | 0;
      if (!sample || (h & 7) === 0) out.add(h);
    }
    return out;
  };

  // Shingles need >= 5 words to produce a single window, so a SHORT prompt gets an
  // empty set and silently no continuity at all — and short model-facing strings
  // are precisely what this catalogue exists to cover since the length floor came
  // off. On CC 2.1.237 that lost 8 reworded ids whose body was byte-identical once
  // slot expressions are normalized, `system-prompt-system-reminder-framing-tag`
  // (2 words) among them.
  //
  // The fix is NOT a smaller window. Measured on this bump, dropping to 3- and
  // 2-word windows recovered 3 more ids and simultaneously bound
  // `tool-result-artifact-live-doc-published` to `tool-result-artifact-publish-success`
  // and `…live-subscription-arming` to `…watch-permission-required` — a false
  // reuse is worse than a missed one, because it silently binds an override to
  // another prompt's content. Exact equality after normalization carries no such
  // risk, so it runs as its own higher-confidence pass, and a normalized body that
  // more than one previous id shares is skipped rather than guessed at.
  // Continuity exists to keep a prompt bound to an id it LOST. A previous id
  // that is still in the current catalogue did not lose its name, so a candidate
  // resembling it is a different string — a sibling, a near-duplicate, or a new
  // site — and "reusing" that id mints a duplicate. Measured on CC 2.1.237: 7 of
  // 40 hints pointed at live ids (one at similarity 1.000 after normalization,
  // six shingle hits at 0.80-0.917), and because the caller authorises a hinted
  // id against the collision check, every one of them would have been waved
  // through. Restrict the previous-catalogue index to ids that are actually gone.
  const live = new Set(
    currentPrompts.filter((p) => p.id).map((p) => p.id)
  );
  const normBody = (s) => s.replace(/\$\{[^}]*\}/g, '${}').replace(/\s+/g, ' ').trim().toLowerCase();
  // A RUN of adjacent slots collapses to one: CC 2.1.267 inserted one slot into
  // a ten-slot run (`${(.url)}${(.seq)}`, and 10 -> 11 trailing `${}`), so the
  // per-slot form differed while every word of prose was identical. Two such
  // rewordings (updated-from-type, publish-published-at) score 1.00 collapsed.
  const collapse = (s) => normBody(s.replace(/(\$\{[^}]*\})+/g, '${}'));
  const exact = new Map();
  const exactCollapsed = new Map();
  const prev = [];
  const weak = [];
  for (const p of prevPrompts) {
    if (!p.id || live.has(p.id)) continue;
    const nb = normBody(body(p));
    if (nb) {
      if (exact.has(nb)) { if (exact.get(nb) !== p.id) exact.set(nb, null); }
      else exact.set(nb, p.id);
    }
    const cb = collapse(body(p));
    if (cb) {
      if (exactCollapsed.has(cb)) { if (exactCollapsed.get(cb) !== p.id) exactCollapsed.set(cb, null); }
      else exactCollapsed.set(cb, p.id);
    }
    weak.push({ id: p.id, g: shingles(cb) });
    const g = shingles(body(p));
    if (!g.size) continue;
    prev.push({ id: p.id, g });
  }
  for (const c of cands) {
    const id = exact.get(normBody(c.body)) || exactCollapsed.get(collapse(c.body));
    if (id) c.reusedFrom = { id, similarity: 1 };
  }
  const index = new Map();
  prev.forEach((e, i) => { for (const g of e.g) { let a = index.get(g); if (!a) index.set(g, (a = [])); a.push(i); } });

  for (const c of cands) {
    if (c.reusedFrom) continue; // an exact normalized-body hit already decided this one
    const cg = shingles(c.body);
    if (!cg.size) continue;
    const score = new Map();
    for (const g of cg) { const a = index.get(g); if (a) for (const i of a) score.set(i, (score.get(i) || 0) + 1); }
    let bestI = -1, bestS = 0;
    for (const [i, s] of score) {
      const sim = s / Math.min(cg.size, prev[i].g.size);
      if (sim > bestS) { bestS = sim; bestI = i; }
    }
    // 0.80 keeps genuine restructures (Anthropic splitting one prompt into
    // several scored 0.41-0.73 on 2.1.228) out, while catching the pure renames
    // that scored 0.97-0.99.
    if (bestI >= 0 && bestS >= 0.8) c.reusedFrom = { id: prev[bestI].id, similarity: Number(bestS.toFixed(3)) };
  }
  const n = cands.filter((c) => c.reusedFrom).length;
  if (n) log((`continuity: ${n}/${cands.length} candidate(s) match a ${prevVer} prompt >=0.80 — reuse that id`));

  // ADVISORY pass for rewordings the 0.80 bar cannot license. On CC 2.1.267 ten
  // same-role rewordings of removed ids got fresh ids (the artifact responsive
  // rule grew fourfold and scored 0.38), orphaning three real trims/wipes, and
  // only a manual pass over the removed-id list found them. Lowering the bar is
  // not the fix — a false reuse binds an override to another prompt's content —
  // so this hint does not authorise anything: it names the removed id (the
  // evidence packet adds the old body), and reuse stays a judgement about ROLE. Scored on
  // slot-collapsed bodies; 0.35 surfaced 7 of the 10 with two split halves as the
  // only other hits, which the one-id-per-batch rule already handles.
  let w = 0;
  for (const c of cands) {
    if (c.reusedFrom) continue;
    const cg = shingles(collapse(c.body));
    if (!cg.size) continue;
    let bestId = null, bestS = 0;
    for (const e of weak) {
      if (!e.g.size) continue;
      let hit = 0;
      for (const g of cg) if (e.g.has(g)) hit++;
      const sim = hit / Math.min(cg.size, e.g.size);
      if (sim > bestS) { bestS = sim; bestId = e.id; }
    }
    if (bestId && bestS >= 0.35) {
      c.possibleSuccessorOf = { id: bestId, similarity: Number(bestS.toFixed(3)) };
      w++;
    }
  }
  if (w) log((`continuity: ${w} more candidate(s) resemble a REMOVED ${prevVer} id (0.35-0.80) — advisory possibleSuccessorOf, reuse only on identical role`));
}

