#!/usr/bin/env node
// Select the stage-1 keeps a cut-hunt pass re-reads, and build its packets.
//
//   node tools/selectCutHunt.mjs <stage1 packetDir> <huntDir> [--share 0.25] [--family-cap 3] [--group-size 8] [--md-bytes 46000]
//
// Reads <packetDir>/stage1-result.json (harvestAudit's output) and the stage-1
// packets. Every pristine-keep whose packet evidence makes a cut plausible
// (tools/lib/cutLeads.mjs: a claim restated by a carrier that may co-render,
// the tool's own description/schema, a same-tool emitter sibling, a near
// body) is ranked by lead strength; the top --share of the keeps is taken,
// at most --family-cap per id family (the first four id segments), so one
// switch of alternative messages cannot use the whole budget. Selection is
// deterministic and decides only who gets a second read.
//
// Writes into <huntDir>: hunt-packet-NN.json (the stage-1 packet entries of
// the selected ids, same shape, so writeAuditVerdicts/checkAuditVerdicts work
// unchanged), hunt-packet-NN.md (the stage-1 markdown of those ids with their
// stage-1 verdict and leads, the LCC sections, and every carrier and lead
// body once), hunt-selection.json (every keep with its score and leads) and
// hunt-manifest.json. Last line: the workflow args.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openIndex, resolveCarrier } from './lib/auditCorpus.mjs';
import { cutLeads, leadScore } from './lib/cutLeads.mjs';

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const pos = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')));

export const familyOf = id => id.split('-').slice(0, 4).join('-');

// Rank, cap per family, cap overall. rows: [{id, score}] (score 0 = no lead).
export function pickHunt(rows, { share = 0.25, familyCap = 3 } = {}) {
  const cap = Math.floor(rows.length * share);
  const sorted = rows.filter(r => r.score > 0).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const per = new Map();
  const out = [];
  for (const r of sorted) {
    if (out.length >= cap) break;
    const f = familyOf(r.id);
    if ((per.get(f) || 0) >= familyCap) continue;
    per.set(f, (per.get(f) || 0) + 1);
    out.push(r);
  }
  return { cap, picked: out };
}

