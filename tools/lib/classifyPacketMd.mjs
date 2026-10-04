// The markdown form of a classify evidence chunk: what an agent reads with ONE
// Read call instead of parsing chunk-NN.json in many python snippets and then
// probing the bundle for what the JSON leaves out.
//
// Per family (the function that emits the strings): its head, the call sites
// that reach it three levels up WITH the branch condition each call sits
// behind, the options those conditions test and where in the bundle each
// option is SET, and the cached facing of every other literal the function
// emits (the catalogued siblings a family verdict must agree with). Per
// candidate: the full body, every site with the minified code around it, the
// conditions it sits behind, the traced route with the code at each sink and
// open branch, the continuity / piebald data, the nearest catalogued prompts,
// and its rewrite-table role. All of it is evidence the agent must still read
// and judge; none of it is a verdict.
import { pieceText } from './bundleQuery.mjs';

const oneLine = s => String(s).replace(/\s+/g, ' ');
const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);
// Inline code that cannot be broken by a backtick inside it.
export const code = s => {
  const t = oneLine(s);
  const runs = t.match(/`+/g) || [];
  const fence = '`'.repeat(Math.max(0, ...runs.map(r => r.length)) + 1);
  return `${fence}${/^`|`$/.test(t) ? ' ' : ''}${t}${/^`|`$/.test(t) ? ' ' : ''}${fence}`;
};
// A body as a quoted block, every line kept.
const quoteBody = body => {
  const lines = String(body).split('\n');
  return lines.map(l => `> ${l}`).join('\n');
};
const offsetOf = at => {
  const m = /^(\d+)/.exec(String(at ?? ''));
  return m ? Number(m[1]) : null;
};
const fnLabel = f => (f ? `${f.name ? `${f.name} ` : ''}@${f.start}` : '(module scope)');

// ---- nearest catalogued prompts -------------------------------------------
const WORD = /[a-z][a-z0-9'-]{2,}/g;
const wordsOf = s => new Set((String(s).toLowerCase().match(WORD) || []));

export function catalogueNeighbourIndex(prompts, { maxDf = 400 } = {}) {
  const entries = [];
  const seen = new Set();
  for (const p of prompts) {
    if (!p.id) continue;
    const body = pieceText(p);
    const key = `${p.id}\u0000${body}`;
    if (seen.has(key) || body.length < 12) continue;
    seen.add(key);
    entries.push({ id: p.id, body, words: wordsOf(body) });
  }
  const postings = new Map();
  entries.forEach((e, i) => {
    for (const w of e.words) (postings.get(w) || postings.set(w, []).get(w)).push(i);
  });
  return {
    nearest(body, { k = 3, min = 0.34 } = {}) {
      const ws = wordsOf(body);
      if (!ws.size) return [];
      const hits = new Map();
      for (const w of ws) {
        const list = postings.get(w);
        if (!list || list.length > maxDf) continue;
        for (const i of list) hits.set(i, (hits.get(i) || 0) + 1);
      }
      const scored = [];
      for (const [i, inter] of hits) {
        const e = entries[i];
        const score = inter / (ws.size + e.words.size - inter);
        if (score >= min && e.body !== body) scored.push({ id: e.id, score, body: e.body });
      }
      scored.sort((a, b) => b.score - a.score);
      const out = [];
      const ids = new Set();
      for (const s of scored) {
        if (ids.has(s.id)) continue;
        ids.add(s.id);
        out.push(s);
        if (out.length >= k) break;
      }
      return out;
    },
  };
}

// ---- rewrite tables ----------------------------------------------------------
export function rewriteRoles(pairs) {
  const roles = new Map();
  for (const p of pairs) {
    if (p.needle) roles.set(p.needle, 'needle');
    if (p.replacement && !roles.has(p.replacement)) roles.set(p.replacement, 'replacement');
  }
  return roles;
}

// ---- rendering ---------------------------------------------------------------
// Snippets shown once per chunk; a later mention points back.
export function snippetBook(src) {
  const shown = new Set();
  return (at, { before = 45, after = 75 } = {}) => {
    const o = offsetOf(at);
    if (o == null || !src) return '';
    if (shown.has(o)) return ' (code shown above)';
    shown.add(o);
    return ` — ${code(clip(src.slice(Math.max(0, o - before), o + after), before + after + 2))}`;
  };
}

const guardText = (g, propSets, max = 100) => {
  const specific = g.props.filter(p => propSets && propSets.has(p));
  const props = specific.length ? ` [${specific.map(p => `${p}: ${propSets.get(p)}`).join('; ')}]` : '';
  return `${g.arm} of ${code(clip(g.test, max))}${props}`;
};

// Where an option is SET, one line: count + the first setters with values.
export function propSetLine(res) {
  const set = res.find(r => r.kind.startsWith('SET'));
  if (!set) return null;
  if (!set.total) return 'never set anywhere in the bundle';
  const list = set.hits
    .slice(0, 4)
    .map(h => `${h.in ? fnLabel(h.in) : `@${h.at}`} ${h.detail}`.trim())
    .join(', ');
  return `set at ${set.total} site(s): ${list}${set.total > 4 ? ', …' : ''}`;
}

export function renderFamilyMd(f, { snip, propSets }) {
  const L = [];
  const n = f.candidateCount;
  L.push(`## ${f.label} · ${f.fn ? `fn ${fnLabel(f.fn)} [${f.fn.module}] len ${f.fn.end - f.fn.start}` : f.key} — ${n} candidate(s)${f.split ? ` (part ${f.split.part} of ${f.split.of})` : ''}`);
  if (f.fn) L.push(code(clip(f.fn.head, 110)));
  if (f.callers && f.callers.levels.length) {
    for (const x of f.callers.levels[0]) {
      const extra = [
        x.roles.length ? `roles ${x.roles.join(', ')}` : '',
        x.jsxType.length ? `JSX component @${x.jsxType.join(',')}` : '',
        x.hofs.length ? `handed to ${x.hofs.map(h => `${h.hof}@${h.cs}`).join(', ')}` : '',
        x.unresolved.length ? `open: ${x.unresolved.join('; ')}` : '',
      ].filter(Boolean);
      const calls = x.calls.map(c => `${fnLabel(c.in)}${c.outer ? ` (callback in ${fnLabel(c.outer)})` : ''} @${c.at}${c.guards.length ? ` behind ${c.guards.map(g => guardText(g, propSets, 60)).join(' and ')}` : ''}`);
      L.push(`Called ${x.total}×${calls.length ? `: ${calls.join('; ')}` : ''}${x.total > x.calls.length ? '; …' : ''}${extra.length ? ` (${extra.join('; ')})` : ''} — deeper: bundleQuery {"callers":${x.fn.start},"depth":3}`);
    }
  }
  if (f.setters && f.setters.length) {
    L.push(`Setter props of this function (minified local = prop; which one a call uses decides where its value goes): ${f.setters.map(([k, l]) => `${l}=${k}`).join(', ')}`);
    for (const w of (f.wiring && f.wiring.sites) || []) {
      const crosswise = w.props.filter(([k, v]) => /^set[A-Z]/.test(k) && /set[A-Z]\w*$/.test(v) && !v.endsWith(k));
      L.push(`  - wired ${w.how === 'jsx' ? 'by a JSX render' : 'by a call'} @${w.at} in ${fnLabel(w.in)}: ${w.props.map(([k, v]) => `${k}=${v}`).join(', ') || '(no setter props passed)'}${crosswise.length ? ` — CROSSWISE: ${crosswise.map(([k, v]) => `${k} is ${v}`).join(', ')}` : ''}`);
    }
    if (f.wiring && f.wiring.total > f.wiring.sites.length) L.push(`  - … ${f.wiring.total - f.wiring.sites.length} more caller(s) (bundleQuery {"aliases":${f.fn ? f.fn.start + 1 : 0}})`);
  }
  if (f.literals) {
    const s = f.literals;
    const parts = [`${s.total} literal(s) in this function`];
    if (s.thisRun) parts.push(`${s.thisRun} are candidates of this run`);
    if (s.counts.model) parts.push(`${s.counts.model} cached model`);
    if (s.counts.ui) parts.push(`${s.counts.ui} cached ui`);
    if (s.counts.internal) parts.push(`${s.counts.internal} cached internal`);
    if (s.counts.uncached) parts.push(`${s.counts.uncached} never classified (short/non-prose)`);
    L.push(`Siblings: ${parts.join(', ')}.`);
    for (const x of s.shown) L.push(`  - @${x.at} ${x.facing}: ${code(clip(x.text, 90))}`);
    if (s.more) L.push(`  - … ${s.more} more cached sibling(s) (bundleQuery {"siblings":${f.fn ? f.fn.start : 0}})`);
  }
  return L.join('\n');
}

export function renderCandidateMd(e, { snip, propSets, src }) {
  const L = [];
  const tags = [`${e.len} ch`, e.source];
  if (e.cachedFacing) tags.push(`gate hint: ${e.cachedFacing}`);
  L.push(`### ${e.key} · ${e.hash.slice(0, 12)} · ${tags.join(' · ')}`);
  L.push(quoteBody(e.body));
  if (e.rewriteRole === 'needle') L.push('**Rewrite table: this body is a NEEDLE** (the match key of a `[[needle, replacement]]` pair) — the model never sees it.');
  else if (e.rewriteRole === 'replacement') L.push('**Rewrite table: this body is a REPLACEMENT**, rendered into another catalogued description.');
  if (!e.sites.length) L.push('sites: none located (search the bundle: bundleQuery {"text":…})');
  e.sites.forEach((s, i) => {
    const flags = [s.kind, s.fragment ? 'fragment' : '', s.textMatch ? 'text match' : ''].filter(Boolean).join(', ');
    if (i < 1 && src) {
      const before = src.slice(Math.max(0, s.start - 130), s.start);
      const lit = src.slice(s.start, s.end);
      const after = src.slice(s.end, s.end + 80);
      L.push(`site @${s.start} (${flags}): ${code(`${before}⟦${lit.length > 70 ? `${lit.slice(0, 34)}…${lit.slice(-30)}` : lit}⟧${after}`)}`);
      snip(s.start);
    } else L.push(`site @${s.start} (${flags})`);
    if (s.route) L.push(`  route at this site: ${s.route.verdict || 'open'}${s.route.sinks ? `; ${s.route.sinks.map(k => `${k.kind}[${k.facing ?? 'open'}]@${k.at}`).join(', ')}` : ''}`);
  });
  if (e.siteCount > e.sites.length) L.push(`… ${e.siteCount - e.sites.length} more site(s)`);
  if (e.inner && e.familyFn && e.inner.start !== e.familyFn) L.push(`in ${fnLabel(e.inner)} ${code(clip(e.inner.head, 80))}`);
  for (const g of e.guards || []) L.push(`guard: ${guardText(g, propSets)}`);
  const r = e.route || {};
  const head = r.verdict === 'model' ? `model${r.resolved ? '' : ' (other branches open)'}` : r.verdict ? `${r.verdict} (every branch followed)` : `open (${r.openTotal || 0} open branch(es))`;
  L.push(`route: ${head}`);
  let undecided = 0;
  for (const s of r.sinks || []) {
    const show = s.facing === 'model' || undecided++ < 2;
    const al = e.calleeAliases && e.calleeAliases[s.at] ? ` [callee ${e.calleeAliases[s.at]}]` : '';
    L.push(`- sink ${s.kind} [${s.facing ?? 'undecided'}] @${s.at}${al}${s.command ? ` /${s.command}` : ''}${s.display != null ? ` display:${s.display}` : ''}${s.guarded ? ' (behind an instanceof guard)' : ''}${s.via ? ` via ${s.via}` : ''}${show ? snip(s.at) : ''}`);
  }
  if (e.outboundControl) L.push(`- **outbound control message nearby** (control_response/control_request in the code at ${e.outboundControl.join(', ')}): a permission deny sent to a remote client is transport, not a local tool_result — confirm the value reaches the local permission result before ruling model.`);
  for (const g of e.modelPath || []) L.push(`- model path passes ${g.hop}@${g.hopAt} ${guardText(g, propSets)}`);
  if (e.sinkEntry) {
    const se = e.sinkEntry;
    const entries = se.calls.map(c => `${c.how === 'jsx' ? 'rendered as JSX' : 'called'} @${c.at} in ${fnLabel(c.in)}${c.guards.length ? ` behind ${c.guards.map(g => guardText(g, propSets, 70)).join(' and ')}` : ''}`);
    L.push(`- the model sink's function ${fnLabel(se.fn)} is entered ${se.total}×${entries.length ? `: ${entries.join('; ')}` : ''}${se.total > se.calls.length ? '; …' : ''}`);
  }
  if (r.nonModel) L.push(`- non-model sinks: ${Object.entries(r.nonModel).map(([k, n]) => `${k} ×${n}${r.nonModelAt && r.nonModelAt[k] != null ? ` (@${r.nonModelAt[k]})` : ''}`).join(', ')}`);
  (r.open || []).forEach((o, i) => {
    const m = /^(.*) @([\d+?]+)$/.exec(o);
    const al = m && e.calleeAliases && e.calleeAliases[m[2]] ? ` [callee ${e.calleeAliases[m[2]]}]` : '';
    L.push(`- open: ${m ? `${m[1]} @${m[2]}${al}${i < 2 ? snip(m[2]) : ''}` : o}`);
  });
  if (r.openTotal > (r.open || []).length) L.push(`- … ${r.openTotal - (r.open || []).length} more open branch(es) (bundleQuery {"trace":${e.sites[0] ? e.sites[0].start : 0}})`);
  if (e.reusedFrom) L.push(`reusedFrom: **${e.reusedFrom.id}**${e.reusedFrom.similarity != null ? ` (similarity ${e.reusedFrom.similarity})` : ''}${e.reusedFromOldBody != null ? `; old body: ${code(clip(e.reusedFromOldBody, 1500))}` : ''}`);
  if (e.possibleSuccessorOf) L.push(`possibleSuccessorOf: **${e.possibleSuccessorOf.id}**${e.possibleSuccessorOf.similarity != null ? ` (similarity ${e.possibleSuccessorOf.similarity})` : ''}${e.possibleSuccessorOldBody != null ? `; old body: ${code(clip(e.possibleSuccessorOldBody, 1500))}` : ''}`);
  for (const l of e.removedIdLeads || []) L.push(`removed-id lead (shares ${l.windows} 25-char run(s); advisory): **${l.id}** — old body: ${code(clip(l.oldBody || '', 600))}`);
  if (e.piebaldExact) L.push(`piebaldExact: **${e.piebaldExact.id}** — name ${code(e.piebaldExact.name)}, desc ${code(clip(e.piebaldExact.desc, 240))}`);
  if (e.settingsOracle) L.push(`**Settings oracle:** this text ${e.settingsOracle === 'exact' ? 'IS' : 'is part of'} a settings-schema description in the pristine /update-config capture — the model is sent it (facing model unless it starts with @internal).`);
  if (e.joinOf) L.push(`**JOIN of fragments:** this body concatenates ${e.joinOf.keys.join(', ')}${e.joinOf.allFragmentsAreCandidates ? '' : ' and literal text that is not a candidate'} — ids belong on fragments: never give this join a fragment's id or the continuity id a fragment lost${e.joinOf.fragmentIds && e.joinOf.fragmentIds.length ? ` (${e.joinOf.fragmentIds.join(', ')})` : ''}; a model-facing join takes its own id.`);
  if (e.allowedIds && e.allowedIds.length) L.push(`allowedIds (catalogue ids this candidate may keep): ${e.allowedIds.join(', ')}`);
  if (e.near && e.near.length) L.push(`nearest catalogued: ${e.near.map(n => `${n.id} (${n.score.toFixed(2)}) ${code(clip(n.body, 110))}`).join('; ')}`);
  return L.join('\n');
}

export function renderChunkHeaderMd(h) {
  return [
    `# Classify chunk ${h.chunk} of ${h.chunkCount} — Claude Code ${h.version}`,
    `${h.candidates} candidate(s) in ${h.families} famil${h.families === 1 ? 'y' : 'ies'}. Candidates are named by key (k01…); the write step maps keys to the full hashes in ${h.jsonPath} (do not open that file).`,
    '',
    'Commands (run from the repo checkout):',
    `- write + check, one step: \`${h.writeCmd} <<'V'\` then a JSON array \`[{"k":"k01","facing":"ui","id":null,"name":null,"desc":null,"evidence":"…"}, …]\` then \`V\`. It fills hashes, bundleSha and corpusDigest, nulls id/name/desc on non-model verdicts, merges with what is already on disk (re-send only the entries you fix), writes the verdict file and prints the checker result.`,
    `- bundle lookups, MANY per call: \`${h.queryCmd} <<'Q'\` then a JSON array of queries then \`Q\`. Kinds: {"slice":N}, {"fn":N}, {"callers":N,"depth":2}, {"refs":"name","at":N}, {"prop":"optionName"}, {"guards":N}, {"text":"literal"}, {"regex":"src"}, {"trace":N}, {"siblings":N}, {"aliases":N}, {"catalogue":"text or id fragment"}.`,
    `- the bundle ${h.bundlePath} is one 40 MB line: never grep, cat or python it — query it. The catalogue (${h.promptsJson}) and existing ids are searched with {"catalogue":…}; the write step rejects an id collision.`,
    '',
    'How to read: `## F…` blocks describe one emitting function (callers with the branch each call sits behind, option set-sites, cached sibling facings); `### k…` blocks are the candidates of the family above them. ⟦…⟧ marks the literal inside its site code; "(code shown above)" points to a snippet already printed.',
  ].join('\n');
}

export function renderVerifyMd({ header, families, items }) {
  const L = [header, ''];
  let lastFam = null;
  for (const it of items) {
    if (it.family !== lastFam) {
      const f = families.get(it.family);
      if (f) L.push(f, '');
      lastFam = it.family;
    }
    L.push(it.md);
    L.push(`**Draft (in scope: ${it.why.join('; ')}):** facing ${it.draft.facing}${it.draft.id ? `, id ${it.draft.id}, name ${code(it.draft.name || '')}, desc ${code(it.draft.desc || '')}` : ''}; evidence: ${code(it.draft.evidence || '')}`);
    L.push('');
  }
  return L.join('\n');
}
