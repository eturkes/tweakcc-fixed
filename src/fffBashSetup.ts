import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import * as path from 'node:path';

export async function ensureFffViewerLinks(
  wrapper: string
): Promise<string | null> {
  const directory = path.join(path.dirname(wrapper), 'viewers');
  try {
    await fs.access(wrapper, constants.X_OK);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const metadata = await fs.lstat(directory);
    if (!metadata.isDirectory() || metadata.uid !== process.getuid?.()) {
      return null;
    }
    await fs.chmod(directory, 0o700);
    for (let mask = 0; mask < 16; mask++) {
      const subset = path.join(directory, String(mask));
      await fs.mkdir(subset, { recursive: true, mode: 0o700 });
      const existingDirectory = await fs.lstat(subset);
      if (
        !existingDirectory.isDirectory() ||
        existingDirectory.uid !== process.getuid?.()
      ) {
        return null;
      }
      await fs.chmod(subset, 0o700);
      const readers = ['cat', 'head', 'tail', 'sed'].filter(
        (_, bit) => mask & (1 << bit)
      );
      if ((await fs.readdir(subset)).some(entry => !readers.includes(entry))) {
        return null;
      }
      for (const [bit, reader] of ['cat', 'head', 'tail', 'sed'].entries()) {
        if (!(mask & (1 << bit))) continue;
        const link = path.join(subset, reader);
        const existing = await fs.lstat(link).catch(error => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
          throw error;
        });
        if (existing) {
          if (
            !existing.isSymbolicLink() ||
            existing.uid !== process.getuid?.() ||
            path.resolve(subset, await fs.readlink(link)) !==
              path.resolve(wrapper)
          ) {
            return null;
          }
          continue;
        }
        await fs.symlink(wrapper, link);
      }
    }
    return directory;
  } catch {
    return null;
  }
}
