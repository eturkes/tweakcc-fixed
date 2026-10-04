#!/usr/bin/env node
// Builds the per-group evidence packets the audit-new-prompts-stage{1,2,3}
// workflows read. An agent handed only an id has to rediscover the pristine
// body, every site of a repeated id, the four maintained-set paths, and which
// siblings might already carry the claim — so the packet assembles all of it
// once, and the fan-out spends its budget on judgment instead of lookup.
//
//   node tools/buildAuditPacket.mjs <prompts.json> <ids-file> <outDir> [groupSize]
//
// <ids-file> is one prompt id per line. Writes <outDir>/audit-packet-NN.md —
// what the stage-1 agent reads, in one Read call (tools/lib/auditPacketMd.mjs:
// the LCC decision rule, every body, the bundle code around each site, the
// precomputed corpus search and every carrier's deployed text) — beside
// <outDir>/audit-packet-NN.json (what the search, checker and harvest read),
// <outDir>/audit-meta.json (every override's frontmatter and the catalogue
// name, moved out of the packets), <outDir>/audit-manifest.json (inputs, their
// digests and the group list harvestAudit.mjs reconciles against),
// <outDir>/audit-groups.json, and <outDir>/corpus-index.v8 — the corpus index
// tools/auditCorpusSearch.mjs and tools/checkAuditVerdicts.mjs open. Prints
// the path-only workflow args on its last line.
//
// Packets are sized by the rendered markdown (TWEAKCC_AUDIT_MD_BUDGET bytes,
// default 48000: ~21k tokens at the ~2.3 chars/token measured on stage-1
// transcripts, under the Read tool's 25k-token cap);
// groupSize is only a cap on ids per packet. The LCC CLAUDE.md beside the
// reminders folder must carry the decision-rule headings.
//
// Packets are lean but complete: every pristine body in full (labelled, the
// canonical reconstruction), deduplicated across sites; a deployed body only
// when it differs from pristine; the previous-version body only when it
// changed; slot info, externalRefs, bundle sites, the texts emitted from the
// same function and the nearest deployed bodies. On CC 2.1.288 the 441-id
// packets carried ~187k characters of override frontmatter that no verdict
// used.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { externalRefs } from './lib/externalRefs.mjs';
import {
  rewriteTableNeedles,
  rewriteTablePairs,
} from './checkScannedLiterals.mjs';
const require = createRequire(import.meta.url);
const {
  parseOverrideArgs,
  resolveOverrideSets,
  appliedPromptsDir,
  remindersDirsFor,
  printAuditedSets,
} = require('./lib/overrideSets.cjs');
import {
  openIndex,
  reconstructPristine,
  parseOverrideFile,
  samePristine,
  neighbours as nearestBodies,
  emitterSiblings,
  sitesOf,
  hintLine,
  CORENDER_NOTE,
} from './lib/auditCorpus.mjs';
import {
  extractLccRules,
  mdModel,
  renderCarrier,
  renderGroupMd,
  renderHeader,
} from './lib/auditPacketMd.mjs';
import {
  findConcatNeighbours,
  siteOwnerFrom,
} from './lib/concatNeighbours.mjs';
import { fileURLToPath } from 'node:url';

const parsed = parseOverrideArgs(process.argv.slice(2));
const resolved = resolveOverrideSets(parsed, { fallback: 'applied' });
const [jsonPath, idsPath, outDirArg, groupSizeArg] = parsed.rest;
if (!jsonPath || !idsPath) {
  console.error(
    'usage: buildAuditPacket.mjs <prompts.json> <ids-file> [outDir] [groupSize]'
  );
  process.exit(2);
}
const outDir = outDirArg || '/tmp';
// Namespacing the packets per version is what keeps a previous bump's leftovers
// from being harvested as this one's result, so the tool has to be able to
// create the directory it was pointed at rather than failing at the first write.
fs.mkdirSync(outDir, { recursive: true });
// A cap on ids per packet; the rendered markdown size decides the grouping
// (see "Group by what the agent READS" below).
const groupSize = Math.max(1, Number(groupSizeArg || 30));

