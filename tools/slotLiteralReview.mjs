#!/usr/bin/env node
// Review packets for the slot-literal gate, and the merge of their verdicts.
//
//   node tools/slotLiteralReview.mjs build <cli.js> <prompts.json> <outDir>
//        [--per N] [--candidates <dir>] [--force]
//   node tools/slotLiteralReview.mjs merge <outDir> [--check]
//        [--candidates <dir> | --no-candidates]
//
// build runs checkSlotLiterals, groups the unreviewed findings by hash and
// writes, per reviewer, packet-NN.md (the literal, every prompt slot it renders
// into with that prompt's pristine body, and the source around it) and
// hashes-NN.json, plus BRIEF.md and existing-ids.txt shared by all reviewers,
// and manifest.json recording every packet's hashes, the catalogue path and the
// classify candidates dir. It refuses to overwrite a dir holding verdicts
// unless --force is given. Each reviewer writes verdicts-NN.json.
//
// merge checks the verdict files against the manifest, rejects a catalogue id
// that is live (in the current catalogue or allowlist, re-read now) for another
// literal or minted twice, and one whose literal is also a pending classify
// candidate (the classify pass names it; a second id would split one string),
// then appends the rows to data/slot-literal-allowlist.json as text, leaving
// every existing byte alone. The candidates dir is --candidates, else
// $TWEAKCC_CLASSIFY_DIR or $SHOWTIME_TMP (the driver's run dir), else the one
// recorded at build; with none, merge fails unless --no-candidates is given.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findSlotLiterals, literalForms } from './checkSlotLiterals.mjs';
import { catalogueIndex, sha1 } from './lib/classifyVerdicts.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ALLOWLIST = path.join(HERE, '..', 'data', 'slot-literal-allowlist.json');
const VERDICTS = new Set(['catalogue', 'glue', 'not-a-slot', 'off-route']);
const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const EMPTY_ALLOWLIST = '{\n}\n';
const readJson = f => JSON.parse(fs.readFileSync(f, 'utf8'));

const BRIEF = (outDir, cliPath) => `# Slot-literal review brief

You review literals that render INTO a catalogued Claude Code prompt through one of its \`\${…}\` substitutions. Each literal has no catalogue id of its own, so no prompt override can reword it. It reaches the model only where that host does at this emission site: a catalogued host proves some site of it is model-facing, not this one. Decide one verdict per literal.

Bundle (read-only, one line per module; read around offsets with node or dd, never print it whole):
${cliPath}

## Verdicts

- \`catalogue\`: the literal carries something the model acts on or must know: an instruction, a refusal or failure reason, a remedy, a rule, a state statement that changes what the model does next. A prompt author could plausibly want to reword it. It gets its own id.
- \`glue\`: reaches the model but only labels or connects an interpolated value: a noun phrase naming a thing, a connective fragment, a quoting marker, a unit, a placeholder like "(unknown)". Nothing the model acts on beyond what the host prompt already says.
- \`not-a-slot\`: a resolver artifact; the literal does not flow into that substitution. The checker resolves a bare identifier once against declarators in the enclosing functions; confirm at the emission site that the substitution's identifier is bound to the declarator holding this literal and that the branch choosing it can reach this template. If not, use this verdict and say where the literal really goes.
- \`off-route\`: the literal does flow into the substitution, but at this site the host never reaches the model (its text is thrown and caught, logged, or rendered only in the terminal). Trace the host from this emission site to its sink before giving \`catalogue\`: the host prompt being catalogued proves only that SOME site of it reaches the model. Verdicts on text are content-keyed, so also check the classification cache for this literal's own text (data/prompt-classification.json): a \`catalogue\` here must agree with it, and the checker fails when a catalogued literal's cache verdict is \`ui\`/\`internal\`.

Rules:
1. Read the emission site before deciding. The packet gives the host prompt's pristine body and the source around the literal; read further in the bundle when the binding or the delivery is not settled by that.
2. Two literals that are quasis of ONE template node (\`a \${x} b\` reports \`a \` and \` b\` separately): catalogue the node once, with a name describing the whole branch, and mark the other quasi \`glue\` with a reason naming that id.
3. A literal shared by several host prompts (the packet lists each) gets one verdict.
4. For \`catalogue\`:
   - \`id\`: kebab-case, prefixed like its host prompt (\`tool-result-\`, \`data-\`, \`system-reminder-\`, \`system-prompt-\`, \`slash-command-\`, \`tool-description-\`, \`tool-parameter-\`, \`agent-prompt-\`, \`skill-\`), specific to what the text says. It must not appear in ${path.join(outDir, 'existing-ids.txt')} (one id per line) and must be unique within your output.
   - \`name\`: \`<Kind>: <Topic> — <what it says>\`, matching existing names, e.g. \`Tool Result: StartTask — start the task without files\`.
   - \`desc\`: one sentence on what it tells the model.
5. \`reason\`: one or two plain sentences with the evidence (offsets, the binding, how it reaches the model).
6. Do not edit any repository file. Do not start or wait on background jobs.

## Output

Write a JSON array to your verdicts path, one row per hash in your hashes file, each exactly once:

{"hash": "<16 hex>", "verdict": "catalogue|glue|not-a-slot|off-route", "reason": "…", "id": "…", "name": "…", "desc": "…"}

(\`id\`/\`name\`/\`desc\` only for \`catalogue\`.) Validate it before replying: \`node ${fileURLToPath(import.meta.url)} merge ${outDir} --check\` reports every problem across all packets; fix the ones in your file. Reply with the counts per verdict and the path.
`;

