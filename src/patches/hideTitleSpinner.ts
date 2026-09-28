// Please see the note about writing patches in ./index

import { showDiff } from './index';

// Terminal-title component: busy → spinner frame (◐/◑), else static ✳:
//   let $e=E&&!Ce?y5[Pe]??S5:S5;return Bce(Se?null:V?ee:`${$e} ${ee}`)
// Groups: 1 prefix, 2 busy, 3 static glyph, 4 setTitle, 5 disabled,
// 6 noPrefix, 7 title.
const TITLE_PATTERN =
  /let ([$\w]+)=([$\w]+)&&![$\w]+\?[$\w]+\[[$\w]+\]\?\?([$\w]+):\3;return ([$\w]+)\(([$\w]+)\?null:([$\w]+)\?([$\w]+):`\$\{\1\} \$\{\7\}`\)/;

/**
 * Busy → bare title; idle/waiting → `✳ title`. The spinner interval keeps
 * ticking, but useTerminalTitle writes only when the string changes.
 */
export const writeHideTitleSpinner = (oldFile: string): string | null => {
  const match = oldFile.match(TITLE_PATTERN);
  if (!match || match.index === undefined) {
    console.error(
      'patch: hideTitleSpinner: failed to find terminal-title spinner'
    );
    return null;
  }

  const [whole, prefix, busy, glyph, setTitle, disabled, noPrefix, title] =
    match;
  const newCode =
    `let ${prefix}=${glyph};return ${setTitle}(${disabled}?null:` +
    `${noPrefix}||${busy}?${title}:` +
    '`${' +
    prefix +
    '} ${' +
    title +
    '}`)';
  const endIndex = match.index + whole.length;
  const newFile =
    oldFile.slice(0, match.index) + newCode + oldFile.slice(endIndex);

  showDiff(oldFile, newFile, newCode, match.index, endIndex);
  return newFile;
};