// The active set moves; resolve it, never hardcode it.
let active = null;
const applied = appliedPromptsDir();
if (fs.existsSync(applied)) {
  try {
    const dir = fs.realpathSync(applied);
    active = { dir, name: path.basename(dir) };
  } catch {
    active = null;
  }
}
const others = resolved
  .filter(s => !active || s.dir !== active.dir)
  .slice()
  .sort((a, b) => a.name.localeCompare(b.name));
const setEntries = active ? [active, ...others] : others;
const activeSet = active ? active.dir : '';
const allSets = setEntries.map(s => s.name);
printAuditedSets(setEntries);

const prompts = JSON.parse(fs.readFileSync(jsonPath, 'utf8')).prompts;
// The realign workflow's prompt tells the agent to read "the complete old
// pristine -> new pristine change", and the packet never carried the old body:
// the agent had to go find one id inside a 3 MB previous-version JSON, or judge
// the realignment without the diff at all. TWEAKCC_PREV_JSON supplies it.
// Optional, so every existing caller is unaffected.
const prevJsonPath = process.env.TWEAKCC_PREV_JSON || '';
const prevBodies = new Map();
if (prevJsonPath && fs.existsSync(prevJsonPath)) {
  for (const p of JSON.parse(fs.readFileSync(prevJsonPath, 'utf8')).prompts) {
    if (!p.id) continue;
    if (!prevBodies.has(p.id)) prevBodies.set(p.id, []);
    prevBodies.get(p.id).push(reconstructPristine(p));
  }
}
const bodyOf = p =>
  (p.pieces || []).filter(x => typeof x === 'string').join('') ||
  p.content ||
  '';

const byId = new Map();
for (const p of prompts) {
  if (!p.id) continue;
  if (!byId.has(p.id)) byId.set(p.id, []);
  byId.get(p.id).push(p);
}

// Text something outside the prompt depends on (lib/externalRefs.mjs). The
// bundle is optional: without TWEAKCC_CLI the packet still carries the
// cross-prompt labels and the leading-slot flag, and says the rest was not run.
const cliPath = process.env.TWEAKCC_CLI || '';
const cliSrc =
  cliPath && fs.existsSync(cliPath) ? fs.readFileSync(cliPath, 'utf8') : null;
const needles = cliSrc ? [...rewriteTableNeedles(cliSrc)] : [];
const replacements = cliSrc
  ? [...new Set(rewriteTablePairs(cliSrc).map(p => p.replacement))]
  : [];
const corpus = new Map(
  [...byId].map(([k, v]) => [k, v.map(bodyOf).join('\n')])
);

const ids = fs
  .readFileSync(idsPath, 'utf8')
  .split('\n')
  .map(s => s.trim())
  .filter(Boolean);

const missing = ids.filter(id => !byId.has(id));
if (missing.length) {
  console.error(`ids not in ${jsonPath}: ${missing.join(', ')}`);
  process.exit(2);
}

// The corpus the search tool and the checker open: the active set as deployed,
// its reminders, catalogue pristine for ids without an override, and (with
// TWEAKCC_CLI) every catalogued text's bundle site. Built once, cached by
// digest beside the packets.
const remindersDir =
  remindersDirsFor(active ? [active] : setEntries.slice(0, 1))[0] || null;
const catalogue = path.resolve(jsonPath);
const indexPath = path.join(path.resolve(outDir), 'corpus-index.v8');
const tIndex = Date.now();
const { index, cached: indexCached } = activeSet
  ? openIndex({
      catalogue,
      activeSet,
      remindersDir,
      bundle: cliSrc ? path.resolve(cliPath) : null,
      cachePath: indexPath,
      log: m => console.log(`corpus index: ${m}`),
    })
  : { index: null, cached: false };
const indexMs = Date.now() - tIndex;

const readIfExists = p =>
  fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
const ccVersionOf = text =>
  (text?.match(/^ccVersion:\s*(\S+)\s*$/m) || [])[1] || null;

const meta = {};

