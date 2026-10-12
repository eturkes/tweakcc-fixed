import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const digest = value => crypto.createHash('sha256').update(value).digest('hex');

// One scratch directory per checkout and run name, so two runs (a bump and its
// follow-up campaign, or two checkouts) never share /tmp handoff files.
export function runNamespace(repoDir, env = process.env) {
  const repo = fs.realpathSync(repoDir);
  const runId = env.SHOWTIME_RUN_ID || 'default';
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId) || runId === '..') {
    throw new Error('SHOWTIME_RUN_ID must be a path-safe run name');
  }
  const tmpIsRunRoot =
    env.SHOWTIME_TMP && fs.existsSync(path.join(env.SHOWTIME_TMP, 'run.json'));
  const root = path.resolve(
    env.SHOWTIME_RUN_ROOT ||
      (tmpIsRunRoot && env.SHOWTIME_TMP) ||
      path.join(
        env.SHOWTIME_TMP || '/tmp',
        'showtime-runs',
        digest(repo),
        runId
      )
  );
  const identity = { schema: 1, repoDir: repo, runId };
  const ownerPath = path.join(root, 'run.json');
  fs.mkdirSync(root, { recursive: true });
  if (fs.existsSync(ownerPath)) {
    const owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
    if (JSON.stringify(owner) !== JSON.stringify(identity))
      throw new Error('run directory belongs to another checkout or run');
  } else {
    fs.writeFileSync(ownerPath, JSON.stringify(identity, null, 2) + '\n');
  }
  return {
    ...identity,
    root,
    cliPath: version => path.join(root, `cli-${version}.js`),
  };
}
