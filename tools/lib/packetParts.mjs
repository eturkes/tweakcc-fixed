// Markdown packets larger than one Read call.
//
// Claude Code's Read tool caps a file at 25,000 tokens of content (FileRead
// maxTokens: `P4r=25000` in the CC 2.1.288 bundle), counted with the API token
// counter for the session's model. CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS
// overrides it per session; here it can only LOWER the cap, because the shell
// that builds the packets need not be the session whose agents read them (a
// session launched with a raised cap builds parts another session cannot
// read). Over the cap a whole-file Read fails or, in
// 2.1.288, returns only a first page. A packet bigger than that is therefore
// written as part files, each safely under the cap, and an agent reads every
// part in ONE message of parallel Read calls: the size of a packet no longer
// decides how many items an agent gets.
//
// The byte cap per part is derived, not chosen:
//   READ_CAP_TOKENS × BYTES_PER_TOKEN_FLOOR × HEADROOM = 25,000 × 1.65 × 0.9.
// BYTES_PER_TOKEN_FLOOR is measured on the CC 2.1.288 replay transcripts: 215
// whole-packet Reads (classify chunks and verify packets, stage-1 audit
// packets, cut-hunt packets; Sonnet 5.5 and Opus 5.5) gave file bytes per
// input token of min 1.657, median 2.06, from the cache-token delta between
// the Read turn and the next one. That delta also counts the Read tool's
// line-number prefixes, which the cap does not, so the floor overstates what a
// part costs against the cap. HEADROOM covers a part denser than any measured.
//
// Parts split at markdown headings (levels 1-3) outside fenced blocks, so an
// id's section is never cut. A single section larger than a part is split at
// line boundaries; a fence open at the cut is closed and reopened, and the
// continuation is marked.
import fs from 'node:fs';
import path from 'node:path';

export const READ_CAP_TOKENS = 25000;
export const BYTES_PER_TOKEN_FLOOR = 1.65;
export const HEADROOM = 0.9;

export const readCapTokens = (env = process.env) => {
  const v = Number(env.CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS);
  return Number.isFinite(v) && v > 0 ? Math.min(READ_CAP_TOKENS, Math.floor(v)) : READ_CAP_TOKENS;
};

export const partByteCap = ({ tokens = readCapTokens() } = {}) =>
  Math.floor(tokens * BYTES_PER_TOKEN_FLOOR * HEADROOM);

const bytes = s => Buffer.byteLength(s);
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^#{1,3} /;

// Lines of `md` grouped into sections: a section starts at a heading of level
// 1-3 that is not inside a fenced block.
function sections(md) {
  const out = [];
  let cur = [];
  let open = null;
  for (const line of md.split('\n')) {
    if (!open && HEADING.test(line) && cur.length) {
      out.push(cur);
      cur = [];
    }
    open = fenceAfter(open, line);
    cur.push(line);
  }
  if (cur.length) out.push(cur);
  return out;
}

// The fence open after `line`, given the one open before it (null = none).
function fenceAfter(open, line) {
  const f = FENCE.exec(line);
  if (!f) return open;
  if (!open) return { marker: f[1], opener: line };
  const closes = f[1][0] === open.marker[0] && f[1].length >= open.marker.length && !line.slice(f[0].length).trim();
  return closes ? null : open;
}

const CONTINUED = '(continued from the previous part)';

