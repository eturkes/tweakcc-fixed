// Please see the note about writing patches in ./index

import { showDiff } from './index';

// CC sizes instruction files (CLAUDE.md, rules, imports) against a per-file
// char limit = max(40000, context window x 0.05 x chars-per-token); the total
// limit is max(120000, that):
//   function Mut(e=dt()){let o=Jp(e,qm()),r=Number.isFinite(o)&&o>0?o:gyt;
//   return Math.max(LZr,Math.round(r*DZr*Fy(e)))}
//   var NZr=120000;function FZr(e){return Math.max(NZr,Mut(e))}
// Over the total → startup/doctor warning + telemetry; over the per-file
// limit → warning, and nested CLAUDE.md files loaded mid-session are cut.
// Returning Infinity from the per-file function lifts both limits.
export const writeUnlimitedInstructionSize = (
  oldFile: string
): string | null => {
  const pattern =
    /function [$\w]+\(([$\w]+)=[$\w]+\(\)\)\{(?=let ([$\w]+)=[$\w]+\(\1,[$\w]+\(\)\),([$\w]+)=Number\.isFinite\(\2\)&&\2>0\?\2:[$\w]+;return Math\.max\([$\w]+,Math\.round\(\3\*[$\w]+\*[$\w]+\(\1\)\)\)\})/g;
  const matches = [...oldFile.matchAll(pattern)];
  if (matches.length !== 1 || matches[0].index === undefined) {
    console.error(
      `patch: unlimitedInstructionSize: expected 1 instruction-size limit function, found ${matches.length}`
    );
    return null;
  }

  const startIndex = matches[0].index + matches[0][0].length;
  const newCode = 'return 1/0;';
  const newFile =
    oldFile.slice(0, startIndex) + newCode + oldFile.slice(startIndex);

  showDiff(oldFile, newFile, newCode, startIndex, startIndex);
  return newFile;
};
