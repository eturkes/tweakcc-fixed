import { beforeAll, describe, expect, it } from 'vitest';

import { loadMatcherCore, scanEntry } from './checkBakedIdentifiers.mjs';

const bundle = (label, body) => ({
  label,
  content: `var a=1;${body};var z=2;`,
  version: '2.1.300',
  buildTime: undefined,
});

describe('checkBakedIdentifiers', () => {
  let core;
  beforeAll(async () => {
    core = await loadMatcherCore();
  }, 60000);

  const darwin = bundle(
    'darwin',
    'x=`Pick ${p??"the arguments"}: ${R.map((O)=>br[String(O)]).join(" or ")}`'
  );
  const linux = bundle(
    'linux',
    'x=`Pick ${t??"the arguments"}: ${n.map((M)=>Qx[String(M)]).join(" or ")}`'
  );

  it('reports a name that a slot expression keeps and another build renamed', () => {
    const r = scanEntry(
      core,
      {
        id: 'fixture-baked',
        pieces: [
          'Pick ${',
          '??"the arguments"}: ${',
          '.map((',
          ')=>',
          '[String(O)]).join(" or ")}',
        ],
      },
      [darwin, linux]
    );
    expect(r.found).toEqual({ darwin: 1, linux: 1 });
    expect(r.differing).toEqual([
      { piece: 4, name: 'O', seen: { linux: ['M'] } },
    ]);
  });

  it('passes the same entry once the name is a slot', () => {
    const r = scanEntry(
      core,
      {
        id: 'fixture-promoted',
        pieces: [
          'Pick ${',
          '??"the arguments"}: ${',
          '.map((',
          ')=>',
          '[',
          '(',
          ')]).join(" or ")}',
        ],
      },
      [darwin, linux]
    );
    expect(r).toBeNull();
  });

  it('does not count a name both builds share', () => {
    const r = scanEntry(
      core,
      {
        id: 'fixture-stable',
        pieces: [
          'Pick ${',
          '??"the arguments"}: ${',
          '.map((',
          ')=>',
          '[String(',
          ')]).join(" or ")}',
        ],
      },
      [darwin, linux]
    );
    expect(r.names).toEqual(['String']);
    expect(r.differing).toEqual([]);
  });
});
