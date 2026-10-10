// checkSiblingArms must report every unruled arm beside a catalogued one, and
// nothing that is ruled, catalogued, word-free, unanchored or not returned.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  armGroups,
  readsAsWords,
  scanSiblingArms,
} from './checkSiblingArms.mjs';
import { keyVariants } from './probeCacheKey.mjs';
import * as siblingGate from './checkSiblingArms.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL = path.join(HERE, 'checkSiblingArms.mjs');
const key = body => keyVariants(body)[0].key;

const FIXTURE = [
  'function q(e,r){switch(e.kind){case"a":return`Fixture arm one asks about ${r.name} now?`;case"b":return`Fixture arm two asks about ${r} later?`;case"c":if(e.x)return"Fixture arm three sits in an if block";return`Fixture arm four ${r} is ruled`;case"d":return"none"}}',
  'function t(e){return e?`Fixture ternary yes branch for ${e}`:"Fixture ternary no branch here"}',
  'var notReturned=globalThis.x?"Fixture unreturned ternary one":"Fixture unreturned ternary two";',
  'function w(e){switch(e){case"x":return["Fixture array arm about cats"];case"y":return["Fixture array arm about dogs"]}}',
  'function u(e){switch(e){case 1:return"Fixture lonely switch arm one";case 2:return"Fixture lonely switch arm two"}}',
  'var arrow=e=>e?"Fixture arrow arm catalogued here":`Fixture arrow arm ${e} left out`;',
].join('\n');

const prompt = (id, pieces) => ({
  id,
  name: id,
  description: '',
  pieces,
  identifiers: [],
  identifierMap: {},
});
const CATALOGUE = [
  prompt('tool-result-fixture-arm-one', [
    'Fixture arm one asks about ${',
    '.name} now?',
  ]),
  prompt('tool-result-fixture-unreturned-one', [
    'Fixture unreturned ternary one',
  ]),
  prompt('tool-result-fixture-array-dogs', ['Fixture array arm about dogs']),
  prompt('tool-result-fixture-arrow-catalogued', [
    'Fixture arrow arm catalogued here',
  ]),
];
const CACHE = {
  [key('Fixture arm four ${} is ruled')]: { facing: 'ui' },
  [key('Fixture ternary yes branch for ${}')]: {
    facing: 'model',
    id: 'tool-result-fixture-ternary-yes',
    name: 'Fixture',
    desc: 'Fixture',
  },
};

let dir;
let cli;
let json;
let cachePath;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sibling-arms-'));
  cli = path.join(dir, 'cli-9.9.9.js');
  json = path.join(dir, 'prompts-9.9.9.json');
  cachePath = path.join(dir, 'classification.json');
  fs.writeFileSync(cli, FIXTURE);
  fs.writeFileSync(
    json,
    JSON.stringify({ version: '9.9.9', prompts: CATALOGUE })
  );
  fs.writeFileSync(cachePath, JSON.stringify(CACHE));
});
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('checkSiblingArms: groups', () => {
  it('collects switch returns through if blocks and arrays, and returned ternaries only', () => {
    const { groups, unparsed } = armGroups(FIXTURE);
    expect(unparsed).toEqual([]);
    const flat = arms => arms.flatMap(a => (a.parts ? flat(a.parts) : [a]));
    const text = g => flat(g.arms).map(a => FIXTURE.slice(a.start, a.end));
    const kinds = groups
      .filter(g => g.kind !== 'returns' && g.kind !== 'join')
      .map(g => g.kind)
      .sort();
    expect(kinds).toEqual(['switch', 'switch', 'switch', 'ternary', 'ternary']);
    const q = groups.find(g =>
      text(g).some(t => t.includes('Fixture arm one'))
    );
    expect(text(q)).toHaveLength(5);
    expect(text(q)).toContain('"Fixture arm three sits in an if block"');
    expect(groups.some(g => text(g).some(t => t.includes('unreturned')))).toBe(
      false
    );
  });

  it('treats an arm as prose only with two words in its literal text', () => {
    expect(readsAsWords('none')).toBe(false);
    expect(readsAsWords('  ')).toBe(false);
    expect(readsAsWords(' is ')).toBe(false);
    expect(readsAsWords('Allow Claude to change ?')).toBe(true);
  });

  it('counts one-letter words and skips identifier, path and host tokens', () => {
    expect(readsAsWords('I agree')).toBe(true);
    expect(readsAsWords("it's a well-known (draft).")).toBe(true);
    expect(readsAsWords('own_calls say_so')).toBe(false);
    expect(readsAsWords('/usr/bin/chromium api.github.com')).toBe(false);
    expect(readsAsWords('see api.github.com')).toBe(false);
  });
});

