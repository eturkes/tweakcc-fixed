// Please see the note about writing patches in ./index

import { debug, escapeNonAscii } from '../utils';
import { showDiff } from './index';
import { observeFffFileUsage, useFffAutocomplete } from './fffRuntime';
import { bindFffSession } from './fffContext';

const GREP_DESC_ANCHOR = 'built on ripgrep';
const GREP_GUIDANCE_MARKER = 'Native Grep navigation:';
const GREP_GUIDANCE =
  '\n\n' +
  GREP_GUIDANCE_MARKER +
  ' For broad file discovery by content, use output_mode files_with_matches. Use Glob for filename patterns. Narrow the path or glob, use output_mode content with a small context window to inspect matches, and Read candidate files to inspect current code. Matches are textual candidates. When LSP is available and a source position is known, use goToDefinition, findReferences, or incomingCalls for definitions, references, or callers.';

const BASH_GUIDANCE_ANCHOR = 'Prefer dedicated tools over';
const BASH_GUIDANCE_MARKER = 'Native search and fff files:';
const BASH_GUIDANCE =
  ' For broad file discovery by content, use Grep with output_mode files_with_matches. Use Glob for filename patterns. Narrow the path or glob, use Grep output_mode content with a small context window, and Read candidate files to inspect current code. When LSP is available and a source position is known, use goToDefinition, findReferences, or incomingCalls for definitions, references, or callers. Use fff files SomeName for fuzzy filename discovery, or fff --stats for local aggregate service counts.';

const fffShellSetup = (wrapperPath: string): string => {
  const quoted = "'" + wrapperPath.replaceAll("'", "'\\''") + "'";
  return (
    escapeNonAscii(
      JSON.stringify(`if [ -x ${quoted} ]; then export RG_FFF_SESSION=`)
    ) +
    '+process.pid+' +
    escapeNonAscii(
      JSON.stringify(
        '; unalias fff 2>/dev/null || true; ' +
          `function fff { ${quoted} "$@"; }; ` +
          `${quoted} --warmup "$PWD" >/dev/null 2>&1 || true; fi`
      )
    )
  );
};

export const hasFffShellIntegration = (
  file: string,
  wrapperPath: string
): boolean => file.includes('=[' + fffShellSetup(wrapperPath) + ',');

