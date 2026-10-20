import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { sha256 } from '../core.mjs';

export { sha256 };

export const fileHash = file => sha256(readFileSync(file));

export function directory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

export function redactor(secrets = []) {
  return function clean(value) {
    if (typeof value === 'string') {
      let result = value;
      for (const secret of secrets) {
        if (secret) result = result.replaceAll(secret, '[REDACTED]');
      }
      return result.replace(
        /Bearer\s+[A-Za-z0-9._~+/-]+/gi,
        'Bearer [REDACTED]'
      );
    }
    if (Array.isArray(value)) return value.map(clean);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value)
          .filter(
            ([key]) =>
              !/authorization|api.?key|access.?token|refresh.?token/i.test(key)
          )
          .map(([key, item]) => [key, clean(item)])
      );
    }
    return value;
  };
}

export function saveJson(file, value, clean = value => value) {
  writeFileSync(file, JSON.stringify(clean(value), null, 2) + '\n', {
    mode: 0o600,
  });
}