describe('checkSiblingArms: scan', () => {
  it('reports exactly the unruled, uncatalogued prose arms beside a catalogued arm', () => {
    const r = scanSiblingArms(cli, { catalogue: CATALOGUE, cache: CACHE });
    const bodies = r.findings
      .filter(f => f.group !== 'returns')
      .map(f => f.body)
      .sort();
    expect(bodies).toEqual([
      'Fixture arm three sits in an if block',
      'Fixture arm two asks about ${} later?',
      'Fixture array arm about cats',
      'Fixture arrow arm ${} left out',
      'Fixture ternary no branch here',
    ]);
    const two = r.findings.find(f => f.body.startsWith('Fixture arm two'));
    expect(two.anchors).toEqual(['tool-result-fixture-arm-one']);
    expect(two.key).toBe(key('Fixture arm two asks about ${} later?'));
    expect(r.findings.find(f => f.body.includes('no branch')).anchors).toEqual([
      'tool-result-fixture-ternary-yes',
    ]);
    // `none` is a bare word: the fall-out return union reaches it, but a
    // content-keyed verdict on it would catalogue every comparison of it.
    expect(r.findings.find(f => f.body === 'none')).toBeUndefined();
    expect(r.trivial).toBe(2);
    expect(r.anchored).toBe(6);
  });

  it('exits 1 with findings and 0 once every arm is ruled', () => {
    const run = () =>
      spawnSync('node', [TOOL, cli, json, '--cache', cachePath], {
        encoding: 'utf8',
      });
    const first = run();
    expect(first.status).toBe(1);
    expect(first.stdout).toMatch(
      /sibling arms: 5 uncatalogued unclassified arm\(s\)/
    );
    const ruled = { ...CACHE };
    for (const b of [
      'Fixture arm three sits in an if block',
      'Fixture arm two asks about ${} later?',
      'Fixture array arm about cats',
      'Fixture arrow arm ${} left out',
      'Fixture ternary no branch here',
    ])
      ruled[key(b)] = { facing: 'internal' };
    fs.writeFileSync(cachePath, JSON.stringify(ruled));
    const second = run();
    expect(second.status).toBe(0);
    expect(second.stdout).toMatch(/sibling arms: 0 uncatalogued/);
  });

  it('rejects a missing argument with exit 2', () => {
    const r = spawnSync('node', [TOOL, cli], { encoding: 'utf8' });
    expect(r.status).toBe(2);
  });
});

