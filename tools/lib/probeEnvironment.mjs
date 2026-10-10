export const probeModelEnvironmentArgs = (env = process.env) =>
  env.ANTHROPIC_MODEL === undefined
    ? []
    : ['-e', `ANTHROPIC_MODEL=${env.ANTHROPIC_MODEL}`.replace(/;$/, '\\;')];