const installFffShell = (file: string, wrapperPath: string): string | null => {
  if (hasFffShellIntegration(file, wrapperPath)) return file;
  const pattern =
    /function ([$\w]+)\(\)\{if\(![$\w]+\(\)\)return null;return\["unalias find 2>\/dev\/null \|\| true","unalias grep 2>\/dev\/null \|\| true",/g;
  const matches = [...file.matchAll(pattern)];
  if (matches.length !== 1 || matches[0].index === undefined) {
    console.error(
      'patch: swapRipgrepForFff: failed to find unique native shell setup'
    );
    return null;
  }
  const consumers = [
    ...file.matchAll(/let ([$\w]+)=([$\w]+)\(\);if\(\1!==null\)/g),
  ].filter(
    match =>
      match[2] === matches[0][1] &&
      file
        .slice(match.index, match.index! + 1000)
        .includes('FIND_GREP_FUNC_END')
  );
  if (consumers.length !== 1 || consumers[0].index === undefined) {
    console.error(
      'patch: swapRipgrepForFff: failed to find unique native shell setup consumer'
    );
    return null;
  }
  const match = consumers[0];
  const start = match.index!;
  const insertion =
    `let ${match[1]}=[${fffShellSetup(wrapperPath)},${match[2]}()].filter(Boolean).join("\\n");` +
    `if(${match[1]}!==null)`;
  const updated =
    file.slice(0, start) + insertion + file.slice(start + match[0].length);
  showDiff(file, updated, insertion, start, start + match[0].length);
  return updated;
};

export const restoreNativeSearchTools = (file: string): string | null => {
  const pattern =
    /(?:^|[;}])var ([$\w]+)=new Set;var ([$\w]+)=new Set\(\[([$\w]+),([$\w]+)\]\);function ([$\w]+)\(\)\{if\(![$\w]+\(\)\|\|![$\w]+\(\)\)return \1;let ([$\w]+)=([$\w]+),/g;
  const matches = [...file.matchAll(pattern)].filter(
    match =>
      file.includes(`var ${match[3]}="Glob";`) &&
      file.includes(`var ${match[4]}="Grep";`) &&
      [match[1], match[2]].includes(match[7])
  );
  if (matches.length !== 1 || matches[0].index === undefined) {
    console.error(
      'patch: swapRipgrepForFff: failed to find unique native search omission gate'
    );
    return null;
  }
  const match = matches[0];
  if (match[7] === match[1]) return file;
  const suffix = `let ${match[6]}=${match[7]},`;
  const start = match.index! + match[0].length - suffix.length;
  const replacement = `let ${match[6]}=${match[1]},`;
  const updated =
    file.slice(0, start) + replacement + file.slice(start + suffix.length);
  showDiff(file, updated, replacement, start, start + suffix.length);
  return updated;
};

const skipString = (s: string, i: number): number => {
  const q = s[i];
  i++;
  while (i < s.length) {
    if (s[i] === '\\') i += 2;
    else if (s[i] === q) return i;
    else i++;
  }
  return i;
};

/** From a position INSIDE a template literal, return the index of that
 *  template's closing backtick, skipping `${…}` interpolations (which may nest
 *  further templates) and escaped chars. -1 if unbalanced.
 *
 *  A naive "next unescaped backtick" scan stops on the OPENING backtick of a
 *  template nested in an interpolation — CC 2.1.215+ builds the Grep
 *  description as `…${vW()==="default"?`…`:""}…`, so splicing there lands
 *  inside the ternary consequent and breaks the file. Regex literals and
 *  comments inside an interpolation are not modelled; none occur in these
 *  prompt builders, and the -1 refusal is the guard. */
const findTemplateEnd = (s: string, from: number): number => {
  const modes: Array<{ k: 'tpl' } | { k: 'expr'; b: number }> = [{ k: 'tpl' }];
  for (let i = from; i < s.length; i++) {
    const top = modes[modes.length - 1];
    const c = s[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (top.k === 'tpl') {
      if (c === '`') {
        modes.pop();
        if (modes.length === 0) return i;
        continue;
      }
      if (c === '$' && s[i + 1] === '{') {
        modes.push({ k: 'expr', b: 0 });
        i++;
      }
      continue;
    }
    if (c === '`') {
      modes.push({ k: 'tpl' });
      continue;
    }
    if (c === '"' || c === "'") {
      i = skipString(s, i);
      continue;
    }
    if (c === '{') {
      top.b++;
      continue;
    }
    if (c === '}') {
      if (top.b === 0) modes.pop();
      else top.b--;
      continue;
    }
  }
  return -1;
};

/** [BEST-EFFORT] Append text before the unescaped closing backtick of every
 *  bullet/string that contains `anchor`. Idempotent via `marker`. */
const appendBeforeClosingBacktick = (
  file: string,
  anchor: string,
  text: string,
  marker: string,
  label: string
): string => {
  if (file.includes(marker)) return file;
  // Defensive: we splice before a backtick (inside a backtick template literal);
  // a backtick in `text` would break template parity. Refuse rather than corrupt.
  if (text.includes('`')) {
    console.error(
      `patch: swapRipgrepForFff: ${label} guidance contains a backtick; skipping (would break template parity)`
    );
    return file;
  }
  const inserts: number[] = [];
  let from = 0;
  for (;;) {
    const a = file.indexOf(anchor, from);
    if (a === -1) break;
    const j = findTemplateEnd(file, a);
    if (j === -1) {
      console.error(
        `patch: swapRipgrepForFff: ${label} anchor at ${a} has no balanced closing backtick; skipping this site`
      );
    } else {
      inserts.push(j);
    }
    from = a + anchor.length;
  }
  if (inserts.length === 0) {
    debug(`patch: swapRipgrepForFff: ${label} anchor not found; skipping`);
    return file;
  }
  let out = file;
  for (const pos of inserts.sort((x, y) => y - x)) {
    out = out.slice(0, pos) + text + out.slice(pos);
  }
  showDiff(file, out, text, inserts[inserts.length - 1], inserts[0]);
  return out;
};

const appendAsyncGuidance = (method: string, guidance: string): string =>
  method.replace(
    /return ([\s\S]*)\}$/,
    (_, expression: string) =>
      'return(await ' +
      expression +
      ')+' +
      escapeNonAscii(JSON.stringify(guidance)) +
      '}'
  );

const appendBashGuidance = (file: string, guidance: string): string => {
  if (file.includes(BASH_GUIDANCE_MARKER)) return file;
  const start = file.indexOf('searchHint:"execute shell commands"');
  const end = start < 0 ? -1 : file.indexOf(',isConcurrencySafe(', start);
  if (start >= 0 && end > start && end - start < 10000) {
    const methods = file.slice(start, end);
    const prompt = methods.match(
      /async prompt\(\{model:([$\w]+),tools:([$\w]+),leanPrompt:([$\w]+),bashFirstTrimmed:([$\w]+)\}\)\{return [$\w]+\(\1,await [$\w]+\(\2\),\2,\3,\4\)\}/
    );
    if (prompt) {
      const updated = methods.replace(
        prompt[0],
        appendAsyncGuidance(prompt[0], '\n\n' + BASH_GUIDANCE_MARKER + guidance)
      );
      const result = file.slice(0, start) + updated + file.slice(end);
      showDiff(file, result, updated, start, end);
      return result;
    }
  }
  const headers =
    /return\["Executes (?:a|a given) bash command and returns its output\.",/g;
  if (headers.test(file)) {
    return file.replace(
      headers,
      header =>
        header +
        escapeNonAscii(JSON.stringify(BASH_GUIDANCE_MARKER + guidance)) +
        ','
    );
  }
  return appendBeforeClosingBacktick(
    file,
    BASH_GUIDANCE_ANCHOR,
    ' ' + BASH_GUIDANCE_MARKER + guidance,
    BASH_GUIDANCE_MARKER,
    'Bash description'
  );
};

const appendGrepGuidance = (file: string): string => {
  if (file.includes(GREP_GUIDANCE_MARKER)) return file;
  const start = file.indexOf(
    'searchHint:"search file contents with regex (ripgrep)"'
  );
  const end = start < 0 ? -1 : file.indexOf(',create(', start);
  if (start >= 0 && end > start && end - start < 20000) {
    const methods = file.slice(start, end);
    const description = methods.match(
      /async description\(\)\{return ([$\w]+)\(void 0\)\}/
    );
    const prompt = methods.match(
      /async prompt\(\{model:([$\w]+),leanPrompt:([$\w]+)\}\)\{return ([$\w]+)\(\1,\2\)\}/
    );
    if (description && prompt && description[1] === prompt[3]) {
      let updated = methods;
      for (const match of [description, prompt]) {
        updated = updated.replace(
          match[0],
          appendAsyncGuidance(match[0], GREP_GUIDANCE)
        );
      }
      const result = file.slice(0, start) + updated + file.slice(end);
      showDiff(file, result, updated, start, end);
      return result;
    }
  }
  return appendBeforeClosingBacktick(
    file,
    GREP_DESC_ANCHOR,
    GREP_GUIDANCE,
    GREP_GUIDANCE_MARKER,
    'Grep description'
  );
};

export const writeSwapRipgrepForFff = (
  oldFile: string,
  wrapperPath: string
): string | null => {
  if (
    oldFile.includes(
      'export RG_FFF_SESSION="${process.pid}"; local _cc_bin='
    ) ||
    oldFile.includes('args:["--fff-claude-bin="+process.execPath]')
  ) {
    console.error(
      'patch: swapRipgrepForFff: legacy search interception requires applying from pristine Claude Code'
    );
    return null;
  }
  const restored = restoreNativeSearchTools(oldFile);
  if (restored === null) return null;
  const installed = installFffShell(restored, wrapperPath);
  if (installed === null) return null;
  let file = appendBashGuidance(appendGrepGuidance(installed), BASH_GUIDANCE);

  const observed = observeFffFileUsage(file, wrapperPath);
  if (observed === null) {
    debug(
      'patch: swapRipgrepForFff: successful file-operation observer absent'
    );
  } else {
    file = observed;
  }

  const autocomplete = useFffAutocomplete(file, wrapperPath);
  if (autocomplete !== null) file = autocomplete;

  const bound = bindFffSession(file);
  if (bound !== null) file = bound;

  return file;
};
