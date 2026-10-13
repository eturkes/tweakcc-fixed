import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getFffTriple } from './ripgrepFff';

const paths = vi.hoisted(() => ({ root: '', config: '' }));

vi.mock('./config', () => ({
  get CONFIG_DIR() {
    return paths.config;
  },
}));

vi.mock('node:url', async importOriginal => {
  const original = await importOriginal<typeof import('node:url')>();
  return {
    ...original,
    fileURLToPath: (url: string | URL) =>
      String(url).endsWith('/ripgrepFff.ts')
        ? path.join(paths.root, 'src', 'ripgrepFff.ts')
        : original.fileURLToPath(url),
  };
});

let temp: string;
let dest: string;
let stamp: string;
let localStamp: string;
let ensure: () => Promise<string | null>;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), 'fff-installer-test-'));
  paths.root = path.join(temp, 'checkout');
  paths.config = path.join(temp, 'config');
  await fs.mkdir(path.join(paths.root, 'src'), { recursive: true });
  await fs.writeFile(
    path.join(paths.root, 'package.json'),
    JSON.stringify({ version: '9.9.9' })
  );
  vi.resetModules();
  const module = await import('./ripgrepFff');
  const triple = module.getFffTriple();
  expect(triple).not.toBeNull();
  ensure = module.ensureRgFffWrapper;
  dest = path.join(paths.config, 'fff', triple!, 'rg-fff');
  stamp = path.join(path.dirname(dest), '.version');
  localStamp = path.join(path.dirname(dest), '.local-sha256');
  fetchMock = vi.fn().mockRejectedValue(Error('unexpected network request'));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await fs.rm(temp, { recursive: true, force: true });
});

async function binary(file: string, body: string, time: number, mode = 0o755) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, body, { mode });
  await fs.utimes(file, new Date(time), new Date(time));
}

function local(profile: string) {
  return path.join(paths.root, 'tools', 'rg-fff', 'target', profile, 'rg-fff');
}

function sha(body: string) {
  return crypto.createHash('sha256').update(body).digest('hex');
}

function published(body: string) {
  fetchMock
    .mockResolvedValueOnce(new Response(body))
    .mockResolvedValueOnce(new Response(sha(body)));
}

describe.skipIf(getFffTriple() === null)('fff wrapper installer', () => {
  it.each([1000, 2000])(
    'installs changed local bytes regardless of an equal or older mtime (%i)',
    async time => {
      await binary(local('release'), 'local-new', time);
      await binary(dest, 'installed-old', 2000);
      await fs.writeFile(stamp, '9.9.9');
      expect(await ensure()).toBe(dest);
      expect(await fs.readFile(dest, 'utf8')).toBe('local-new');
      await expect(fs.stat(stamp)).rejects.toThrow();
      expect(await fs.readFile(localStamp, 'utf8')).toBe(sha('local-new'));
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it('keeps identical bytes without replacing the inode and invalidates release provenance', async () => {
    await binary(local('release'), 'same', 1000);
    await binary(dest, 'same', 2000);
    await fs.writeFile(stamp, '9.9.9');
    const before = await fs.stat(dest);
    expect(await ensure()).toBe(dest);
    expect((await fs.stat(dest)).ino).toBe(before.ino);
    await expect(fs.stat(stamp)).rejects.toThrow();
    expect(await fs.readFile(localStamp, 'utf8')).toBe(sha('same'));
  });

  it('repairs a newer non-executable installation even when its bytes match', async () => {
    await binary(local('release'), 'same', 1000);
    await binary(dest, 'same', 2000, 0o600);
    expect(await ensure()).toBe(dest);
    expect((await fs.stat(dest)).mode & 0o777).toBe(0o755);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('selects the newest valid build and skips directories or non-executable candidates', async () => {
    await binary(local('release'), 'release', 1000);
    await binary(local('debug'), 'debug', 2000);
    expect(await ensure()).toBe(dest);
    expect(await fs.readFile(dest, 'utf8')).toBe('debug');
    await fs.chmod(local('debug'), 0o600);
    expect(await ensure()).toBe(dest);
    expect(await fs.readFile(dest, 'utf8')).toBe('release');
    await fs.unlink(local('debug'));
    await fs.mkdir(local('debug'));
    expect(await ensure()).toBe(dest);
    expect(await fs.readFile(dest, 'utf8')).toBe('release');
  });

  it('does not accept a directory or symlink as the installed executable', async () => {
    await fs.mkdir(dest, { recursive: true });
    expect(await ensure()).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await fs.rmdir(dest);
    await binary(path.join(temp, 'foreign'), 'foreign', 1000);
    await fs.symlink(path.join(temp, 'foreign'), dest);
    await fs.writeFile(stamp, '9.9.9');
    published('published');
    expect(await ensure()).toBe(dest);
    expect((await fs.lstat(dest)).isSymbolicLink()).toBe(false);
    expect(await fs.readFile(path.join(temp, 'foreign'), 'utf8')).toBe(
      'foreign'
    );
    expect(await fs.readFile(dest, 'utf8')).toBe('published');
  });

  it('refetches the requested release after development deployment instead of reusing its stamp', async () => {
    await binary(local('release'), 'development', 1000);
    await binary(dest, 'released-old', 2000);
    await fs.writeFile(stamp, '9.9.9');
    expect(await ensure()).toBe(dest);
    await fs.rm(path.join(paths.root, 'tools'), { recursive: true });
    published('published');
    expect(await ensure()).toBe(dest);
    expect(await fs.readFile(dest, 'utf8')).toBe('published');
    expect(await fs.readFile(stamp, 'utf8')).toBe('9.9.9');
    await expect(fs.stat(localStamp)).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await ensure()).toBe(dest);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('fails closed on a local install error after invalidating the old release stamp', async () => {
    await binary(local('release'), 'local-new', 1000);
    await binary(dest, 'installed-old', 2000);
    await fs.writeFile(stamp, '9.9.9');
    await fs.mkdir(`${dest}.tmp-${process.pid}`);
    expect(await ensure()).toBeNull();
    expect(await fs.readFile(dest, 'utf8')).toBe('installed-old');
    await expect(fs.stat(stamp)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps the existing binary on missing or mismatched release checksums', async () => {
    await binary(dest, 'installed-old', 1000);
    await fs.writeFile(stamp, '9.9.8');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock
      .mockResolvedValueOnce(new Response('unverified'))
      .mockResolvedValueOnce(new Response('', { status: 404 }));
    expect(await ensure()).toBeNull();
    expect(await fs.readFile(dest, 'utf8')).toBe('installed-old');
    fetchMock
      .mockResolvedValueOnce(new Response('unverified'))
      .mockResolvedValueOnce(new Response('0'.repeat(64)));
    expect(await ensure()).toBeNull();
    expect(await fs.readFile(dest, 'utf8')).toBe('installed-old');
    expect(error).toHaveBeenCalledTimes(2);
  });
});