// Arms the first version missed or misjudged on CC 2.1.295.
const FIXTURE2 = [
  // Array arms: each element is a composite fragment, and an array whose joined
  // text is ruled is covered as a whole (the start-kit reason ternary).
  'function k(e){return e==="a"?["Fixture tuple arm catalogued here","own_calls"]:e==="b"?["Fixture tuple arm left out","list"]:e==="c"?["Fixture tuple arm ruled whole","say_so"]:["Fixture tuple fallback arm","list"]}',
  // A `+` chain is one arm: its head template is reported, a chain whose
  // joined text is ruled is not opened, and a ternary under `+` is returned.
  'function m(s){switch(s.kind){case"a":return"Fixture concat sibling catalogued";case"b":return`Fixture concat head ${s.i} has no string`+(s.k===null?"":` (the fixture key is ${f(s.k)})`);case"c":return"Fixture whole chain part one "+"fixture whole chain part two"}}',
  'function n(r,x){return(r?"Fixture plus ternary catalogued":"Fixture plus ternary other arm")+x}',
  // A verdict recorded against the pre-promotion body still binds.
  'function p(e,t){return e?"Fixture legacy sibling catalogued":`Fixture legacy arm ${{yes:"y",no:"n"}[t]} stays ruled`}',
  // A `{` inside a slot must not swallow the prose after it.
  'function d(e,c){switch(e){case 1:return"Fixture brace sibling catalogued";case 2:return`${c("{")} Please confirm`}}',
  // One-letter words count; identifier-shaped tokens do not.
  'function y(e){switch(e){case 1:return"Fixture agree sibling catalogued";case 2:return"I agree";case 3:return"own_calls say_so"}}',
].join('\n');
const CATALOGUE2 = [
  prompt('tool-result-fixture-tuple', ['Fixture tuple arm catalogued here']),
  prompt('tool-result-fixture-concat', ['Fixture concat sibling catalogued']),
  prompt('tool-result-fixture-plus', ['Fixture plus ternary catalogued']),
  prompt('tool-result-fixture-legacy', ['Fixture legacy sibling catalogued']),
  prompt('tool-result-fixture-brace', ['Fixture brace sibling catalogued']),
  prompt('tool-result-fixture-agree', ['Fixture agree sibling catalogued']),
];
const LEGACY_BODY = 'Fixture legacy arm ${{yes:"y",no:"n"}[t]} stays ruled';
const CACHE2 = {
  [key('Fixture tuple arm ruled whole\nsay_so')]: { facing: 'internal' },
  [key('Fixture whole chain part one fixture whole chain part two')]: {
    facing: 'model',
    id: 'tool-result-fixture-whole-chain',
    name: 'Fixture',
    desc: 'Fixture',
  },
  [key(LEGACY_BODY)]: { facing: 'ui' },
};

describe('checkSiblingArms: composite, concat, legacy and word arms', () => {
  let cli2;
  beforeAll(() => {
    cli2 = path.join(dir, 'cli-9.9.8.js');
    fs.writeFileSync(cli2, FIXTURE2);
  });

  it('reports exactly the unruled arms', () => {
    const r = scanSiblingArms(cli2, { catalogue: CATALOGUE2, cache: CACHE2 });
    expect(
      r.findings
        .filter(f => f.group !== 'returns')
        .map(f => f.body)
        .sort()
    ).toEqual(
      [
        ' (the fixture key is ${(.k)})',
        '${("{")} Please confirm',
        'Fixture concat head ${.i} has no string',
        'Fixture plus ternary other arm',
        'Fixture tuple arm left out',
        'Fixture tuple fallback arm',
        'I agree',
      ].sort()
    );
  });

  it('reads an array element as a composite fragment', () => {
    const r = scanSiblingArms(cli2, { catalogue: CATALOGUE2, cache: CACHE2 });
    const left = r.findings.find(f => f.body === 'Fixture tuple arm left out');
    expect(left.kind).toBe('fragment');
    expect(left.anchors).toEqual(['tool-result-fixture-tuple']);
  });

  it('opens a `+` chain only when its joined text has no verdict', () => {
    const r = scanSiblingArms(cli2, { catalogue: CATALOGUE2, cache: CACHE2 });
    const head = r.findings.find(f => f.body.startsWith('Fixture concat head'));
    expect(head.anchors).toEqual(
      expect.arrayContaining([
        'tool-result-fixture-concat',
        'tool-result-fixture-whole-chain',
      ])
    );
    expect(r.findings.some(f => f.body.includes('whole chain'))).toBe(false);
  });

  it('binds a verdict keyed to the pre-promotion body', () => {
    const r = scanSiblingArms(cli2, { catalogue: CATALOGUE2, cache: CACHE2 });
    expect(r.findings.some(f => f.body.includes('legacy arm'))).toBe(false);
    const unruled = { ...CACHE2 };
    delete unruled[key(LEGACY_BODY)];
    const r2 = scanSiblingArms(cli2, { catalogue: CATALOGUE2, cache: unruled });
    expect(r2.findings.some(f => f.body.includes('legacy arm'))).toBe(true);
  });

  it('counts words from the template text, not through a `{` in a slot', () => {
    const r = scanSiblingArms(cli2, { catalogue: CATALOGUE2, cache: CACHE2 });
    const brace = r.findings.find(f => f.body.endsWith('Please confirm'));
    expect(brace?.anchors).toEqual(['tool-result-fixture-brace']);
  });

  it('counts a one-letter word and not identifier-shaped tokens', () => {
    const r = scanSiblingArms(cli2, { catalogue: CATALOGUE2, cache: CACHE2 });
    expect(r.findings.find(f => f.body === 'I agree')?.anchors).toEqual([
      'tool-result-fixture-agree',
    ]);
    expect(r.findings.find(f => f.body === 'own_calls say_so')?.kind).toBe(
      'returns'
    );
    expect(
      r.findings.some(
        f => f.body === 'own_calls say_so' && f.group === 'switch'
      )
    ).toBe(false);
  });

  it('prints valid JSON on stdout with --json and the summary on stderr', () => {
    const json2 = path.join(dir, 'prompts-9.9.8.json');
    const cache2 = path.join(dir, 'classification2.json');
    fs.writeFileSync(json2, JSON.stringify({ prompts: CATALOGUE2 }));
    fs.writeFileSync(cache2, JSON.stringify(CACHE2));
    const r = spawnSync(
      'node',
      [TOOL, cli2, json2, '--cache', cache2, '--json'],
      {
        encoding: 'utf8',
      }
    );
    expect(r.status).toBe(1);
    expect(JSON.parse(r.stdout).findings).toHaveLength(8);
    expect(r.stderr).toMatch(/sibling arms: 8 uncatalogued/);
  });
});