// Findings recorded at build time, so merge never re-runs the scan.
const findingsFile = dir => path.join(dir, 'findings.json');
// The work a build handed out. Validation enumerates this, never the hash files
// on disk, so a deleted packet is a problem rather than one less to check.
const manifestFile = dir => path.join(dir, 'manifest.json');
const BUILT =
  /^(packet|hashes|verdicts)-\d+\.(md|json)$|^(findings|manifest)\.json$/;

const envCandidatesDir = () =>
  process.env.TWEAKCC_CLASSIFY_DIR || process.env.SHOWTIME_TMP || undefined;

const pendingClassifyBodies = dir =>
  fs
    .readdirSync(dir)
    .filter(f => /^classify-chunk-\d+\.json$/.test(f))
    .flatMap(f => readJson(path.join(dir, f)).map(c => c.body));

function promptBody(p) {
  const map = p.identifierMap || {};
  let out = '';
  p.pieces.forEach((piece, i) => {
    out += piece;
    if (i < (p.identifiers || []).length)
      out += map[String(p.identifiers[i])] ?? '?';
  });
  return out;
}

export function buildPackets(
  cliPath,
  jsonPath,
  outDir,
  {
    per = 48,
    allowlistPath = ALLOWLIST,
    candidatesDir = envCandidatesDir(),
    force = false,
  } = {}
) {
  if (!force && fs.existsSync(outDir)) {
    const done = fs
      .readdirSync(outDir)
      .filter(f => /^verdicts-\d+\.json$/.test(f));
    if (done.length)
      throw new Error(
        `${outDir} holds ${done.join(', ')}; rebuilding would discard that review work. Merge it first, or pass --force to discard it`
      );
  }
  const source = fs.readFileSync(cliPath, 'utf8');
  const catalogue = readJson(jsonPath);
  const allowlist = fs.existsSync(allowlistPath) ? readJson(allowlistPath) : {};
  const unreviewed = findSlotLiterals(source, catalogue).filter(
    f => !allowlist[f.hash]
  );
  const byHash = new Map();
  for (const f of unreviewed) {
    if (!byHash.has(f.hash)) byHash.set(f.hash, []);
    byHash.get(f.hash).push(f);
  }
  const prompts = new Map(catalogue.prompts.map(p => [p.id, p]));
  const items = [...byHash];
  fs.mkdirSync(outDir, { recursive: true });
  for (const f of fs.readdirSync(outDir))
    if (BUILT.test(f)) fs.unlinkSync(path.join(outDir, f));
  const ids = new Set(catalogue.prompts.map(p => p.id).filter(Boolean));
  for (const v of Object.values(allowlist)) if (v.id) ids.add(v.id);
  fs.writeFileSync(
    path.join(outDir, 'existing-ids.txt'),
    [...ids].sort().join('\n') + '\n'
  );
  fs.writeFileSync(path.join(outDir, 'BRIEF.md'), BRIEF(outDir, cliPath));
  const packets = Math.max(1, Math.ceil(items.length / per));
  const size = Math.ceil(items.length / packets);
  const manifest = {
    cli: cliPath,
    catalogue: jsonPath,
    candidatesDir: candidatesDir ? path.resolve(candidatesDir) : null,
    packets: [],
  };
  for (let k = 0; k < packets && items.length; k++) {
    const nn = String(k).padStart(2, '0');
    const chunk = items.slice(k * size, (k + 1) * size);
    const md = [
      `# Slot-literal review packet ${nn} (${chunk.length} literal(s))\n`,
    ];
    for (const [hash, findings] of chunk) {
      const { offset, fullText: text } = findings[0];
      md.push(
        `\n---\n\n## ${hash}\n\nLiteral: ${JSON.stringify(text)}\nLiteral source offset: ${offset}\n`
      );
      for (const f of findings) {
        md.push(
          `\n### Renders into \`${f.promptId}\` substitution #${f.slot} (label ${f.label}), resolved via ${f.resolvedVia}\n`
        );
        const p = prompts.get(f.promptId);
        if (p) {
          const body = promptBody(p);
          md.push(
            'Prompt pristine body:\n\n```\n' +
              (body.length < 3000
                ? body
                : body.slice(0, 3000) + ' …[truncated]') +
              '\n```\n'
          );
        }
      }
      const a = Math.max(0, offset - 1500);
      const z = offset + text.length + 1200;
      md.push(
        `\nSource around the literal (${a}..${z}):\n\n\`\`\`js\n${source.slice(a, z)}\n\`\`\`\n`
      );
    }
    fs.writeFileSync(path.join(outDir, `packet-${nn}.md`), md.join(''));
    const hashes = chunk.map(([h]) => h);
    fs.writeFileSync(
      path.join(outDir, `hashes-${nn}.json`),
      JSON.stringify(hashes)
    );
    manifest.packets.push({ nn, hashes });
  }
  fs.writeFileSync(
    findingsFile(outDir),
    JSON.stringify(Object.fromEntries(items.map(([h, f]) => [h, f[0]])))
  );
  fs.writeFileSync(
    manifestFile(outDir),
    JSON.stringify(manifest, null, 2) + '\n'
  );
  return { literals: items.length, packets: items.length ? packets : 0 };
}