const packetFor = id => {
  const entries = byId.get(id);
  // Identical site bodies are carried once; siteBody maps each site to it.
  const siteBodies = entries.map(reconstructPristine);
  const pristineBodies = [...new Set(siteBodies)];
  const prev = prevBodies.get(id) || null;
  const prevUnique = prev ? [...new Set(prev)] : null;
  const prevSame =
    prevUnique &&
    prevUnique.length === pristineBodies.length &&
    prevUnique.every(b => pristineBodies.includes(b));
  meta[id] = {
    name: entries[0].name || null,
    sets: {},
  };
  const setFiles = setEntries.map(s => {
    const file = path.join(s.dir, `${id}.md`);
    const text = readIfExists(file);
    const row = { set: s.name, path: file };
    if (text === null) {
      // No file: pristine applies.
      row.deployed = 'absent';
      return row;
    }
    const f = parseOverrideFile(text);
    row.ccVersion =
      f.data.ccVersion != null ? String(f.data.ccVersion) : ccVersionOf(text);
    meta[id].sets[s.name] = f.frontmatter;
    if (f.suppressed) {
      // An empty body is a SUPPRESSION and covers nothing.
      row.deployed = 'suppressed';
    } else if (pristineBodies.some(b => samePristine(b, f.body))) {
      row.deployed = 'pristine';
    } else {
      row.deployed = 'override';
      row.body = f.body;
    }
    return row;
  });
  const line = hintLine;
  const near = index
    ? nearestBodies(index, id, {
        body: pristineBodies.join('\n\n'),
        limit: 3,
        min: 0.3,
      })
    : [];
  // Only siblings that could co-render go in the packet; the rest are counted
  // and the search tool lists them all.
  const PLAUSIBLE = new Set([
    'same-branch',
    'carrier-outside-target-branch',
    'carrier-conditional',
    'condition-relation',
  ]);
  const sibAll = index ? emitterSiblings(index, id, { limit: 1000 }) : null;
  const sibShown = sibAll
    ? sibAll.siblings
        .filter(h => PLAUSIBLE.has(h.coRender.relation))
        .slice(0, 4)
    : [];
  const sibRest = sibAll ? sibAll.total - sibShown.length : 0;
  const siteLines = index
    ? sitesOf(index, id).map(
        st =>
          `${st.module ? path.basename(st.module) : '?'}@${st.offset}` +
          (st.fn ? ` fn ${st.fn[0]}-${st.fn[1]}` : ' module-scope') +
          ` branches ${st.branches}`
      )
    : [];
  return {
    id,
    version: entries[0].version,
    description: entries[0].description || null,
    siteCount: entries.length,
    // Every DISTINCT site body in full, because a repeated id is several binary
    // sites and a verdict taken on the first one can be wrong for the others.
    pristineBodies,
    ...(entries.length > 1 && pristineBodies.length > 1
      ? { siteBody: siteBodies.map(b => pristineBodies.indexOf(b)) }
      : {}),
    previousPristineBodies: prevUnique
      ? prevSame
        ? 'unchanged'
        : prevUnique
      : null,
    // Positional slot order, omitted when it is simply 0..n-1.
    ...((entries[0].identifiers || []).every((x, i) => String(x) === String(i))
      ? {}
      : { identifiers: entries[0].identifiers }),
    identifierMap: entries[0].identifierMap || null,
    // All target paths. deployed: 'absent' (no file; pristine applies),
    // 'pristine' (the file body IS pristine), 'suppressed' (empty body; covers
    // nothing), or 'override' with the deployed body in `body`. Frontmatter is
    // in audit-meta.json.
    setFiles,
    // Where the text sits in the bundle (TWEAKCC_CLI): module@offset, the
    // innermost function's span and how many branches enclose it.
    sites: siteLines,
    // Leads only, never proof: texts emitted from the same function, and the
    // nearest deployed bodies. The relation is the UNPROVEN syntactic hint
    // (coRenderNote); the search tool returns the full lists.
    emitterSiblings: [
      ...sibShown.map(line),
      ...(sibRest > 0
        ? [`+${sibRest} more sibling(s): search tool "siblings"`]
        : []),
    ],
    neighbours: near.map(line),
    // FROZEN text: keep verbatim, and check each lead in the bundle before any
    // wipe. predicateRuns/rewriteNeedles are empty when TWEAKCC_CLI was not set.
    // Only non-empty lists and true flags are written (see externalRefsNote).
    externalRefs: Object.fromEntries(
      Object.entries({
        ...externalRefs({
          id,
          bodies: entries.map(bodyOf),
          corpus,
          needles,
          replacements,
          src: cliSrc,
          entries,
        }),
        bundleChecked: Boolean(cliSrc),
      }).filter(([, v]) => (Array.isArray(v) ? v.length > 0 : v !== false))
    ),
  };
};