// Split a stage-1 md into header parts, per-id sections and carrier sections.
export function splitStageMd(md) {
  const idx = md.indexOf('\n# Assigned ids');
  const car = md.indexOf('\n# Carriers');
  const howAt = md.indexOf('\n## How to read it');
  const common = howAt >= 0 && idx > howAt ? md.slice(howAt + 1, idx).trim() : '';
  const idsPart = md.slice(idx + 1, car >= 0 ? car : md.length);
  const sections = new Map();
  const re = /^## \d+\/\d+ `([^`]+)`\n/gm;
  const heads = [...idsPart.matchAll(re)];
  heads.forEach((h, i) => {
    const end = i + 1 < heads.length ? heads[i + 1].index : idsPart.length;
    sections.set(h[1], idsPart.slice(h.index + h[0].length, end).trim());
  });
  const carriers = new Map();
  if (car >= 0) {
    const cpart = md.slice(car + 1);
    const ch = [...cpart.matchAll(/^### `([^`]+)`\n/gm)];
    ch.forEach((h, i) => {
      const end = i + 1 < ch.length ? ch[i + 1].index : cpart.length;
      carriers.set(h[1], cpart.slice(h.index + h[0].length, end).trim());
    });
  }
  return { common, sections, carriers };
}

const fence = t => {
  const runs = String(t).match(/~{3,}/g) || [];
  const f = '~'.repeat(Math.max(3, ...runs.map(r => r.length + 1)));
  return `${f}text\n${t}\n${f}`;
};

const leadLine = l =>
  `- ${l.kind} → \`${l.carrier}\` (${l.rel}${l.share != null ? `, restates ${Math.round(l.share * 100)}% of the claims` : ''}${l.similarity != null ? `, similarity ${l.similarity}` : ''})`;

export function renderHuntMd({ group, version, ids, stage1, leadsById, parts, commands, extraCarriers }) {
  const L = [];
  L.push(`# Cut hunt ${group} — Claude Code ${version} (${ids.length} ids)`);
  L.push('');
  L.push('Every id below was ruled pristine-keep by stage 1, and its packet evidence names a plausible cut. Your job: build the STRONGEST LEGITIMATE cut for each (trim or wipe-merge) under the full rules, then decide honestly whether it holds. Stage 1\'s reasoning and the leads are shown per id; they are evidence, not verdicts.');
  L.push('');
  L.push('## Commands (each answers many questions in ONE call)');
  L.push(`Bundle queries (every lookup for ALL ids in one call, two at most; never python/grep the bundle):\n~~~sh\n${commands.query} <<'Q'\n[{"fn":123},{"callers":123,"depth":2},{"refs":"Xy","at":123},{"text":"literal"},{"prop":"optionName"}]\nQ\n~~~`);
  L.push(`Follow-up corpus search (one batched call; prints text):\n~~~sh\ncat > ${commands.queries} <<'Q'\n{"queries":[{"forId":"<id>","q":"<phrase>"}],"siblings":[],"neighbours":[]}\nQ\n${commands.search}\n~~~`);
  L.push(`Write + check (all ids; \`--merge\` resends only the failing ones):\n~~~sh\n${commands.write} <<'VERDICTS'\n{"verdicts":[{"id":"…","verdict":"trim","slopCheck":"…","duplicateCheck":"…","why":"…","coveredBy":[{"carrierId":"…","quote":"…"}],"trimPlan":"…"}]}\nVERDICTS\n~~~`);
  L.push('');
  if (parts.common) L.push(parts.common, '');
  L.push(`# Ids to hunt (${ids.length})`);
  ids.forEach((id, i) => {
    const v = stage1.get(id) || {};
    L.push('');
    L.push(`## ${i + 1}/${ids.length} \`${id}\``);
    L.push(parts.sections.get(id) || '(section missing from the stage-1 packet — read the JSON packet entry)');
    L.push('');
    L.push(`**Stage 1 ruled pristine-keep.** why: ${v.why || '—'}`);
    if (v.duplicateCheck) L.push(`duplicateCheck: ${v.duplicateCheck}`);
    if (v.slopCheck) L.push(`slopCheck: ${v.slopCheck}`);
    L.push('**Cut leads (why this id was selected):**');
    for (const l of leadsById.get(id) || []) L.push(leadLine(l));
  });
  L.push('');
  const all = new Map([...parts.carriers, ...extraCarriers]);
  L.push(`# Carriers (${all.size}, each once; deployed text as it renders, un-escaped)`);
  for (const [id, body] of all) L.push('', `### \`${id}\``, body);
  return L.join('\n') + '\n';
}

function main() {
  const [packetDirArg, huntDirArg] = pos;
  if (!packetDirArg || !huntDirArg) {
    console.error('usage: selectCutHunt.mjs <stage1 packetDir> <huntDir> [--share 0.25] [--family-cap 3] [--group-size 8] [--md-bytes 46000]');
    process.exit(2);
  }
  const packetDir = path.resolve(packetDirArg);
  const huntDir = path.resolve(huntDirArg);
  const share = Number(opt('share', '0.25'));
  const familyCap = Number(opt('family-cap', '3'));
  const groupSize = Number(opt('group-size', '8'));
  const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const man = JSON.parse(fs.readFileSync(path.join(packetDir, 'audit-manifest.json'), 'utf8'));
  const resultPath = path.join(packetDir, 'stage1-result.json');
  const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  if (!result.complete) console.warn('selectCutHunt: stage1-result.json is not complete; hunting over what it holds');
  const stage1 = new Map(result.verdicts.map(v => [v.id, v]));
  const c = man.corpus;
  const { index } = openIndex({ catalogue: c.catalogue, activeSet: c.activeSet, remindersDir: c.remindersDir || null, bundle: c.bundle || null, cachePath: c.index || null });

  const rows = [];
  const entry = new Map();
  for (const g of man.groups) {
    const p = JSON.parse(fs.readFileSync(g.packet, 'utf8'));
    for (const pr of p.prompts) {
      entry.set(pr.id, { pr, group: g, packet: p });
      if ((stage1.get(pr.id) || {}).verdict !== 'pristine-keep') continue;
      const leads = cutLeads(index, pr);
      rows.push({ id: pr.id, score: leadScore(leads), leads });
    }
  }
  const { cap, picked } = pickHunt(rows, { share, familyCap });
  const pickedSet = new Set(picked.map(r => r.id));
  const leadsById = new Map(rows.map(r => [r.id, r.leads]));
  // Packet order keeps an id next to the ids that share its carriers.
  const order = [...entry.keys()].filter(id => pickedSet.has(id));
  const mdBudget = Number(opt('md-bytes', '46000'));

  fs.mkdirSync(huntDir, { recursive: true });
  for (const f of fs.readdirSync(huntDir)) if (/^(hunt-packet|verdicts|search)-\d+\.(json|md|out\.json)$|^hunt-(manifest|selection|report)\.json$|^stage1-result\.json$/.test(f)) fs.unlinkSync(path.join(huntDir, f));
  const mdCache = new Map();
  const pathsFor = nn => ({
    packetPath: path.join(huntDir, `hunt-packet-${nn}.json`),
    mdPath: path.join(huntDir, `hunt-packet-${nn}.md`),
    verdictsFile: path.join(huntDir, `verdicts-${nn}.json`),
    queries: path.join(huntDir, `search-${nn}.json`),
  });
  const commandsFor = (nn, P) => ({
    search: `node ${repoDir}/tools/auditCorpusSearch.mjs --packet ${P.packetPath} --in ${P.queries} --out ${path.join(huntDir, `search-${nn}.out.json`)} --text`,
    check: `node ${repoDir}/tools/checkAuditVerdicts.mjs ${P.packetPath} ${P.verdictsFile}`,
    write: `node ${repoDir}/tools/writeAuditVerdicts.mjs ${P.packetPath}`,
    query: `node ${repoDir}/tools/bundleQuery.mjs --cli ${c.bundle} --catalogue ${c.catalogue}`,
  });
  const buildMd = (ids, nn, name) => {
    const P = pathsFor(nn);
    const commands = commandsFor(nn, P);
    const parts = { common: '', sections: new Map(), carriers: new Map() };
    for (const id of ids) {
      const src = entry.get(id).group.md;
      if (!mdCache.has(src)) mdCache.set(src, splitStageMd(fs.readFileSync(src, 'utf8')));
      const s = mdCache.get(src);
      if (!parts.common) parts.common = s.common;
      parts.sections.set(id, s.sections.get(id));
      for (const [k, v] of s.carriers) {
        if (!parts.carriers.has(k) && (s.sections.get(id) || '').includes(`\`${k}\``)) parts.carriers.set(k, v);
      }
    }
    const extraCarriers = new Map();
    for (const id of ids) {
      for (const l of leadsById.get(id) || []) {
        if (parts.carriers.has(l.carrier) || extraCarriers.has(l.carrier)) continue;
        const r = resolveCarrier(index, l.carrier);
        if (!r) continue;
        const d = r.doc;
        const state = d.suppressed ? 'SUPPRESSED (renders nothing)' : d.shadowedBy && d.shadowedBy.length ? `SHADOWED by ${d.shadowedBy.join(', ')}` : 'live';
        const body = d.body.length > 1500 ? `${d.body.slice(0, 1500)}\n… (${d.body.length - 1500} more chars: ${d.path || 'catalogue pristine'})` : d.body;
        extraCarriers.set(l.carrier, `${state} · ${d.path || 'catalogue pristine (no override)'}\ndeployed text (${d.body.length} chars):\n${fence(body)}`);
      }
    }
    return { P, commands, md: renderHuntMd({ group: name, version: man.version, ids, stage1, leadsById, parts, commands: { ...commands, queries: P.queries }, extraCarriers }) };
  };
  // Greedy packing in packet order: a group closes at --group-size ids or
  // when the next id would push its markdown past --md-bytes (one Read).
  const groups = [];
  let cur = [];
  for (const id of order) {
    const trial = [...cur, id];
    if (cur.length && (trial.length > groupSize || buildMd(trial, '00', 'h00').md.length > mdBudget)) {
      groups.push(cur);
      cur = [id];
    } else cur = trial;
  }
  if (cur.length) groups.push(cur);
  const width = Math.max(2, String(groups.length - 1).length);
  const manGroups = [];
  groups.forEach((ids, gi) => {
    const nn = String(gi).padStart(width, '0');
    const name = `h${nn}`;
    const { P, commands, md } = buildMd(ids, nn, name);
    const first = entry.get(ids[0]).packet;
    const { prompts: _p, md: _m, ...head } = first;
    void _p;
    void _m;
    const packet = { ...head, group: name, md: P.mdPath, verdictsFile: P.verdictsFile, commands, hunt: { stage1Result: resultPath }, prompts: ids.map(id => entry.get(id).pr) };
    fs.writeFileSync(P.packetPath, JSON.stringify(packet, null, 1));
    fs.writeFileSync(P.mdPath, md);
    manGroups.push({ name, packet: P.packetPath, md: P.mdPath, mdBytes: md.length, verdicts: P.verdictsFile, queries: P.queries, ids });
  });
  fs.writeFileSync(path.join(huntDir, 'hunt-selection.json'), JSON.stringify({ keeps: rows.length, cap, share, familyCap, selected: picked.length, rows: rows.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).map(r => ({ ...r, selected: pickedSet.has(r.id) })) }, null, 1));
  const manifest = { format: 1, version: man.version, stage1Result: resultPath, stage1PacketDir: packetDir, corpus: c, keeps: rows.length, selected: picked.length, groupCount: groups.length, groups: manGroups };
  fs.writeFileSync(path.join(huntDir, 'hunt-manifest.json'), JSON.stringify(manifest, null, 1));
  const sizes = manGroups.map(g => g.mdBytes);
  console.log(`cut hunt ${man.version}: ${picked.length} of ${rows.length} keep(s) selected (cap ${cap} = ${share} × keeps; ${rows.filter(r => r.score > 0).length} had a lead), ${groups.length} group(s) of ≤${groupSize}; md ${Math.min(...sizes)}–${Math.max(...sizes)} bytes -> ${huntDir}`);
  // model and effort have no default: the caller adds them.
  console.log(`workflow args: ${JSON.stringify({ version: man.version, huntDir, groupCount: groups.length, activeSet: c.activeSet, repoDir, ...(c.remindersDir ? { remindersDir: c.remindersDir } : {}) })}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
