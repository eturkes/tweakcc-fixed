import { describe, it, expect } from 'vitest';

import {
  analyzeThrowingRewriters,
  checkThrowingNeedles,
} from './throwingRewriters.mjs';

const REWRITER =
  'function Oq(e,a){let t=e;for(let[n,r]of a){if(!t.includes(n))throw Error("core prompt: a lifted paragraph lacks a spelling it rewrites");t=t.replaceAll(n,r)}return t}';
const PARA =
  'Claude publishes a page when it reads clearer than terminal text for the person.';
const ID = 'tool-description-para';
const PROMPTS = [
  { name: ID, id: ID, pieces: [PARA], identifiers: [], identifierMap: {} },
];

const gate = (bundle, overrides) => {
  const analysis = analyzeThrowingRewriters(bundle, PROMPTS);
  const { failures } = checkThrowingNeedles(analysis, PROMPTS, id =>
    id in overrides ? overrides[id] : null
  );
  return { analysis, failures };
};

describe('throwingRewriters: wrapper traversal', () => {
  it('checks every fixed table a wrapper hands the rewriter', () => {
    const bundle = `${REWRITER}var A=[["clearer than terminal text","x"]],B=[["for the person","y"]],P=${JSON.stringify(PARA)};function W(t,f){return f?Oq(t,A):Oq(t,B)}export function T(c){return W(P,c)}`;
    const { analysis, failures } = gate(bundle, {
      [ID]: PARA.replace(' for the person', ''),
    });
    expect(analysis.problems).toEqual([]);
    expect(analysis.needles.map(n => n.needle).sort()).toEqual([
      'clearer than terminal text',
      'for the person',
    ]);
    expect(failures.map(f => [f.kind, f.needle])).toEqual([
      ['missing', 'for the person'],
    ]);
  });
});

describe('throwingRewriters: needles the bundle computes', () => {
  it('resolves a zero-argument function that returns a literal', () => {
    const bundle = `${REWRITER}function g(){return"for the person"}var P=${JSON.stringify(PARA)};export function T(){return Oq(P,[[g(),"y"]])}`;
    const { analysis, failures } = gate(bundle, { [ID]: '' });
    expect(analysis.problems).toEqual([]);
    expect(analysis.needles.map(n => n.needle)).toEqual(['for the person']);
    expect(failures.map(f => [f.kind, f.id])).toEqual([['empty', ID]]);
    expect(gate(bundle, { [ID]: PARA }).failures).toEqual([]);
  });

  it('resolves an arrow const and a const object member', () => {
    const bundle = `${REWRITER}const g=()=>N.k,N={k:"for the person"};var P=${JSON.stringify(PARA)};export function T(){return Oq(P,[[g(),"y"],[N["k"],"z"]])}`;
    const { analysis, failures } = gate(bundle, {
      [ID]: PARA.replace(' for the person', ''),
    });
    expect(analysis.problems).toEqual([]);
    // Both entries spell the one literal in N, so they are one needle.
    expect(analysis.needles).toHaveLength(1);
    expect(failures).toHaveLength(1);
  });

  it('fails closed on a needle it cannot resolve instead of matching anything', () => {
    const bundle = `${REWRITER}var P=${JSON.stringify(PARA)};export function T(e){return Oq(P,[[e.label(),"y"],["clearer than terminal text","z"]])}`;
    const { analysis } = gate(bundle, { [ID]: '' });
    expect(analysis.problems).toHaveLength(1);
    expect(analysis.problems[0].kind).toBe('unresolved');
    expect(analysis.problems[0].reason).toContain('computed at runtime');
    expect(analysis.needles.map(n => n.needle)).toEqual([
      'clearer than terminal text',
    ]);
  });

  it('does not resolve a function that rebinds or does work first', () => {
    const bundle = `${REWRITER}function g(){return"for the person"}g=()=>"x";var P=${JSON.stringify(PARA)};export function T(){return Oq(P,[[g(),"y"]])}`;
    expect(gate(bundle, {}).analysis.problems).toHaveLength(1);
  });
});

describe('throwingRewriters: rewriter shapes', () => {
  const P = `var P=${JSON.stringify(PARA)};`;
  const CALL = 'export function T(){return Oq(P,[["for the person","y"]])}';
  const dropped = { [ID]: PARA.replace(' for the person', '') };
  const shapes = {
    forEach:
      'function Oq(e,a){let t=e;a.forEach(([n,r])=>{if(!t.includes(n))throw Error("x");t=t.replaceAll(n,r)});return t}',
    'pair destructured in the body':
      'function Oq(e,a){let t=e;for(let x of a){let[n,r]=x;if(!t.includes(n))throw Error("x");t=t.replaceAll(n,r)}return t}',
    'function replacement':
      'function Oq(e,a){let t=e;for(let[n,r]of a){if(!t.includes(n))throw Error("x");t=t.replaceAll(n,()=>r)}return t}',
    'guard before the loop':
      'function Oq(e,a){let t=e;if(!a.every(([n])=>t.includes(n)))throw Error("x");for(let[n,r]of a)t=t.replaceAll(n,r);return t}',
  };
  for (const [shape, fn] of Object.entries(shapes))
    it(`recognises a ${shape} rewriter`, () => {
      const { analysis, failures } = gate(fn + P + CALL, dropped);
      expect(analysis.rewriters.map(r => r.name)).toEqual(['Oq']);
      expect(analysis.problems).toEqual([]);
      expect(failures.map(f => f.kind)).toEqual(['missing']);
    });

  it('fails closed on the throw idiom in a shape it cannot read', () => {
    const fn =
      'function Oq(e,a){let t=e;for(let i=0;i<a.length;i++){let n=a[i][0];if(!t.includes(n))throw Error("x");t=t.replaceAll(n,a[i][1])}return t}';
    const { analysis } = gate(fn + P + CALL, dropped);
    expect(analysis.rewriters).toEqual([]);
    expect(analysis.problems.map(p => p.kind)).toEqual(['unrecognised']);
  });

  it('does not take an unrelated throw-then-split for the idiom', () => {
    const fn =
      'function chk(e,t){if(base(e).startsWith(t))throw Error("reserved");if(!e.includes(t))throw Error("bad");return e.split(sep)}';
    expect(gate(fn + P, {}).analysis.problems).toEqual([]);
  });
});

