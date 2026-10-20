import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureFffViewerLinks } from './fffBashSetup';

const directories: string[] = [];

const fixture = async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'fff-viewer-setup-')
  );
  directories.push(directory);
  const wrapper = path.join(directory, 'rg-fff');
  await fs.writeFile(wrapper, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  return { directory, wrapper, viewers: path.join(directory, 'viewers') };
};

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map(directory => fs.rm(directory, { recursive: true }))
  );
});

describe('ensureFffViewerLinks', () => {
  it('installs private viewer links and accepts an existing managed installation', async () => {
    const { wrapper, viewers } = await fixture();
    expect(await ensureFffViewerLinks(wrapper)).toBe(viewers);
    expect((await fs.stat(viewers)).mode & 0o777).toBe(0o700);
    for (const reader of ['cat', 'head', 'tail', 'sed']) {
      expect(await fs.realpath(path.join(viewers, '15', reader))).toBe(
        await fs.realpath(wrapper)
      );
    }
    expect(await ensureFffViewerLinks(wrapper)).toBe(viewers);
    expect((await fs.readdir(viewers)).sort()).toEqual(
      Array.from({ length: 16 }, (_, mask) => String(mask)).sort()
    );
    for (const [mask, names] of [
      ['0', []],
      ['1', ['cat']],
      ['2', ['head']],
      ['4', ['tail']],
      ['8', ['sed']],
    ] as const) {
      expect(await fs.readdir(path.join(viewers, mask))).toEqual(names);
    }
  });

  it('preserves colliding user files instead of replacing them', async () => {
    const { wrapper, viewers } = await fixture();
    await fs.mkdir(path.join(viewers, '15'), { recursive: true });
    await fs.writeFile(path.join(viewers, '15', 'cat'), 'keep');
    expect(await ensureFffViewerLinks(wrapper)).toBeNull();
    expect(await fs.readFile(path.join(viewers, '15', 'cat'), 'utf8')).toBe(
      'keep'
    );
  });

  it('rejects a redirected directory without changing its permissions', async () => {
    const { directory, wrapper, viewers } = await fixture();
    const redirected = path.join(directory, 'redirected');
    await fs.mkdir(redirected, { mode: 0o755 });
    await fs.symlink(redirected, viewers);
    expect(await ensureFffViewerLinks(wrapper)).toBeNull();
    expect((await fs.stat(redirected)).mode & 0o777).toBe(0o755);
    expect(await fs.readdir(redirected)).toEqual([]);
  });

  it('keeps native viewers when the wrapper is missing or not executable', async () => {
    const { wrapper } = await fixture();
    await fs.chmod(wrapper, 0o600);
    expect(await ensureFffViewerLinks(wrapper)).toBeNull();
    await fs.unlink(wrapper);
    expect(await ensureFffViewerLinks(wrapper)).toBeNull();
  });
});
