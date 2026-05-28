// Please see the note about writing patches in ./index

import { showDiff } from './index';

/**
 * Neutralize the formatter that prepends line numbers to Read output.
 *
 * The formatter has been refactored multiple times:
 *   pre-2.1.86      inline `.split().map()`, `→`-prefixed with padStart
 *   2.1.86..2.1.107 `let X=H.split(...)` + feature-flag picks tab vs arrow
 *   2.1.108..2.1.130 `indexOf('\n')`+while loop, helper still has arrow branch
 *   2.1.131+        helper trimmed down to tab-only
 *
 * Stable across all of these is the preamble:
 *   `{content:VAR,startLine:VAR2}){if(!VAR)return"";`
 * We anchor on that, then splice in `return VAR` and erase the rest of the
 * function body up to its closing brace.
 */
export const writeSuppressLineNumbers = (oldFile: string): string | null => {
  const preamble =
    /\{content:([$\w]+),startLine:[$\w]+\}\)\{if\(!\1\)return"";/;
  const sigMatch = oldFile.match(preamble);

  if (sigMatch && sigMatch.index !== undefined) {
    const contentVar = sigMatch[1];
    const bodyStart = sigMatch.index + sigMatch[0].length;
    const endPattern = /\}(?=function |var |let |const |[$\w]+=[$\w]+\()/;
    const endMatch = oldFile.slice(bodyStart).match(endPattern);

    if (endMatch && endMatch.index !== undefined) {
      const bodyEnd = bodyStart + endMatch.index;
      const newCode = `return ${contentVar}`;
      const newFile =
        oldFile.slice(0, bodyStart) + newCode + oldFile.slice(bodyEnd);
      showDiff(oldFile, newFile, newCode, bodyStart, bodyEnd);
      return newFile;
    }
  }

  console.error(
    'patch: suppressLineNumbers: failed to find line number formatter pattern'
  );
  return null;
};