// Shapes the gate missed on CC 2.1.296: the start_task refusal builder (a
// switch whose `break` falls out to a shared return, inside a flatMap callback
// spread into one list beside a map callback's own clause) and the Artifact
// tool's respelling tables (the needle is catalogued prompt text, the
// replacement renders in its place on another host).
const FIXTURE4 = [
  'function r(c,u){return D([...c.map((d)=>{let p=g(d);return`fixture it has no argument ${d}`}),...u.flatMap((d)=>{let p=d.path;switch(d.keyword){case"type":return[`${p} fixture must be a type`];case"enum":if(d.ok)return[`${p} fixture must be one of`];break}return[`${p??"the fixture arguments"} ${d.message??"fixture are not valid"}`]})])}',
  'var t=[["fixture clearer than terminal text","fixture clearer than the conversation"]],h="The fixture page is fixture clearer than terminal text for readers.";function o(e){return e?Oq(h,t):h}',
  'function s(e){switch(e){case 1:return"Fixture closed switch catalogued";default:return"Fixture closed default arm"}return"Fixture unreachable tail here"}',
  'var nope=[["fixture needle nowhere catalogued","fixture replacement stays quiet"]];',
  'var codes=new Map([["EFIXTURE","Fixture lookup label for a code"],["fixture-key","Fixture lookup label for a key"]]);',
  'function l(c){return[...c.map((d)=>`fixture unanchored clause ${d}`),"fixture plain element here"]}',
].join('\n');
const CATALOGUE4 = [
  prompt('tool-description-fixture-host', [
    'The fixture page is fixture clearer than terminal text for readers. EFIXTURE and fixture-key are named here.',
  ]),
  prompt('tool-result-fixture-closed', ['Fixture closed switch catalogued']),
];
const CACHE4 = {
  [key('${} fixture must be a type')]: {
    facing: 'model',
    id: 'tool-result-fixture-must-be-a-type',
    name: 'Fixture',
    desc: 'Fixture',
  },
};

describe('checkSiblingArms: fall-out returns, spread lists and respellings', () => {
  let cli4;
  beforeAll(() => {
    cli4 = path.join(dir, 'cli-9.9.6.js');
    fs.writeFileSync(cli4, FIXTURE4);
  });
  const scan = () =>
    scanSiblingArms(cli4, { catalogue: CATALOGUE4, cache: CACHE4 });
  const find = (r, text) => r.findings.find(f => f.body.includes(text));

  it('reads the return a switch falls out to as its default arm', () => {
    const f = find(scan(), 'fixture are not valid');
    expect(f?.anchors).toEqual(['tool-result-fixture-must-be-a-type']);
  });

  it('reads a list built from spread map callbacks as one group', () => {
    const f = find(scan(), 'fixture it has no argument');
    expect(f?.group).toBe('list');
    expect(f?.anchors).toEqual(['tool-result-fixture-must-be-a-type']);
  });

  it('reports a respelling replacement whose needle is catalogued text', () => {
    const f = find(scan(), 'fixture clearer than the conversation');
    expect(f?.group).toBe('respelling');
    expect(f?.anchors).toEqual(['tool-description-fixture-host']);
  });

  it('reports nothing unreachable, unanchored, keyed or outside a catalogued host', () => {
    const bodies = scan()
      .findings.filter(f => f.group !== 'returns')
      .map(f => f.body)
      .sort();
    expect(bodies).toHaveLength(5);
    for (const quiet of [
      'unreachable tail',
      'replacement stays quiet',
      'needle nowhere',
      'unanchored clause',
      'plain element',
      'lookup label',
      'fixture clearer than terminal text',
    ])
      expect(bodies.some(b => b.includes(quiet))).toBe(false);
    expect(bodies.some(b => b === 'Fixture closed default arm')).toBe(true);
    expect(bodies.some(b => b.includes('fixture must be one of'))).toBe(true);
  });
});

