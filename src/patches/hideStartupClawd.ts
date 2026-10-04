// Please see the note about writing patches in ./index

import { showDiff } from './index';

/**
 * Find the Clawd wrapper component function body start index.
 *
 * The Clawd rendering has two layers:
 * - Inner component (e.g., MKz): renders Apple_Terminal Clawd
 * - Wrapper component (e.g., cE6): renders MKz on Apple or ASCII art otherwise
 *
 * We target the WRAPPER to avoid layout issues from nulling just the inner.
 *
 * Steps:
 * 1. Find the inner component by looking for '▛███▜' (Clawd ASCII art)
 * 2. Trace back to find the inner function name
 * 3. Find the wrapper function that createElement's the inner component
 * 4. Return the wrapper function body start index
 */
/**
 * Method 1 (CC >= 2.1.237): Clawd became a POSED mascot.
 *
 * The art is no longer one literal run. It is a pose table keyed by pose name,
 * with each row split into left/edge/right segments:
 *
 *   U6h = {
 *     default:     {r1L:" \u2590", r1E:"\u259B\u2588\u2588\u2588\u259B\u2588", r1R:"", r2L:"\u259D\u259C", r2R:"\u2588\u2580"},
 *     "look-left": {...}, "look-right": {...}, "arms-up": {...}
 *   }
 *
 * so the old art literal is simply not in the bundle any more (the 5th glyph
 * went from `\u259C` to `\u259B`, and the raw `▛███▜` form is gone entirely).
 * Tracing back from the art to a function no longer works either, because the
 * table is a module-level `var` far from its renderer.
 *
 * Anchor on the table — the one shape only this feature has — and derive the
 * wrapper as the function that INDEXES it by pose. That is the same wrapper the
 * old code targeted: it returns `jsx(Enc,{pose})` on Apple_Terminal and the
 * segmented art otherwise. The search window stops at the next `function ` so a
 * preceding function cannot swallow the match (unbounded, `fnc` also matched).
 */
const findPosedClawdWrapper = (oldFile: string): number | null => {
  const table = oldFile.match(/\b([$\w]+)=\{default:\{r1L:/);
  if (!table) return null;
  const name = table[1];
  const decl = /function ([$\w]+)\(([$\w]*)\)\{/g;
  let m: RegExpExecArray | null;
  while ((m = decl.exec(oldFile)) !== null) {
    const bodyStart = m.index + m[0].length;
    let body = oldFile.slice(bodyStart, bodyStart + 2000);
    const next = body.indexOf('function ');
    if (next !== -1) body = body.slice(0, next);
    if (body.includes(`${name}[`) && body.includes('pose:')) return bodyStart;
  }
  return null;
};

/**
 * Method 0 (CC >= 2.1.285): the pose table was split into arm/eye/feet tables
 * and the wrapper became a React-compiler memo component that destructures its
 * props: `function xpe(o){let i=w(47),t;...let{pose:c,color:l,paint:m}=t,...`.
 * That destructure is the anchor; walk back to the function that owns it and
 * insert at its body start. Rejects the match if another function starts in
 * between (the destructure would then belong to a nested function).
 */
const findDestructuredPoseWrapper = (oldFile: string): number | null => {
  const props = /let\{pose:[$\w]+,color:[$\w]+,paint:[$\w]+\}=/g;
  let m: RegExpExecArray | null;
  while ((m = props.exec(oldFile)) !== null) {
    const fnStart = oldFile.lastIndexOf('function ', m.index);
    if (fnStart === -1) continue;
    const head = oldFile.slice(fnStart, m.index);
    const decl = head.match(/^function ([$\w]+)\(([$\w]*)\)\{/);
    if (!decl || head.indexOf('function ', 1) !== -1) continue;
    return fnStart + decl[0].length;
  }
  return null;
};

const findStartupClawdComponents = (oldFile: string): number[] => {
  const indices: number[] = [];

  const destructured = findDestructuredPoseWrapper(oldFile);
  if (destructured !== null) {
    indices.push(destructured);
    return indices;
  }

  const posed = findPosedClawdWrapper(oldFile);
  if (posed !== null) {
    indices.push(posed);
    return indices;
  }

  const clawdPattern = /▛███▜|\\u259B\\u2588\\u2588\\u2588\\u259C/gi;

  // Find the inner component function name
  const clawdMatch = clawdPattern.exec(oldFile);
  if (!clawdMatch) return indices;

  const clawdIndex = clawdMatch.index;
  const lookbackStart = Math.max(0, clawdIndex - 2000);
  const beforeText = oldFile.slice(lookbackStart, clawdIndex);

  const functionPattern = /function ([$\w]+)\([^)]*\)\{/g;
  let lastFunctionMatch: RegExpExecArray | null = null;
  let match: RegExpExecArray | null;
  while ((match = functionPattern.exec(beforeText)) !== null) {
    lastFunctionMatch = match;
  }

  if (!lastFunctionMatch) {
    console.error(
      `patch: hideStartupClawd: failed to find inner Clawd function`
    );
    return indices;
  }

  const innerFuncName = lastFunctionMatch[1];

  // Find the wrapper function that directly createElement's the inner component.
  // Iterate all functions and find one where createElement(INNER,) appears
  // before any nested function definition.
  const wrapperFuncPattern = /function ([$\w]+)\([^)]*\)\{/g;
  let wrapperExec: RegExpExecArray | null;
  let wrapperMatch: { index: number; length: number } | null = null;
  while ((wrapperExec = wrapperFuncPattern.exec(oldFile)) !== null) {
    const bodyStart = wrapperExec.index + wrapperExec[0].length;
    const body = oldFile.slice(bodyStart, bodyStart + 500);
    const elemIdx = body.indexOf(`createElement(${innerFuncName},`);
    if (elemIdx === -1) continue;
    const nextFuncIdx = body.indexOf('function ');
    if (nextFuncIdx !== -1 && nextFuncIdx < elemIdx) continue;
    wrapperMatch = { index: wrapperExec.index, length: wrapperExec[0].length };
    break;
  }

  if (wrapperMatch) {
    const absoluteIndex = wrapperMatch.index + wrapperMatch.length;
    indices.push(absoluteIndex);
  } else {
    // Fallback: target the inner function directly (old behavior)
    const absoluteIndex =
      lookbackStart + lastFunctionMatch.index + lastFunctionMatch[0].length;
    indices.push(absoluteIndex);
  }

  return indices;
};

export const writeHideStartupClawd = (oldFile: string): string | null => {
  const indices = findStartupClawdComponents(oldFile);

  if (indices.length === 0) {
    console.error('patch: hideStartupClawd: no Clawd components found');
    return null;
  }

  // Sort indices in REVERSE order so we can insert without affecting earlier positions
  const sortedIndices = [...indices].sort((a, b) => b - a);

  const insertCode = 'return null;';
  let newFile = oldFile;

  // Loop over indices in reverse order and insert `return null;` at each
  for (const index of sortedIndices) {
    newFile = newFile.slice(0, index) + insertCode + newFile.slice(index);
  }

  // Show diff for the first insertion (for debugging)
  if (sortedIndices.length > 0) {
    const lastIndex = sortedIndices[sortedIndices.length - 1]; // First in original order
    showDiff(oldFile, newFile, insertCode, lastIndex, lastIndex);
  }

  return newFile;
};