// Group by what the agent READS: the rendered markdown packet.
//
// The agent reads audit-packet-NN.md in one Read call, so its size is the
// unit of work and of context. Ids stay in input order (families sort
// together, so a family lands in one packet, is judged consistently, and its
// shared carriers are rendered once), and a packet closes when the next id
// would push the rendered file past the budget or the group past groupSize.
// The fill target is then lowered to the smallest value that still needs no
// more packets, which evens the sizes out. An id bigger than the budget on its
// own gets a packet to itself and is reported.
const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const version = JSON.parse(fs.readFileSync(jsonPath, 'utf8')).version;
const absOut = path.resolve(outDir);
const corpusBlock = {
  catalogue,
  activeSet,
  remindersDir,
  bundle: cliSrc ? path.resolve(cliPath) : null,
  index: indexPath,
  digest: index ? index.digest : null,
  // The prompt-text part alone, so harvest can prove the corpus stayed frozen.
  corpusDigest: index ? index.corpusDigest : null,
};
const mdBudget = Math.max(
  4000,
  Number(process.env.TWEAKCC_AUDIT_MD_BUDGET) || 48000
);

// The LCC decision rule travels inside every packet, so no agent re-reads the
// whole CLAUDE.md. Missing headings fail the build: a packet without the rules
// the audit applies is not a packet.
const lccDir = remindersDir ? path.dirname(remindersDir) : null;
const lccPath = lccDir ? path.join(lccDir, 'CLAUDE.md') : null;
if (!lccPath || !fs.existsSync(lccPath)) {
  console.error(
    `LCC CLAUDE.md not found (${lccPath || 'no reminders folder resolved'}): the packet carries its decision-rule sections`
  );
  process.exit(2);
}
let lccRules;
try {
  lccRules = extractLccRules(fs.readFileSync(lccPath, 'utf8'), lccPath);
} catch (e) {
  console.error(e.message);
  process.exit(2);
}

// The fragments each id is concatenated with (a `+` chain or a joined array):
// a sentence spanning two ids must be cut whole or not at all, and the checker
// holds a trim or wipe to that.
const tMd = Date.now();
const concat =
  index && cliSrc
    ? findConcatNeighbours({
        src: cliSrc,
        targets: new Map(
          ids.map(id => [
            id,
            (index.sitesByIdx.get(index.byId.get(id)) || []).map(s => s.offset),
          ])
        ),
        siteOwner: siteOwnerFrom(index),
      })
    : new Map();
const entryOf = new Map();
const models = new Map();
for (const id of ids) {
  const entry = packetFor(id);
  const cn = concat.get(id);
  if (cn) {
    entry.concatNeighbours = cn.map(n => ({
      ...n,
      ...(n.id && byId.has(n.id)
        ? { pristine: reconstructPristine(byId.get(n.id)[0]) }
        : {}),
    }));
  }
  entryOf.set(id, entry);
  models.set(
    id,
    mdModel({ index, src: cliSrc, prompt: entry, entries: byId.get(id) })
  );
}
const catalogueVersion = id => {
  const e = byId.get(id);
  return e ? e[0].version || null : null;
};