// A switch also falls out when its last clause runs off its end, or through a
// labelled break to its own label; a clause that loops forever never does.
const FIXTURE5 = [
  'function f(x){switch(x){case 1:return "Fixture known clause here";default:x=0;}return "Fixture fallback after a plain default";}',
  'function g(x){a:switch(x){case 1:return "Fixture labelled known arm";default:if(x)break a;return "Fixture labelled default arm"}return "Fixture labelled tail arm"}',
  'function h(x){switch(x){case 1:return "Fixture loop known arm";default:for(;;){if(x)return "Fixture loop inner arm"}}return "Fixture loop dead tail"}',
  'function k(x){switch(x){default:try{return "Fixture try known arm"}finally{x=1}}return "Fixture try dead tail"}',
].join('\n');
const CATALOGUE5 = [
  prompt('tool-result-fixture-known-clause', ['Fixture known clause here']),
  prompt('tool-result-fixture-labelled-known', ['Fixture labelled known arm']),
  prompt('tool-result-fixture-loop-known', ['Fixture loop known arm']),
  prompt('tool-result-fixture-try-known', ['Fixture try known arm']),
];

describe('checkSiblingArms: switch completion', () => {
  let r;
  beforeAll(() => {
    const cli5 = path.join(dir, 'cli-9.9.8.js');
    fs.writeFileSync(cli5, FIXTURE5);
    r = scanSiblingArms(cli5, { catalogue: CATALOGUE5, cache: {} });
  });
  const bodies = () => r.findings.map(f => f.body);

  it('reads the return after a default clause that completes normally', () => {
    expect(bodies()).toContain('Fixture fallback after a plain default');
  });

  it('reads the return after a labelled break out of the switch', () => {
    expect(bodies()).toContain('Fixture labelled tail arm');
    expect(bodies()).toContain('Fixture labelled default arm');
  });

  it('ignores a tail no clause can reach', () => {
    const switchBodies = r.findings
      .filter(f => f.group === 'switch')
      .map(f => f.body);
    expect(switchBodies).not.toContain('Fixture loop dead tail');
    expect(switchBodies).not.toContain('Fixture try dead tail');
    expect(
      r.findings.find(f => f.body === 'Fixture loop dead tail')?.kind
    ).toBe('returns');
    expect(r.findings.find(f => f.body === 'Fixture try dead tail')?.kind).toBe(
      'returns'
    );
  });
});

describe('checkSiblingArms: unparseable segments', () => {
  it('counts a segment acorn cannot parse and exits 2', () => {
    const bundle = [
      '\n/*@@TWEAKCC_MODULE:0:good.js@@*/\n',
      'function u(e){switch(e){case 1:return"Fixture parse arm one here";case 2:return"Fixture parse arm two here"}}',
      '\n/*@@TWEAKCC_MODULE:1:broken.js@@*/\n',
      'function ((( {',
    ].join('');
    const cli3 = path.join(dir, 'cli-9.9.7.js');
    const json3 = path.join(dir, 'prompts-9.9.7.json');
    const cache3 = path.join(dir, 'classification3.json');
    fs.writeFileSync(cli3, bundle);
    fs.writeFileSync(json3, JSON.stringify({ prompts: [] }));
    fs.writeFileSync(cache3, '{}');
    const { unparsed } = armGroups(bundle);
    expect(unparsed.map(u => u.name)).toEqual(['broken.js']);
    const r = spawnSync('node', [TOOL, cli3, json3, '--cache', cache3], {
      encoding: 'utf8',
    });
    expect(r.status).toBe(2);
    expect(r.stdout).toMatch(/UNPARSED segment broken\.js/);
    expect(r.stdout).toMatch(/1 unparseable segment/);
  });
});

