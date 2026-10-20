export const probeModelEnvironmentArgs = (env = process.env) =>
  env.ANTHROPIC_MODEL === undefined
    ? []
    : ['-e', `ANTHROPIC_MODEL=${env.ANTHROPIC_MODEL}`.replace(/;$/, '\\;')];

// The probe's forwarder relays the binary's own OAuth headers to
// api.anthropic.com, so credentials or a base URL inherited from the host
// shell (an agent harness exports all three) would replace them and 401.
export const PROBE_UNSET_ENV = ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL'];
export const probeCommandPrefix = () => `unset ${PROBE_UNSET_ENV.join(' ')}; `;
