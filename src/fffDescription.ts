export const FFF_FEATURE_TITLE =
  '[EXPERIMENTAL] native search and fff file autocomplete';

export const FFF_FEATURE_DESCRIPTION =
  'Keep native Grep and Glob available in Claude Code. Grep retains native matching, result ordering, and pagination. Use fff for fuzzy @ file suggestions and fff files <query>; filename ranking can use local Read/Edit/Write history, optional Bash reads, and Git activity. Bash grep, rg, and find keep their native behavior. The local daemon prewarms at shell setup; fff --stats reports aggregate service counts. History stays under ~/.tweakcc/fff.';

export const FFF_BASH_READ_TITLE = 'fff: learn from Bash file reads';

export const FFF_BASH_READ_DESCRIPTION =
  'Teach fff filename ranking from successful supported cat, head, tail, and single-file sed commands in Claude Code. Requires the native search and fff autocomplete integration; enabled by default. Preserves viewer output and status, and skips failed or ambiguous reads. Stores file paths and usage metadata locally. Absolute viewer paths, custom shell viewers, and stdin-only reads can bypass learning.';