// Split one oversized section into pieces of at most maxBytes, at line
// boundaries; a fence open at a cut is closed there and reopened after the
// continuation marker. A line longer than a piece (never seen in a real
// packet: rendered lines are wrapped at 1,600 characters) is cut by
// characters.
function splitSection(lines, maxBytes) {
  const room = Math.max(256, maxBytes - 400);
  const flat = [];
  for (let l of lines) {
    while (bytes(l) > room) {
      let n = l.length;
      while (n > 1 && bytes(l.slice(0, n)) > room) n = Math.floor(n * 0.9);
      flat.push(l.slice(0, n));
      l = l.slice(n);
    }
    flat.push(l);
  }
  const pieces = [];
  let cur = [];
  let size = 0;
  let open = null;
  for (const l of flat) {
    if (cur.length && size + bytes(l) + 1 > room) {
      pieces.push(open ? [...cur, open.marker].join('\n') : cur.join('\n'));
      cur = open ? [CONTINUED, open.opener] : [CONTINUED];
      size = bytes(cur.join('\n')) + 1;
    }
    cur.push(l);
    size += bytes(l) + 1;
    open = fenceAfter(open, l);
  }
  if (cur.length) pieces.push(cur.join('\n'));
  return pieces;
}

// Split `md` into parts of at most maxBytes each (UTF-8). Returns [md] when it
// already fits. Joining the parts with '\n' gives back `md` whenever no single
// section had to be split.
export function splitMarkdown(md, maxBytes = partByteCap()) {
  if (bytes(md) <= maxBytes) return [md];
  const parts = [];
  let cur = [];
  let size = 0;
  const flush = () => {
    if (cur.length) parts.push(cur.join('\n'));
    cur = [];
    size = 0;
  };
  for (const sec of sections(md)) {
    const text = sec.join('\n');
    const b = bytes(text) + 1;
    if (b > maxBytes) {
      flush();
      parts.push(...splitSection(sec, maxBytes));
      continue;
    }
    if (cur.length && size + b > maxBytes) flush();
    cur.push(text);
    size += b;
  }
  flush();
  return parts;
}

// Where the parts of `mdPath` live: the file itself when there is one part,
// else <base>.part1.md … <base>.partN.md beside it. Every workflow derives the
// same names from the part count it is handed.
export const partPaths = (mdPath, count) =>
  count > 1 ? Array.from({ length: count }, (_, i) => mdPath.replace(/\.md$/, `.part${i + 1}.md`)) : [mdPath];

export const PART_FILE = /\.part\d+\.md$/;

// Constant size whatever the part count: it names the first and last part.
const partHeader = (i, paths) =>
  `<!-- part ${i + 1} of ${paths.length} of ${path.basename(paths[0]).replace(/\.part1\.md$/, '.md')}; every part is required, read them all: ${paths[0]} … ${paths[paths.length - 1]} -->`;

// Write the whole packet to mdPath (the record tools and people read) and,
// when it is larger than one Read, its parts beside it, each opening with a
// comment line that names every part. Stale part files of this packet are
// removed first. Returns the paths an agent reads.
export function writeMarkdownParts(mdPath, md, { maxBytes = partByteCap() } = {}) {
  const dir = path.dirname(mdPath);
  const base = path.basename(mdPath).replace(/\.md$/, '');
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir)) {
      if (f.startsWith(`${base}.part`) && PART_FILE.test(f) && /^\d+$/.test(f.slice(base.length + 5, -3))) fs.unlinkSync(path.join(dir, f));
    }
  }
  fs.writeFileSync(mdPath, md);
  if (bytes(md) <= maxBytes) return [mdPath];
  // Room for the header; its digits can grow with the count, so reserve for
  // a four-digit part count.
  const reserve = bytes(partHeader(0, partPaths(mdPath, 1000))) + 1;
  if (maxBytes - reserve < 1024) throw new Error(`writeMarkdownParts: a ${maxBytes}-byte part cannot hold the ${reserve}-byte part header and content`);
  const parts = splitMarkdown(md, maxBytes - reserve);
  const paths = partPaths(mdPath, parts.length);
  parts.forEach((p, i) => fs.writeFileSync(paths[i], `${partHeader(i, paths)}\n${p}${p.endsWith('\n') ? '' : '\n'}`));
  return paths;
}

// The read instruction for a packet's parts, shared by the builders' headers.
export const readPartsSentence = paths =>
  paths.length === 1
    ? `Read ${paths[0]} in full`
    : `Read all ${paths.length} parts of the packet in full (${paths.join(', ')}), every Read call in ONE message`;