describe('checkSiblingArms: bounded assembled strings', () => {
  const anchor = prompt('tool-result-flow-anchor', ['Flow anchor']);
  const scan = (code, catalogue = [anchor], cache = {}) => {
    const file = path.join(dir, 'cli-9.9.5.js');
    fs.writeFileSync(file, code);
    return scanSiblingArms(file, { catalogue, cache });
  };
  const finding = (result, body) => result.findings.find(f => f.body === body);

  it('flows conditional spreads into a joined array', () => {
    const r = scan(
      'function f(x){return ["Flow anchor",...(x?["Spread label"]:[])].join("\\n")}'
    );
    expect(finding(r, 'Spread label')?.group).toBe('join');
  });

  it('resolves a let ternary binding used in a join', () => {
    const r = scan(
      'function f(x){let label=x?"Bound label":"Other label";return ["Flow anchor",label].join("\\n")}'
    );
    expect(finding(r, 'Bound label')?.group).toBe('join');
    expect(finding(r, 'Other label')?.group).toBe('join');
  });

  it('includes push and unshift arguments on a joined binding', () => {
    const r = scan(
      'function f(){const a=["Flow anchor"];a.push("Pushed label");a.unshift("First label");return a.join("\\n")}'
    );
    expect(finding(r, 'Pushed label')?.group).toBe('join');
    expect(finding(r, 'First label')?.group).toBe('join');
  });

  it('groups a plain array join without map callbacks', () => {
    const r = scan(
      'function f(){return ["Flow anchor","Plain label"].join("\\n")}'
    );
    expect(finding(r, 'Plain label')?.group).toBe('join');
  });

  it('unions if/return paths and parallel return arrays as returns', () => {
    const r = scan(
      'function f(x){if(x===1)return ["Flow anchor"];if(x===2)return ["Return label"];return "Fallback label"}'
    );
    expect(finding(r, 'Return label')?.group).toBe('returns');
    expect(finding(r, 'Return label')?.kind).toBe('returns');
    expect(finding(r, 'Fallback label')?.kind).toBe('returns');
  });

  it('accepts one-word headings and markup beside an anchor', () => {
    const r = scan(
      'function f(){return ["Flow anchor","Status:","# Heading","|Column|","**Bold**","```code```","<tag>"].join("\\n")}'
    );
    for (const body of [
      'Status:',
      '# Heading',
      '|Column|',
      '**Bold**',
      '```code```',
      '<tag>',
    ])
      expect(finding(r, body)?.group).toBe('join');
  });

  // CC 2.1.296: `error` and `read` arms got `model` verdicts, then anchored
  // every join they sat in, and each re-extract raised more siblings.
  it('neither reports nor anchors on a bare word', () => {
    const r = scan(
      'function f(){return ["Flow anchor","pending","Two words"].join("\\n")}'
    );
    expect(r.findings.map(f => f.body)).toEqual(['Two words']);
    const cache = { [key('error')]: { facing: 'model' } };
    const g = scan(
      'function g(){return ["error","Other line here"].join("\\n")}',
      [],
      cache
    );
    expect(g.anchored).toBe(0);
    expect(g.findings).toEqual([]);
  });

  it('excludes no-letter glue while keeping a word-bearing arm', () => {
    const r = scan(
      'function f(){return ["Flow anchor","Status:"," | ** ","\\n","123"].join("\\n")}'
    );
    expect(r.findings.map(f => f.body)).toEqual(['Status:']);
  });

  it('excludes literals inside a larger anchored template', () => {
    const outer =
      'Larger anchored template ${"Flow anchor"+"nested missing"} tail text';
    const r = scan(
      'function f(){const t=`Larger anchored template ${"Flow anchor"+"nested missing"} tail text`;return ["Flow anchor","Status:"].join("\\n")}',
      [anchor, prompt('tool-result-outer-template', [outer])]
    );
    expect(r.findings.map(f => f.body)).toEqual(['Status:']);
  });

  it('tracks assignments, logical arms, sequence tails and supported receivers', () => {
    const r = scan(
      'function f(x){var a="Initial label";a=x&&"Logical label";a+="Added label";return ["Flow anchor",(ignored(),a)].concat(["Concat label"]).filter(Boolean).flat().slice(0).join(" ").trim()}'
    );
    expect(r.findings.map(f => f.body).sort()).toEqual(
      ['Initial label', 'Logical label', 'Added label', 'Concat label'].sort()
    );
    const cached = scan(
      'function f(){const a=["Cached anchor"];return "Status:"+a.join(" ").trim()}',
      [],
      {
        [key('Cached anchor')]: {
          facing: 'model',
          id: 'tool-result-cached-anchor',
        },
      }
    );
    expect(cached.findings).toEqual([
      expect.objectContaining({
        body: 'Status:',
        group: 'join',
        anchors: ['tool-result-cached-anchor'],
      }),
    ]);
  });

  it('collects expression map and flatMap spreads without following arbitrary calls', () => {
    const r = scan(
      'function helper(){return "Callee label"}function f(xs,x){return ["Flow anchor",...xs.map(y=>y?"Mapped label":"Alternate label"),...xs.flatMap(y=>["Flat label"]),...(x&&["Spread label"]),helper()].join(" ")}'
    );
    expect(r.findings.map(f => f.body).sort()).toEqual(
      ['Mapped label', 'Alternate label', 'Flat label', 'Spread label'].sort()
    );
  });

  it('honors block shadowing and excludes closure and module bindings', () => {
    const r = scan(
      'var outer="Module label";function f(){let a="Outer label";const xs=["Flow anchor",outer];{let a="Inner label";xs.push(a)}function g(){xs.push("Closure label");return ["Flow anchor",a].join(" ")}return xs.join(" ")}'
    );
    expect(r.findings.map(f => f.body)).toEqual(['Inner label']);
  });

  it('bounds identifier hops at six and terminates binding cycles', () => {
    const r = scan(
      'function f(){let a="Cycle label";a=b;let b=a;const h="Deep label",g=h,e=g,d=e,c=d,z=c,y=z;return ["Flow anchor",a,y,"Status:"].join(" ")}'
    );
    expect(r.findings.map(f => f.body).sort()).toEqual(
      ['Cycle label', 'Status:'].sort()
    );
  });

  it('keeps nested function returns and template slots out of a return union', () => {
    const r = scan(
      'function f(x){function nested(){return "Nested label"}if(x)return "Flow anchor";return `Return label ${x?"Slot label":"Other slot"}`}'
    );
    expect(r.findings.map(f => f.body)).toEqual([
      'Return label ${?"Slot label":"Other slot"}',
    ]);
    expect(r.findings[0].kind).toBe('returns');
  });

  it('appends sibling candidates once per hash with all source sites and relations', () => {
    const r = scan(
      'function f(){return ["Flow anchor","Status:","Status:"].join("\\n")}'
    );
    const candidates = [{ hash: 'existing', body: 'Existing candidate' }];
    expect(siblingGate.appendSiblingCandidates(candidates, r)).toBe(1);
    expect(siblingGate.appendSiblingCandidates(candidates, r)).toBe(0);
    expect(candidates).toHaveLength(2);
    expect(candidates[1]).toMatchObject({
      hash: key('Status:'),
      body: 'Status:',
      source: 'sibling-arm',
      len: 7,
      hint: null,
    });
    expect(candidates[1].sourceSites).toEqual(
      r.findings.map(f => ({ start: f.start, end: f.end }))
    );
    expect(candidates[1].siblingRelations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'join',
          anchor: 'tool-result-flow-anchor',
          anchorAt: expect.any(Number),
        }),
      ])
    );
    const existing = [
      { hash: key('Status:'), body: 'Status:', source: 'prose-gate' },
    ];
    expect(siblingGate.appendSiblingCandidates(existing, r)).toBe(0);
    expect(existing).toHaveLength(1);
    expect(existing[0].sourceSites).toHaveLength(2);
  });
});
