import assert from 'node:assert/strict';
import { test } from 'vitest';

test('an exported run root is reused, not nested inside itself', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { runNamespace } = await import('./runState.mjs');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'showtime-ns-'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'showtime-repo-'));
  try {
    const first = runNamespace(repo, { SHOWTIME_TMP: base });
    const again = runNamespace(repo, { SHOWTIME_TMP: first.root });
    assert.equal(again.root, first.root);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
