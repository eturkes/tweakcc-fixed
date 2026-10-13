import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, it } from 'vitest';
import { extractModule } from './native-extraction.mjs';
import { captureRipgrep, ripgrepIdentity } from './native-handler.mjs';

const root = mkdtempSync(join(tmpdir(), 'native-handler-unit-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

it('bounds repeated minified names by exact native module identity', () => {
  const source =
    '/*@@TWEAKCC_MODULE:1:/first.js@@*/\nfunction Foo(){return 1;}\n' +
    '/*@@TWEAKCC_MODULE:415:/wanted.js@@*/\nfunction Foo(){return 2;}\n' +
    '/*@@TWEAKCC_MODULE:416:/last.js@@*/\nfunction Foo(){return 3;}';
  const module = extractModule(source, '/wanted.js');
  assert.equal(module.index, 415);
  assert.equal(module.source.trim(), 'function Foo(){return 2;}');
  assert.throws(() => extractModule(source, '/missing.js'));
  assert.throws(() => extractModule(source + source, '/wanted.js'));
});

it('reuses one byte-identical raw capture for both conditions without adding sort flags', async () => {
  const target = join(root, 'source.ts');
  writeFileSync(target, 'needle needle\n');
  const request = {
    args: ['--json', 'needle'],
    target,
    cwd: root,
    cacheDir: join(root, 'cache'),
    ripgrep: ripgrepIdentity(),
  };
  let rechecks = 0;
  const beforeSpawn = () => {
    rechecks++;
  };
  const before = await captureRipgrep({ ...request, beforeSpawn });
  const after = await captureRipgrep({ ...request, beforeSpawn });
  assert.equal(before.cacheHit, false);
  assert.equal(after.cacheHit, true);
  assert.equal(before.stdout, after.stdout);
  assert.equal(before.sha256, after.sha256);
  assert.deepEqual(before.identity.args, ['--json', 'needle']);
  assert.equal(rechecks, 2);
});

it('cache keys include actual arguments and beforeSpawn is required even on cache hits', async () => {
  const target = join(root, 'scope.ts');
  writeFileSync(target, 'first\nsecond\n');
  const request = {
    target,
    cwd: root,
    cacheDir: join(root, 'cache'),
    ripgrep: ripgrepIdentity(),
    beforeSpawn: () => {},
  };
  const first = await captureRipgrep({ ...request, args: ['--json', 'first'] });
  const second = await captureRipgrep({
    ...request,
    args: ['--json', 'second'],
  });
  assert.notEqual(first.key, second.key);
  await assert.rejects(
    () =>
      captureRipgrep({
        ...request,
        args: ['--json', 'first'],
        beforeSpawn: () => {
          throw new Error('recheck refused');
        },
      }),
    /recheck refused/
  );
});

it('corrupted cached output fails instead of silently changing one condition', async () => {
  const target = join(root, 'corrupt.ts');
  writeFileSync(target, 'corruptionProbe\n');
  const request = {
    args: ['--json', 'corruptionProbe'],
    target,
    cwd: root,
    cacheDir: join(root, 'corrupt-cache'),
    ripgrep: ripgrepIdentity(),
    beforeSpawn: () => {},
  };
  const capture = await captureRipgrep(request);
  const path = join(request.cacheDir, `${capture.key}.json`);
  const stored = JSON.parse(readFileSync(path));
  stored.stdout = 'different bytes';
  writeFileSync(path, JSON.stringify(stored));
  await assert.rejects(() => captureRipgrep(request), /bytes changed/);
});

it('invalid native regexes are explicit failures', async () => {
  const target = join(root, 'invalid.ts');
  writeFileSync(target, 'value\n');
  await assert.rejects(
    () =>
      captureRipgrep({
        args: ['--json', '['],
        target,
        cwd: root,
        cacheDir: join(root, 'invalid-cache'),
        ripgrep: ripgrepIdentity(),
        beforeSpawn: () => {},
      }),
    /Native ripgrep failed/
  );
});
