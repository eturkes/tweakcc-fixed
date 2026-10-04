#!/usr/bin/env node
// Merge the cut-hunt pass into the stage-1 result.
//
//   node tools/harvestCutHunt.mjs <huntDir> [--allow-partial]
//
// For every hunted id the final verdict is the hunter's cut (trim or
// wipe-merge) when that verdict passes the stage-1 checker on its own — no
// checker error names the id and the file has no file-level error — and
// still holds against the merged result (a wipe's carrier is not itself
// wiped, a sentence-crossing neighbour is not left pristine-keep under a
// wipe). Otherwise the stage-1 pristine-keep stands. A hunter that kept the
// id changes nothing.
//
// Writes <huntDir>/stage1-result.json (the stage-1 result with the adopted
// cuts; same shape, so the stage-2 machinery and replay comparisons read it
// unchanged) and <huntDir>/hunt-report.json (adopted, rejected with reasons,
// groups to rerun) only when every group has a verdicts file, unless
// --allow-partial. Exit 0 complete, 1 incomplete (prints "rerun groups: …").
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openIndex } from './lib/auditCorpus.mjs';
import { checkGroup, crossingNeighbours } from './checkAuditVerdicts.mjs';

const CUTS = new Set(['trim', 'wipe-merge']);

// Pure merge, for tests: stage1 verdicts, per-group {packet, verdictsText|null}.
export function mergeHunt({ stage1Verdicts, groups, index, check = checkGroup }) {
  const final = new Map(stage1Verdicts.map(v => [v.id, v]));
  const prompts = new Map();
  const adopted = [];
  const rejected = [];
  const rerun = [];
  const pending = [];
  for (const g of groups) {
    for (const p of g.packet.prompts) prompts.set(p.id, p);
    if (g.verdictsText == null) {
      rerun.push(g.packet.group);
      continue;
    }
    const r = check({ packet: g.packet, verdictsText: g.verdictsText, index });
    const fileLevel = r.errors.filter(e => !g.packet.prompts.some(p => e.startsWith(`${p.id}: `)));
    if (fileLevel.length || !r.verdicts.length) {
      rerun.push(g.packet.group);
      for (const p of g.packet.prompts) rejected.push({ id: p.id, group: g.packet.group, reason: `file-level checker error: ${fileLevel[0] || 'no verdicts'}` });
      continue;
    }
    if (!r.ok) rerun.push(g.packet.group);
    for (const v of r.verdicts) {
      const errs = r.errors.filter(e => e.startsWith(`${v.id}: `));
      if (!CUTS.has(v.verdict)) continue;
      if (errs.length) rejected.push({ id: v.id, group: g.packet.group, verdict: v.verdict, reason: errs.join(' | ') });
      else pending.push({ v, group: g.packet.group });
    }
  }
  for (const { v } of pending) final.set(v.id, v);
  // Hold the cuts against the merged result, to a fixpoint: one rejection can
  // expose another.
  let changed = true;
  const out = new Set(pending.map(p => p.v.id));
  while (changed) {
    changed = false;
    for (const { v, group } of pending) {
      if (!out.has(v.id)) continue;
      let why = null;
      if (v.verdict === 'wipe-merge') {
        for (const pair of v.coveredBy || []) {
          const c = final.get(pair.carrierId);
          if (c && c.verdict === 'wipe-merge' && c.id !== v.id) why = `its carrier ${pair.carrierId} is itself wiped in the merged result — circular coverage`;
        }
        for (const n of crossingNeighbours(prompts.get(v.id))) {
          const o = final.get(n.id);
          if (o && o.verdict === 'pristine-keep') why = `a sentence crosses into ${n.id}, which stays pristine-keep — wiping one half leaves the other broken`;
        }
      }
      if (why) {
        out.delete(v.id);
        final.set(v.id, stage1Verdicts.find(s => s.id === v.id));
        rejected.push({ id: v.id, group, verdict: v.verdict, reason: why });
        changed = true;
      }
    }
  }
  for (const { v, group } of pending) if (out.has(v.id)) adopted.push({ id: v.id, group, verdict: v.verdict, coveredBy: v.coveredBy, trimPlan: v.trimPlan });
  const order = stage1Verdicts.map(v => v.id);
  return { verdicts: order.map(id => final.get(id)), adopted, rejected, rerun: [...new Set(rerun)] };
}

function main() {
  const argv = process.argv.slice(2);
  const dirArg = argv.find(a => !a.startsWith('--'));
  if (!dirArg) {
    console.error('usage: harvestCutHunt.mjs <huntDir> [--allow-partial]');
    process.exit(2);
  }
  const dir = path.resolve(dirArg);
  const man = JSON.parse(fs.readFileSync(path.join(dir, 'hunt-manifest.json'), 'utf8'));
  const result = JSON.parse(fs.readFileSync(man.stage1Result, 'utf8'));
  const c = man.corpus;
  const { index } = openIndex({ catalogue: c.catalogue, activeSet: c.activeSet, remindersDir: c.remindersDir || null, bundle: c.bundle || null, cachePath: c.index || null });
  const groups = man.groups.map(g => ({
    packet: JSON.parse(fs.readFileSync(g.packet, 'utf8')),
    verdictsText: fs.existsSync(g.verdicts) ? fs.readFileSync(g.verdicts, 'utf8') : null,
  }));
  const m = mergeHunt({ stage1Verdicts: result.verdicts, groups, index });
  const counts = {};
  for (const v of m.verdicts) counts[v.verdict] = (counts[v.verdict] || 0) + 1;
  console.log(`cut hunt ${man.version}: ${man.selected} hunted in ${man.groupCount} group(s); adopted ${m.adopted.length} cut(s) (${m.adopted.filter(a => a.verdict === 'wipe-merge').length} wipe, ${m.adopted.filter(a => a.verdict === 'trim').length} trim), rejected ${m.rejected.length}; final ${JSON.stringify(counts)}`);
  for (const a of m.adopted) console.log(`  + ${a.verdict} ${a.id}`);
  for (const r of m.rejected) console.log(`  - ${r.id}: ${r.reason.slice(0, 200)}`);
  const complete = !m.rerun.length;
  if (!complete) console.log(`rerun groups: ${m.rerun.join(',')}`);
  if (complete || argv.includes('--allow-partial')) {
    fs.writeFileSync(path.join(dir, 'stage1-result.json'), JSON.stringify({ ...result, counts, verdicts: m.verdicts, cutHunt: { dir, adopted: m.adopted.length, rejected: m.rejected.length, complete } }, null, 1));
    fs.writeFileSync(path.join(dir, 'hunt-report.json'), JSON.stringify({ version: man.version, selected: man.selected, adopted: m.adopted, rejected: m.rejected, rerun: m.rerun }, null, 1));
    console.log(`wrote ${path.join(dir, 'stage1-result.json')}`);
  } else console.log('INCOMPLETE — nothing written (pass --allow-partial to merge what passed)');
  process.exit(complete ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