describe('throwingRewriters: calls the traversal cannot follow', () => {
  const P = `var P=${JSON.stringify(PARA)};`;
  const T = '[["for the person","y"]]';
  for (const [label, use] of [
    ['an alias', `const W=Oq;export function g(){return W(P,${T})}`],
    ['an object member', `export const api={rw:Oq};api.rw(P,${T})`],
    ['a callback', `export function g(f){return[P].map(x=>f(x,${T}),Oq)}`],
  ])
    it(`reports a rewriter reached through ${label}`, () => {
      const { analysis } = gate(REWRITER + P + use, {});
      expect(analysis.problems.map(p => p.reason).join('\n')).toMatch(
        /Oq \(Oq\) is used as a value/
      );
    });

  it('reports a rewriter that is never called', () => {
    const { analysis } = gate(REWRITER + P, {});
    expect(analysis.problems.map(p => p.reason)).toEqual([
      'rewriter Oq is never called by name',
    ]);
  });

  it('reports a needle bound with let and assigned later', () => {
    const { analysis } = gate(
      `${REWRITER}${P}let N;N="for the person";export function g(){return Oq(P,[[N,"y"]])}`,
      {}
    );
    expect(analysis.problems.map(p => p.reason).join('\n')).toContain(
      'computed at runtime'
    );
  });

  it('reports a module the parser only recovered', () => {
    const { analysis } = gate(
      `${REWRITER}${P}let q=1;let q=2;export function g(){return Oq(P,${T})}`,
      {}
    );
    expect(analysis.problems.map(p => p.kind)).toContain('unparsed');
  });
});

describe('throwingRewriters: needles another id spells', () => {
  const needle = 'these actions read and write it';
  const text = `Data: ${needle} as the user.`;
  const entry = (id, pieces) => ({ id, name: id, pieces, identifiers: [] });

  it('maps a needle held in a const to the id that spells it', () => {
    const bundle = `${REWRITER}var Q="Some other text for this id here.",N=${JSON.stringify(needle)},P=${JSON.stringify(text)};export function D(){return Oq(P,[[N,"this tool reads"]])}`;
    const prompts = [
      entry('para', [text]),
      entry('spell', ['Some other text for this id here.']),
      entry('spell', [needle]),
    ];
    const analysis = analyzeThrowingRewriters(bundle, prompts);
    expect(analysis.needles[0].needleIds).toEqual(['spell']);
    const ov = { spell: 'these actions read and edit it' };
    const { failures } = checkThrowingNeedles(analysis, prompts, id =>
      id in ov ? ov[id] : null
    );
    expect(failures.map(f => [f.kind, f.id, f.needle])).toEqual([
      ['desync', 'para', 'these actions read and edit it'],
    ]);
  });

  it('patches a templated needle through its slot spelling', () => {
    const bundle = `${REWRITER}var TS="artifact-capabilities",N=\`the \\\`\${TS}\\\` skill lists\`,P=\`Load the \\\`\${TS}\\\` skill lists first.\`;export function D(){return Oq(P,[[N,"the skill"]])}`;
    const prompts = [
      {
        ...entry('para', ['Load the \\`${', '}\\` skill lists first.']),
        identifiers: [0],
      },
      {
        ...entry('spell', ['the \\`${', '}\\` skill lists']),
        identifiers: [0],
      },
    ];
    const analysis = analyzeThrowingRewriters(bundle, prompts);
    expect(analysis.needles[0].needleIds).toEqual(['spell']);
    const ov = { spell: 'the \\`${TS}\\` skill index' };
    const { failures } = checkThrowingNeedles(analysis, prompts, id =>
      id in ov ? ov[id] : null
    );
    expect(failures.map(f => [f.kind, f.needle])).toEqual([
      ['desync', 'the `${…}` skill index'],
    ]);
  });

  it('fails when the patched needle cannot be computed', () => {
    const analysis = {
      needles: [
        {
          needle: needle,
          parts: [needle],
          calls: ['Oq(P,A)'],
          needleIds: ['spell'],
          paragraphIds: ['para'],
          unattributedCarriers: [],
        },
      ],
    };
    const prompts = [
      entry('para', [text]),
      entry('spell', ['Unrelated words.']),
    ];
    const { failures } = checkThrowingNeedles(analysis, prompts, id =>
      id === 'spell' ? 'Other words.' : null
    );
    expect(failures.map(f => [f.kind, f.id])).toEqual([
      ['unpatchable', 'spell'],
    ]);
  });
});
