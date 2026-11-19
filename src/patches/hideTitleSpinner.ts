// Please see the note about writing patches in ./index

import { showDiff } from './index';

// Terminal-title component, busy → spinner frame (◐/◑), else static ✳:
//   let $e=E&&!Ce?y5[Pe]??S5:S5;return Bce(Se?null:V?ee:`${$e} ${ee}`)
// Groups: 1 prefix, 2 busy, 3 static glyph, 4 setTitle, 5 disabled,
// 6 noPrefix, 7 title.
const TITLE_PATTERN =
  /let ([$\w]+)=([$\w]+)&&![$\w]+\?[$\w]+\[[$\w]+\]\?\?([$\w]+):\3;return ([$\w]+)\(([$\w]+)\?null:([$\w]+)\?([$\w]+):`\$\{\1\} \$\{\7\}`\)/;

// CC ≥ 2.1.328: the busy flag sits in its own variable, and a host that takes
// no glyphs gets an ASCII pair (">" busy, "*" at rest):
//   let Et=N&&!Ue,_t=Ye?Et?JDt:ZDt:Et?jre[et]??qre:qre;
//   return wvt(oe?null:H?z:`${_t} ${z}`)
// Groups: 1 busy outside a multiplexer, 2 busy, 3 prefix, 4 ASCII host,
// 5 ASCII rest glyph, 6 static glyph, 7 setTitle, 8 disabled, 9 noPrefix,
// 10 title.
const TITLE_PATTERN_ASCII =
  /let ([$\w]+)=([$\w]+)&&![$\w]+,([$\w]+)=([$\w]+)\?\1\?[$\w]+:([$\w]+):\1\?[$\w]+\[[$\w]+\]\?\?([$\w]+):\6;return ([$\w]+)\(([$\w]+)\?null:([$\w]+)\?([$\w]+):`\$\{\3\} \$\{\10\}`\)/;

// Session status: idle with a background shell still running → "shell":
//   let yo=V(Rbo),$o=po==="idle"&&yo?"shell":po
// Groups: 1 presence status, 2 base status.
const SHELL_STATUS_PATTERN =
  /([$\w]+)=([$\w]+)==="idle"&&[$\w]+\?"shell":\2[,;]/;

// The title's busy flag, fed to the component as isAnimating:
//   const tr=po==="busy",Bn=En||Jn
const TITLE_BUSY_PATTERN = (status: string): RegExp =>
  new RegExp(
    `const ([$\\w]+)=${status.replace(/\$/g, '\\$')}==="busy",(?=[$\\w]+=[$\\w]+\\|\\|[$\\w]+;)`
  );

/**
 * Busy → bare title; idle/waiting → `✳ title`. The spinner interval keeps
 * ticking, but useTerminalTitle writes only when the string changes.
 *
 * Busy also covers an ended turn with a background shell still running:
 * its completion re-invokes the session, so it is not yet at rest.
 */
export const writeHideTitleSpinner = (oldFile: string): string | null => {
  const found = findTitle(oldFile);
  if (!found) {
    console.error(
      'patch: hideTitleSpinner: failed to find terminal-title spinner'
    );
    return null;
  }

  const { index, length, prefix, rest, setTitle, disabled, noPrefix } = found;
  const { busy, title } = found;
  const newCode =
    `let ${prefix}=${rest};return ${setTitle}(${disabled}?null:` +
    `${noPrefix}||${busy}?${title}:` +
    '`${' +
    prefix +
    '} ${' +
    title +
    '}`)';
  const endIndex = index + length;
  const newFile = oldFile.slice(0, index) + newCode + oldFile.slice(endIndex);

  showDiff(oldFile, newFile, newCode, index, endIndex);
  return writeTitleBusyOnShell(newFile);
};

interface TitleSite {
  index: number;
  length: number;
  prefix: string;
  busy: string;
  /** Expression for the prefix of a session at rest. */
  rest: string;
  setTitle: string;
  disabled: string;
  noPrefix: string;
  title: string;
}

const findTitle = (file: string): TitleSite | null => {
  const ascii = file.match(TITLE_PATTERN_ASCII);
  if (ascii && ascii.index !== undefined) {
    const [whole, , busy, prefix, asciiHost, asciiRest, glyph] = ascii;
    const [, , , , , , , setTitle, disabled, noPrefix, title] = ascii;
    return {
      index: ascii.index,
      length: whole.length,
      prefix,
      busy,
      rest: `${asciiHost}?${asciiRest}:${glyph}`,
      setTitle,
      disabled,
      noPrefix,
      title,
    };
  }

  const match = file.match(TITLE_PATTERN);
  if (!match || match.index === undefined) return null;
  const [whole, prefix, busy, glyph, setTitle, disabled, noPrefix, title] =
    match;
  return {
    index: match.index,
    length: whole.length,
    prefix,
    busy,
    rest: glyph,
    setTitle,
    disabled,
    noPrefix,
    title,
  };
};

const writeTitleBusyOnShell = (oldFile: string): string | null => {
  const statusMatch = oldFile.match(SHELL_STATUS_PATTERN);
  if (!statusMatch) {
    console.error(
      'patch: hideTitleSpinner: failed to find background-shell status'
    );
    return null;
  }
  const [, shellStatus, status] = statusMatch;

  const match = oldFile.match(TITLE_BUSY_PATTERN(status));
  if (!match || match.index === undefined) {
    console.error('patch: hideTitleSpinner: failed to find title busy flag');
    return null;
  }

  const [whole, flag] = match;
  const newCode = `const ${flag}=${status}==="busy"||${shellStatus}==="shell",`;
  const endIndex = match.index + whole.length;
  const newFile =
    oldFile.slice(0, match.index) + newCode + oldFile.slice(endIndex);

  showDiff(oldFile, newFile, newCode, match.index, endIndex);
  return newFile;
};
