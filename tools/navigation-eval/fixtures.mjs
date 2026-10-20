import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function syntheticCorpus() {
  const files = {};
  const tasks = [];
  const add = (path, text) => {
    files[path] = text;
  };
  const evidence = (id, path, snippet) => ({
    id,
    path,
    line: files[path].split('\n').findIndex(line => line.includes(snippet)) + 1,
    snippet,
  });
  const task = (id, question, path, patterns, requiredEvidence, facts) => {
    tasks.push({
      id,
      corpus: 'synthetic',
      question,
      queries: patterns.map(pattern => ({ pattern, path, context: 0 })),
      requiredEvidence,
      expectedAnswerFacts: facts.map((text, index) => ({
        id: `${id}-fact-${index + 1}`,
        text,
        evidenceIds: requiredEvidence.map(item => item.id),
      })),
    });
  };

  const callers = [];
  for (let index = 1; index <= 12; index++) {
    const name = String(index).padStart(2, '0');
    const path = `cases/callers/src/job-${name}.ts`;
    add(
      path,
      `import { settleInvoice } from './settlement';\n` +
        `export const job${name} = () => settleInvoice('${name}');\n`
    );
    callers.push(evidence(`caller-${name}`, path, `export const job${name}`));
  }
  add(
    'cases/callers/src/settlement.ts',
    'export function settleInvoice(id: string) { return id.length > 0; }\n'
  );
  task(
    'synthetic-all-callers',
    'List every production caller of settleInvoice. Distinguish its declaration from calls; do not stop after finding the definition.',
    'cases/callers',
    ['settleInvoice'],
    callers,
    ['All twelve job files call settleInvoice; settlement.ts declares it.']
  );

  for (const kind of ['docs', 'generated', 'tests']) {
    for (let index = 1; index <= 8; index++) {
      add(
        `cases/distractors/${kind}/sample-${index}.ts`,
        'export function renewSession() { return 3600; }\n'
      );
    }
  }
  add(
    'cases/distractors/src/session.ts',
    "import { SESSION_TTL } from './policy';\n" +
      'export function renewSession() { return SESSION_TTL; }\n'
  );
  add('cases/distractors/src/policy.ts', 'export const SESSION_TTL = 900;\n');
  task(
    'synthetic-production-distractors',
    'What TTL does the production renewSession implementation return, and where is that value defined? Separate generated, example, and test declarations from production.',
    'cases/distractors',
    ['renewSession|SESSION_TTL'],
    [
      evidence(
        'production-session',
        'cases/distractors/src/session.ts',
        'return SESSION_TTL;'
      ),
      evidence(
        'production-policy',
        'cases/distractors/src/policy.ts',
        'SESSION_TTL = 900;'
      ),
    ],
    [
      'Production returns 900 from src/policy.ts; the 3600 declarations are distractors.',
    ]
  );

  add(
    'cases/dense/src/a-dense.ts',
    'export function validateQuota(n: number) { return n < 20; }\n' +
      Array.from(
        { length: 240 },
        (_, index) => `export const sample${index} = validateQuota(${index});\n`
      ).join('')
  );
  add('cases/dense/src/y-policy.ts', 'export const validateQuotaLimit = 20;\n');
  add(
    'cases/dense/src/z-consumer.ts',
    "import { validateQuota } from './a-dense';\n" +
      'export const accept = (n: number) => validateQuota(n);\n'
  );
  task(
    'synthetic-dense-first-file',
    'Find the quota predicate, the independent policy value, and the consuming function. State the strict comparison and whether 20 is accepted.',
    'cases/dense',
    ['validateQuota'],
    [
      evidence(
        'quota-predicate',
        'cases/dense/src/a-dense.ts',
        'return n < 20;'
      ),
      evidence(
        'quota-limit',
        'cases/dense/src/y-policy.ts',
        'validateQuotaLimit = 20;'
      ),
      evidence(
        'quota-consumer',
        'cases/dense/src/z-consumer.ts',
        'export const accept'
      ),
    ],
    [
      'The predicate is n < 20, the separate policy constant is 20, and accept calls the predicate; 20 is rejected.',
    ]
  );

  add(
    'cases/no-shared-text/src/ledger.ts',
    'export const adjust = (paid: number) => paid * 0.8;\n'
  );
  add(
    'cases/no-shared-text/src/flow.ts',
    "import { adjust } from './ledger';\n" +
      'export const close = (paid: number) => adjust(paid);\n'
  );
  task(
    'synthetic-no-shared-text',
    'Can the supplied search establish the customer cancellation refund policy? State what remains unsupported if the search finds nothing.',
    'cases/no-shared-text',
    ['customer cancellation refund policy'],
    [
      evidence(
        'opaque-ledger',
        'cases/no-shared-text/src/ledger.ts',
        'paid * 0.8'
      ),
      evidence(
        'opaque-flow',
        'cases/no-shared-text/src/flow.ts',
        'adjust(paid)'
      ),
    ],
    [
      'The query supplies no supporting code; the policy cannot be established from these search results.',
    ]
  );

  add(
    'cases/unicode/src/münchen quota.ts',
    'export const $cap = "€€€€€€€€€€";\n'
  );
  add('cases/unicode/src/z-consumer.ts', 'export const limite = 10;\n');
  task(
    'synthetic-unicode-budget',
    'Find the monetary cap marker and the numeric limit. Cite both files, retaining the Unicode filename and identifier punctuation.',
    'cases/unicode',
    ['\\$cap|limite'],
    [
      evidence(
        'unicode-cap',
        'cases/unicode/src/münchen quota.ts',
        '$cap = "€€€€€€€€€€"'
      ),
      evidence(
        'unicode-limit',
        'cases/unicode/src/z-consumer.ts',
        'limite = 10;'
      ),
    ],
    [
      'The cap marker is ten euro signs in münchen quota.ts; the numeric limit is 10 in z-consumer.ts.',
    ]
  );
  return { files, tasks };
}

export function writeSyntheticCorpus(root) {
  const corpus = syntheticCorpus();
  for (const [path, content] of Object.entries(corpus.files)) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return corpus.tasks;
}