// The candidates dir to check against, or a problem saying why there is none.
function resolveCandidates(manifest, { candidatesDir, noCandidates }) {
  if (noCandidates) return { dir: null };
  const dir = candidatesDir || envCandidatesDir() || manifest.candidatesDir;
  if (!dir)
    return {
      problem:
        'no classify candidates dir: pass --candidates <dir> (the run dir holding classify-chunk-NN.json), set TWEAKCC_CLASSIFY_DIR, or pass --no-candidates when no classify pass is pending',
    };
  if (!fs.existsSync(dir))
    return { problem: `classify candidates dir ${dir} does not exist` };
  return { dir };
}

export function checkVerdicts(
  outDir,
  { candidatesDir, noCandidates = false, allowlistPath = ALLOWLIST } = {}
) {
  const problems = [];
  if (!fs.existsSync(manifestFile(outDir)))
    return {
      problems: [
        `${manifestFile(outDir)} does not exist; rebuild the packets with slotLiteralReview.mjs build`,
      ],
      rows: [],
      findings: {},
    };
  const manifest = readJson(manifestFile(outDir));
  const findings = readJson(findingsFile(outDir));
  const allowlist = fs.existsSync(allowlistPath) ? readJson(allowlistPath) : {};
  // Ids are checked against the catalogue and allowlist as they are NOW: a
  // re-extract, a classify merge or another review dir's merge since this build
  // may have taken an id the build-time existing-ids.txt never saw.
  const liveCatalogue = {};
  if (fs.existsSync(manifest.catalogue))
    Object.assign(
      liveCatalogue,
      catalogueIndex(readJson(manifest.catalogue).prompts || [])
    );
  else problems.push(`catalogue ${manifest.catalogue} does not exist`);
  const liveAllowlist = new Map();
  for (const [h, v] of Object.entries(allowlist))
    if (v && v.id) {
      if (!liveAllowlist.has(v.id)) liveAllowlist.set(v.id, []);
      liveAllowlist.get(v.id).push(h);
    }
  const formsOf = f =>
    f ? literalForms({ text: f.fullText, raw: f.raw }) : [];

  const cands = resolveCandidates(manifest, { candidatesDir, noCandidates });
  if (cands.problem) problems.push(cands.problem);
  const pending = cands.dir ? pendingClassifyBodies(cands.dir) : [];

  const listed = new Set(manifest.packets.map(p => `hashes-${p.nn}.json`));
  for (const f of fs.readdirSync(outDir))
    if (/^hashes-\d+\.json$/.test(f) && !listed.has(f))
      problems.push(`${f} is not in the manifest`);

  const rows = [];
  const minted = new Map();
  for (const { nn, hashes: want } of manifest.packets) {
    const hf = path.join(outDir, `hashes-${nn}.json`);
    if (!fs.existsSync(hf)) problems.push(`hashes-${nn}.json does not exist`);
    else {
      const onDisk = readJson(hf);
      if (onDisk.length !== want.length || onDisk.some(h => !want.includes(h)))
        problems.push(`hashes-${nn}.json differs from the manifest`);
    }
    for (const h of want)
      if (!findings[h]) problems.push(`findings.json: missing ${h}`);
    const vf = path.join(outDir, `verdicts-${nn}.json`);
    if (!fs.existsSync(vf)) {
      problems.push(`verdicts-${nn}.json does not exist`);
      continue;
    }
    let got;
    try {
      got = readJson(vf);
    } catch (e) {
      problems.push(`verdicts-${nn}.json is not JSON: ${e.message}`);
      continue;
    }
    if (!Array.isArray(got)) {
      problems.push(`verdicts-${nn}.json is not an array`);
      continue;
    }
    const seen = new Set();
    for (const r of got) {
      const where = `verdicts-${nn}.json ${r.hash}`;
      if (!want.includes(r.hash))
        problems.push(`${where}: not a hash of packet ${nn}`);
      if (seen.has(r.hash)) problems.push(`${where}: listed twice`);
      seen.add(r.hash);
      if (!VERDICTS.has(r.verdict))
        problems.push(
          `${where}: verdict must be catalogue|glue|not-a-slot|off-route`
        );
      if (typeof r.reason !== 'string' || r.reason.trim().length < 20)
        problems.push(`${where}: reason must cite the evidence`);
      if (allowlist[r.hash])
        problems.push(`${where}: already in the allowlist`);
      const forms = formsOf(findings[r.hash]);
      if (r.verdict === 'catalogue') {
        for (const k of ['id', 'name', 'desc'])
          if (typeof r[k] !== 'string' || !r[k].trim())
            problems.push(`${where}: catalogue needs ${k}`);
        if (typeof r.id === 'string') {
          if (!ID_RE.test(r.id))
            problems.push(`${where}: id ${r.id} is not kebab-case`);
          const bodies = liveCatalogue[r.id];
          const own = new Set(forms.map(sha1));
          if (bodies && !bodies.some(b => own.has(b)))
            problems.push(
              `${where}: id ${r.id} is already live in the catalogue for another body`
            );
          const other = (liveAllowlist.get(r.id) || []).filter(
            h => h !== r.hash
          );
          if (other.length)
            problems.push(
              `${where}: id ${r.id} is already live in the allowlist for ${other.join(', ')}`
            );
          if (minted.has(r.id) && minted.get(r.id) !== r.hash)
            problems.push(
              `${where}: id ${r.id} is also minted for ${minted.get(r.id)}`
            );
          minted.set(r.id, r.hash);
        }
        const texts = forms.map(t => t.trim()).filter(Boolean);
        if (pending.some(b => texts.some(t => b.includes(t))))
          problems.push(
            `${where}: the literal is a pending classify candidate; leave it to the classify pass`
          );
      } else {
        for (const k of ['id', 'name', 'desc'])
          if (k in r)
            problems.push(`${where}: ${r.verdict} must not carry ${k}`);
      }
      rows.push(r);
    }
    for (const h of want)
      if (!seen.has(h)) problems.push(`verdicts-${nn}.json: missing ${h}`);
  }
  return { problems, rows, findings };
}

