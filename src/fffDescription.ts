export const FFF_FEATURE_TITLE =
  '[EXPERIMENTAL] native search and fff filename discovery';

export const FFF_FEATURE_DESCRIPTION =
  'Guide Claude to discover unknown project files with fff files in Bash, then inspect candidate code. Guidance follows custom and saved system prompts whenever Bash is available. Keep native Grep and Glob available, retaining matching, ordering, pagination, and permissions. Fuzzy filename words can match in any order; ranking uses local file usage and Git activity. Also adds fuzzy @ suggestions and optional Bash-read learning. Normal Bash searches retain native behavior. History stays under ~/.tweakcc/fff.';

export const FFF_BASH_READ_TITLE = 'fff: learn from Bash file reads';

export const FFF_BASH_READ_DESCRIPTION =
  'Teach fff filename ranking from successful supported cat, head, tail, and single-file sed commands in Claude Code. Requires the native search and fff filename discovery integration; enabled by default. Preserves viewer output and status, and skips failed or ambiguous reads. Stores file paths and usage metadata locally. Absolute viewer paths, custom shell viewers, and stdin-only reads can bypass learning.';
