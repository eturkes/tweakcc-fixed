import { readFileSync } from 'node:fs';
import { extractNative } from './native-extraction.mjs';
import { executeNative, ripgrepIdentity } from './native-handler.mjs';

const options = {};
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index];
  const value = process.argv[index + 1];
  if (
    ![
      '--source',
      '--source-sha256',
      '--cache',
      '--ripgrep',
      '--ripgrep-sha256',
    ].includes(name) ||
    !value
  ) {
    throw new Error(`Unknown or incomplete native adapter option: ${name}`);
  }
  options[name.slice(2)] = value;
}
if (!options.source || !options.cache)
  throw new Error('--source and --cache are required');

try {
  const extracted = extractNative(options.source, options['source-sha256']);
  const ripgrep = ripgrepIdentity(options.ripgrep);
  if (
    options['ripgrep-sha256'] &&
    options['ripgrep-sha256'] !== ripgrep.sha256
  ) {
    throw new Error('Native ripgrep differs from the prepared condition');
  }
  const input = JSON.parse(readFileSync(0, 'utf8'));
  const result = await executeNative(extracted, input, {
    cacheDir: options.cache,
    ripgrep,
  });
  process.stdout.write(
    JSON.stringify({ output: result.output, exitCode: 0 }) + '\n'
  );
} catch (error) {
  process.stdout.write(
    JSON.stringify({ output: '', exitCode: 2, error: error.message }) + '\n'
  );
}