export function mergeVerdicts(outDir, opts = {}) {
  const allowlistPath = opts.allowlistPath || ALLOWLIST;
  const { problems, rows, findings } = checkVerdicts(outDir, opts);
  if (problems.length) return { problems, appended: 0 };
  const raw = fs.existsSync(allowlistPath)
    ? fs.readFileSync(allowlistPath, 'utf8')
    : EMPTY_ALLOWLIST;
  if (!/\n}\n$/.test(raw))
    return {
      problems: [`${allowlistPath} does not end in "\\n}\\n"`],
      appended: 0,
    };
  const entries = rows.map(r => {
    const f = findings[r.hash];
    const e = { promptId: f.promptId, label: f.label, verdict: r.verdict };
    if (r.verdict === 'catalogue')
      Object.assign(e, { id: r.id, name: r.name, desc: r.desc });
    Object.assign(e, { text: f.text, reason: r.reason });
    return `  ${JSON.stringify(r.hash)}: ${JSON.stringify(e, null, 2).replace(/\n/g, '\n  ')}`;
  });
  if (!entries.length) return { problems: [], appended: 0 };
  const head = raw.slice(0, -3);
  const sep = /^\s*\{\s*$/.test(head) ? '\n' : ',\n';
  const next = head + sep + entries.join(',\n') + '\n}\n';
  JSON.parse(next);
  fs.writeFileSync(allowlistPath, next);
  return { problems: [], appended: entries.length };
}