const pathsFor = n => {
  const file = path.join(absOut, `audit-packet-${n}.json`);
  return {
    file,
    md: path.join(absOut, `audit-packet-${n}.md`),
    verdicts: path.join(absOut, `verdicts-${n}.json`),
    queries: path.join(absOut, `search-${n}.json`),
    results: path.join(absOut, `search-${n}.out.json`),
  };
};
const commandsFor = p => ({
  search: `node ${path.join(toolsDir, 'auditCorpusSearch.mjs')} --packet ${p.file} --in ${p.queries} --out ${p.results} --text`,
  check: `node ${path.join(toolsDir, 'checkAuditVerdicts.mjs')} ${p.file} ${p.verdicts}`,
  write: `node ${path.join(toolsDir, 'writeAuditVerdicts.mjs')} ${p.file}`,
  query:
    `node ${path.join(toolsDir, 'bundleQuery.mjs')} --cli ${corpusBlock.bundle || '<bundle: rebuild with TWEAKCC_CLI>'}` +
    ` --catalogue ${catalogue}`,
});

const carrierCache = new Map();
const renderMd = (n, slice) => {
  const p = pathsFor(n);
  const cmd = commandsFor(p);
  const ms = slice.map(id => models.get(id));
  const inGroup = new Set(slice);
  const claimsOf = new Map();
  for (const m of ms) {
    for (const [cid, claims] of m.carrierClaims) {
      if (inGroup.has(cid) && !index.docs[index.byId.get(cid)]?.pristineBody) {
        // An assigned id whose deployed text is its pristine body is already
        // in full in its own section.
        if (!claimsOf.has(cid)) claimsOf.set(cid, null);
        continue;
      }
      if (!claimsOf.has(cid) || claimsOf.get(cid) === null)
        claimsOf.set(cid, new Set());
      for (const c of claims) claimsOf.get(cid).add(c);
    }
  }
  const blocks = new Map();
  for (const [cid, claims] of claimsOf) {
    if (claims === null) {
      blocks.set(
        cid,
        `### \`${cid}\`\nassigned in this packet; its deployed text is its pristine body, in full in its own section.\n`
      );
      continue;
    }
    const key = `${cid}\0${[...claims].sort().join('\0')}`;
    if (!carrierCache.has(key)) {
      carrierCache.set(
        key,
        renderCarrier({
          index,
          catalogueVersion,
          id: cid,
          claims,
          inGroup: false,
        })
      );
    }
    blocks.set(cid, carrierCache.get(key));
  }
  const header = renderHeader({
    group: `g${n}`,
    version,
    count: slice.length,
    paths: {
      'verdicts file': p.verdicts,
      'active set': activeSet,
      reminders: remindersDir,
    },
    commands: {
      search: `cat > ${p.queries} <<'Q'\n{"queries":[{"forId":"<id>","q":"<phrase>"},{"forId":"<id>","q":["term","term"]}],"siblings":[],"neighbours":[]}\nQ\n${cmd.search}`,
      query: `${cmd.query} <<'Q'\n[{"fn":123},{"callers":123,"depth":2},{"refs":"Xy","at":123},{"text":"literal"}]\nQ`,
      write: `${cmd.write} <<'VERDICTS'\n{"verdicts":[{"id":"…","verdict":"pristine-keep","slopCheck":"…","duplicateCheck":"…","why":"…","coveredBy":[],"trimPlan":null}]}\nVERDICTS`,
    },
  });
  return renderGroupMd({
    header,
    lccRules,
    lccPath,
    models: ms,
    carrierBlocks: blocks,
  });
};

const partition = target => {
  const out = [];
  let cur = [];
  for (const id of ids) {
    if (cur.length) {
      const n = String(out.length).padStart(2, '0');
      const full =
        cur.length >= groupSize ||
        Buffer.byteLength(renderMd(n, [...cur, id])) > target;
      if (full) {
        out.push(cur);
        cur = [];
      }
    }
    cur.push(id);
  }
  if (cur.length) out.push(cur);
  return out;
};
let bins = partition(mdBudget);
{
  let lo = Math.floor(mdBudget / 2);
  let hi = mdBudget;
  while (hi - lo > 500) {
    const mid = Math.floor((lo + hi) / 2);
    const trial = partition(mid);
    if (trial.length <= bins.length) {
      bins = trial;
      hi = mid;
    } else lo = mid;
  }
}
const mdMs = Date.now() - tMd;