const USAGE =
  'usage: slotLiteralReview.mjs build <cli.js> <prompts.json> <outDir> [--per N] [--candidates <dir>] [--force]\n' +
  '       slotLiteralReview.mjs merge <outDir> [--check] [--candidates <dir> | --no-candidates]';

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const flag = name => {
    const i = rest.indexOf(`--${name}`);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  const pos = rest.filter(
    (a, i) => !a.startsWith('--') && !rest[i - 1]?.match(/^--(per|candidates)$/)
  );
  const candidatesDir = flag('candidates')
    ? path.resolve(flag('candidates'))
    : undefined;
  if (cmd === 'build' && pos.length === 3) {
    const [cli, json, outDir] = pos.map(p => path.resolve(p));
    let r;
    try {
      r = buildPackets(cli, json, outDir, {
        per: Number(flag('per') || 48),
        force: rest.includes('--force'),
        ...(candidatesDir ? { candidatesDir } : {}),
      });
    } catch (e) {
      console.error(`FAIL: ${e.message}`);
      process.exit(1);
    }
    console.log(
      `slot-literal review: ${r.literals} literal(s) in ${r.packets} packet(s) -> ${outDir}`
    );
    return;
  }
  if (cmd === 'merge' && pos.length === 1) {
    const outDir = path.resolve(pos[0]);
    if (candidatesDir && rest.includes('--no-candidates')) {
      console.error('--candidates and --no-candidates are exclusive');
      process.exit(2);
    }
    const opts = {
      candidatesDir,
      noCandidates: rest.includes('--no-candidates'),
    };
    if (rest.includes('--check')) {
      const { problems } = checkVerdicts(outDir, opts);
      for (const p of problems) console.log(`  ${p}`);
      console.log(
        problems.length ? `FAIL: ${problems.length} problem(s)` : 'PASS'
      );
      process.exit(problems.length ? 1 : 0);
    }
    const r = mergeVerdicts(outDir, opts);
    for (const p of r.problems) console.log(`  ${p}`);
    if (r.problems.length) {
      console.log(`FAIL: ${r.problems.length} problem(s); nothing written`);
      process.exit(1);
    }
    console.log(
      `slot-literal review: appended ${r.appended} verdict(s) to ${path.relative(process.cwd(), ALLOWLIST)}`
    );
    return;
  }
  console.error(USAGE);
  process.exit(2);
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
)
  main();