const groups = [];
const mdSizes = [];
for (const slice of bins) {
  const n = String(groups.length).padStart(2, '0');
  const p = pathsFor(n);
  const md = renderMd(n, slice);
  fs.writeFileSync(p.md, md);
  mdSizes.push(Buffer.byteLength(md));
  fs.writeFileSync(
    p.file,
    JSON.stringify(
      {
        format: 2,
        group: `g${n}`,
        version,
        activeSet,
        sets: allSets,
        corpus: corpusBlock,
        meta: path.join(absOut, 'audit-meta.json'),
        md: p.md,
        verdictsFile: p.verdicts,
        commands: commandsFor(p),
        coRenderNote: CORENDER_NOTE,
        externalRefsNote:
          'externalRefs lists only what was found: an absent rewriteNeedles/quotedElsewhere/predicateRuns is empty, an absent opensWithSlot/rewriteReplacement is false, and an absent bundleChecked means the bundle was not scanned.',
        concatNote:
          'concatNeighbours: the literals this id is concatenated with in the bundle (+ chain or joined array). crossesSentence true means one sentence spans both ids: it is cut whole across both or not at all, and a trim/wipe must name the neighbour id in trimPlan or why.',
        prompts: slice.map(id => entryOf.get(id)),
      },
      null,
      1
    )
  );
  groups.push({
    name: `g${n}`,
    packet: p.file,
    md: p.md,
    verdicts: p.verdicts,
    ids: slice,
  });
}

fs.writeFileSync(
  path.join(absOut, 'audit-meta.json'),
  JSON.stringify(meta, null, 1)
);

const sorted = [...mdSizes].sort((a, b) => a - b);
const over = groups.filter((g, i) => mdSizes[i] > mdBudget);
console.log(
  `audit packets: ${groups.length} group(s), ${ids.length} id(s), md budget ${mdBudget} B, groupSize cap ${groupSize} | ` +
    `md sizes min ${sorted[0]} / median ${sorted[Math.floor(sorted.length / 2)]} / max ${sorted[sorted.length - 1]} B, ` +
    `ids per group ${Math.min(...bins.map(b => b.length))}-${Math.max(...bins.map(b => b.length))}, rendered in ${mdMs} ms` +
    (over.length
      ? ` | OVER BUDGET (one id alone exceeds it): ${over.map(g => `${g.name} ${g.ids[0]}`).join(', ')}`
      : '')
);
console.log(`LCC decision rule: ${lccPath}`);
console.log(
  prevJsonPath
    ? `previous pristine: ${prevJsonPath}`
    : 'previous pristine: none (set TWEAKCC_PREV_JSON for realignment diffs)'
);
console.log(
  cliSrc
    ? `external refs: bundle ${cliPath} (${needles.length} rewrite needles)`
    : 'external refs: no bundle (set TWEAKCC_CLI for predicate and rewrite-needle leads)'
);
console.log(
  index
    ? `corpus index: ${index.docs.length} docs, digest ${index.digest.slice(0, 12)}, ` +
        `${indexCached ? 'cached' : 'built'} in ${indexMs} ms` +
        (index.siteStats
          ? ` (bundle sites: ${index.siteStats.located}/${index.siteStats.probed} located)`
          : ' (no bundle: coRender hints unresolved)')
    : 'corpus index: none (no active set resolved)'
);
console.log(`active set: ${activeSet}`);
console.log(`reminders: ${remindersDir || 'none'}`);
console.log(`sets: ${allSets.join(', ')}`);
fs.writeFileSync(
  path.join(absOut, 'audit-groups.json'),
  JSON.stringify(groups, null, 1)
);
fs.writeFileSync(
  path.join(absOut, 'audit-manifest.json'),
  JSON.stringify(
    {
      format: 2,
      version,
      ids: ids.length,
      idsFile: path.resolve(idsPath),
      corpus: corpusBlock,
      bundleSha: index ? index.bundleSha : null,
      groupCount: groups.length,
      groups,
    },
    null,
    1
  )
);
console.log(`groups descriptor -> ${path.join(absOut, 'audit-groups.json')}`);
console.log(`manifest -> ${path.join(absOut, 'audit-manifest.json')}`);
console.log(
  `workflow args: ${JSON.stringify({ version, packetDir: absOut, groupCount: groups.length, activeSet, repoDir: path.dirname(toolsDir), remindersDir })}`
);
