import { describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { writeSwapRipgrepForFff } from './swapRipgrepForFff';

const WRAPPER = '/Users/x/.tweakcc/fff/aarch64-apple-darwin/rg-fff';
const WQ = "'" + WRAPPER + "'"; // "..."

// The grep/find shadow template as CC's snapshot-generator emits it (3× "$_cc_bin").
const SHADOW =
  'function grep {\n' +
  '  local _cc_bin="${CLAUDE_CODE_EXECPATH:-}"\n' +
  '  [[ -x $_cc_bin ]] || _cc_bin=/Users/x/.local/bin/claude\n' +
  '  if [[ ! -x $_cc_bin ]]; then command grep "$@"; return; fi\n' +
  '  if [[ -n "${ZSH_VERSION:-}" ]]; then\n' +
  '    ARGV0=${t} "$_cc_bin" ${o}\n' +
  '  elif [[ "$OSTYPE" == "msys" ]]; then\n' +
  '    ARGV0=${t} "$_cc_bin" ${o}\n' +
  '  else\n' +
  '    (exec -a ${t} "$_cc_bin" ${o})\n' +
  '  fi\n}';

const DESCRIPTOR =
  '{mode:"embedded",command:process.execPath,args:["--no-config"],argv0:"rg"}';
const RESOLVER = `if(Af()){let n=${DESCRIPTOR};return n}`;

const BT = '`';
const GREP_DESC = `;function gVr(e){if(xh(e))return${BT}Content search built on ripgrep. Bare identifiers.${BT};return${BT}A powerful search tool built on ripgrep. Full regex syntax.${BT}}`;

// Two Bash-description variants (concise + full), each ending the dedicated-tool
// bullet with the PRISTINE phrasing "Prefer dedicated tools over ${o} ..." (verified
// in the real cli.js backup) — the append target for the main agent. (The earlier
// fixture used "Prefer the dedicated tool.", which only exists in LCC overrides, so
// it gave false green while the public/default anchor matched nothing.)
const BASH_DESC =
  `;var bashHelp=[${BT}- Use Read to read files, not cat.${BT},` +
  `${BT}- Avoid search commands; prefer dedicated tools after verifying. Prefer dedicated tools over \${o} when one fits.${BT},` +
  `${BT}- \\\`timeout\\\` is in ms.${BT}];` +
  `var bashHelp2=[${BT}- Avoid cat/head/tail. Prefer dedicated tools over \${o} when one fits.${BT}];`;

// CC 2.1.215+ shape: the Grep description template carries a `${cond?`…`:""}`
// interpolation with a NESTED template. A naive "next unescaped backtick" scan
// stops on that nested template's OPENING backtick and splices into the ternary
// consequent, yielding `?  - Use …` → SyntaxError.
const GREP_DESC_NESTED =
  ';function gVr(e){return' +
  BT +
  'A powerful search tool built on ripgrep.\\n  - "count" shows match counts\\n' +
  '${vW()==="default"?' +
  BT +
  '  - Use ${qo} tool (if available) for open-ended searches\\n' +
  BT +
  ':""}  - Pattern syntax: rg-flavored\\n' +
  BT +
  '}';

const COMBINED = SHADOW + RESOLVER + GREP_DESC + BASH_DESC;

const countOf = (s: string, sub: string) => s.split(sub).length - 1;

describe('swapRipgrepForFff', () => {
  it('repoints all 3 bash-search shadow sites at the wrapper', () => {
    const out = writeSwapRipgrepForFff(COMBINED, WRAPPER);
    expect(out).not.toBeNull();
    expect(out).not.toContain('"$_cc_bin"');
    // wrapper appears 3× (shadow) + 1× (rg resolver) = 4
    expect(countOf(out!, WRAPPER)).toBeGreaterThanOrEqual(4);
    expect(out).toContain('ARGV0=${t} ' + WQ);
    expect(out).toContain('exec -a ${t} ' + WQ);
  });

  it('also repoints the rg resolver and appends fff guidance to both grep variants', () => {
    const out = writeSwapRipgrepForFff(COMBINED, WRAPPER)!;
    expect(out).toContain('--fff-claude-bin='); // rg resolver
    expect(out).not.toContain('mode:"embedded"');
    expect(countOf(out, 'Search backend note (fff):')).toBe(2); // concise + full
  });

  it('appends minimal ranking/--fuzzy guidance to both Bash description variants', () => {
    const out = writeSwapRipgrepForFff(COMBINED, WRAPPER)!;
    expect(countOf(out, 'most-relevant-first')).toBe(2); // both bash variants
    expect(out).toContain('grep --fuzzy SomeName');
    // inserted inside the bullet (after the pristine phrasing), before its closing
    // backtick (no raw backticks)
    expect(out).toContain(
      'when one fits. For Bash content searches, use the managed grep function'
    );
    // the structured Grep tool has no --fuzzy flag, so its desc must NOT mention it
    const grepNote = out.slice(out.indexOf('Search backend note (fff):'));
    expect(grepNote.slice(0, 120)).not.toContain('--fuzzy');
  });

  it('splices at the TRUE closing backtick past a nested ${…} template', () => {
    const out = writeSwapRipgrepForFff(SHADOW + GREP_DESC_NESTED, WRAPPER)!;
    const fn = out.slice(out.indexOf('function gVr'));
    expect(() => new Function(fn)).not.toThrow();
    expect(countOf(out, 'Search backend note (fff):')).toBe(1);
    // the note lands after the whole ternary, not inside its consequent
    expect(out.indexOf('Search backend note (fff):')).toBeGreaterThan(
      out.indexOf('Pattern syntax: rg-flavored')
    );
  });

  it('refuses to splice when the template never closes', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const file = SHADOW + ';var d=' + BT + 'unterminated, built on ripgrep';
      const out = writeSwapRipgrepForFff(file, WRAPPER)!;
      expect(out).not.toBeNull();
      expect(out).not.toContain('Search backend note (fff):');
      expect(out).toContain('unterminated, built on ripgrep');
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining('no balanced closing backtick')
      );
    } finally {
      errSpy.mockRestore();
    }
  });

  it('is idempotent (no-op when already applied)', () => {
    const once = writeSwapRipgrepForFff(COMBINED, WRAPPER)!;
    const twice = writeSwapRipgrepForFff(once, WRAPPER);
    expect(twice).toBe(once);
  });

  it('is idempotent with renamed native generator arguments', () => {
    const renamed = COMBINED.replaceAll('${t}', '${$tool}').replaceAll(
      '${o}',
      '${$arguments}'
    );
    const once = writeSwapRipgrepForFff(renamed, WRAPPER)!;
    expect(writeSwapRipgrepForFff(once, WRAPPER)).toBe(once);
  });

  it('executes literal wrapper paths through Bash and zsh shadow functions', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fff-shadow-path-'));
    try {
      const tricky = path.join(
        root,
        "José ' $HOME ${HOME} $(touch injected) `touch injected` \\"
      );
      await fs.mkdir(tricky);
      const wrapper = path.join(tricky, 'rg-fff');
      await fs.writeFile(wrapper, '#!/bin/sh\nprintf "%s\\n" "$@"\n', {
        mode: 0o700,
      });
      const generator =
        'function shadow($tool,$arguments){return`' +
        SHADOW.replaceAll('${t}', '${$tool}')
          .replaceAll('${o}', '${$arguments}')
          .replaceAll(
            '${CLAUDE_CODE_EXECPATH:-}',
            '\\${CLAUDE_CODE_EXECPATH:-}'
          )
          .replaceAll('${ZSH_VERSION:-}', '\\${ZSH_VERSION:-}') +
        '`;}';
      const patched = writeSwapRipgrepForFff(generator, wrapper)!;
      expect(patched).not.toBeNull();
      const shell = new Function(
        patched + ';return shadow("ugrep",\'"$@"\');'
      )() as string;
      for (const executable of ['/bin/bash', '/bin/zsh']) {
        const result = spawnSync(
          executable,
          ['-c', shell + '\ngrep "literal argument"'],
          {
            cwd: root,
            env: { ...process.env, CLAUDE_CODE_EXECPATH: '/bin/sh' },
            encoding: 'utf8',
          }
        );
        if (!result.error) {
          expect(result.status, result.stderr).toBe(0);
          expect(result.stdout).toBe('literal argument\n');
          expect(result.stderr).toBe('');
        }
      }
      await expect(fs.stat(path.join(root, 'injected'))).rejects.toThrow();
      expect(writeSwapRipgrepForFff(patched, wrapper)).toBe(patched);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('warms the runtime working directory when shell setup is sourced', () => {
    const generator =
      ';function snippets(){return["unalias find 2>/dev/null || true","unalias grep 2>/dev/null || true",shadow()]}';
    const once = writeSwapRipgrepForFff(COMBINED + generator, WRAPPER)!;
    expect(once).toContain(' --warmup \\"$PWD\\"');
    expect(countOf(once, ' --warmup ')).toBe(1);
    expect(writeSwapRipgrepForFff(once, WRAPPER)).toBe(once);
  });

  it('defines a shell-safe fff command and advertises it only when available', () => {
    const generator =
      ';function snippets(){return["unalias find 2>/dev/null || true","unalias grep 2>/dev/null || true",shadow()]}';
    const tricky = "/tmp/José/'`x${HOME}/rg-fff";
    const patched = writeSwapRipgrepForFff(COMBINED + generator, tricky)!;
    const commands = new Function(
      'shadow',
      patched.slice(patched.indexOf('function snippets')) +
        ';return snippets();'
    )(() => '') as string[];
    expect(commands).toContain(
      "function fff { '/tmp/José/'\\''`x${HOME}/rg-fff' \"$@\"; }"
    );
    expect(spawnSync('bash', ['-n', '-c', commands.join('\n')]).status).toBe(0);
    expect(patched).toContain('Use fff files SomeName');
    expect(writeSwapRipgrepForFff(COMBINED, WRAPPER)).not.toContain(
      'Use fff files SomeName'
    );
  });

  it('includes guidance in lean and full descriptions even when custom bullets are hidden', async () => {
    const generator =
      ';function snippets(){return["unalias find 2>/dev/null || true","unalias grep 2>/dev/null || true",shadow()]}';
    const custom =
      ';async function lean(hide){let notes=[];if(!hide)notes.push("Prefer the dedicated tool.");return["Executes a bash command and returns its output.",...notes].join("\\n")}' +
      ';async function full(hide){let notes=[];if(!hide)notes.push("Custom search instructions.");return["Executes a given bash command and returns its output.",...notes].join("\\n")}';
    const patched = writeSwapRipgrepForFff(
      SHADOW + generator + custom,
      WRAPPER
    )!;
    const descriptions = new Function(
      patched.slice(patched.indexOf('async function lean')) +
        ';return{lean,full}'
    )() as {
      lean: (hide: boolean) => Promise<string>;
      full: (hide: boolean) => Promise<string>;
    };
    for (const make of [descriptions.lean, descriptions.full]) {
      for (const hide of [true, false]) {
        const description = await make(hide);
        expect(description).toContain('FFF Bash search:');
        expect(description).toContain('most-relevant-first');
        expect(description).toContain('Use fff files SomeName');
        expect(description.split('FFF Bash search:')).toHaveLength(2);
      }
    }
    expect(countOf(patched, 'FFF Bash search:')).toBe(2);
    expect(writeSwapRipgrepForFff(patched, WRAPPER)).toBe(patched);
  });

  it('succeeds on a shadow-only file (rg/guidance are best-effort)', () => {
    const out = writeSwapRipgrepForFff(SHADOW, WRAPPER);
    expect(out).not.toBeNull();
    expect(out).not.toContain('"$_cc_bin"');
    // 3 repointed invocations (2 ARGV0 + 1 exec-a) + 1 in the -x guard = 4
    expect(countOf(out!, WRAPPER)).toBe(4);
    expect(out).toContain('|| ! -x ' + WQ); // wrapper-executable guard
  });

  it('returns null (critical) when the shadow anchor is absent', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // RESOLVER alone has no "$_cc_bin" shadow token.
      expect(writeSwapRipgrepForFff(RESOLVER, WRAPPER)).toBeNull();
      expect(errSpy).toHaveBeenCalledWith(
        'patch: swapRipgrepForFff: bash-search shadow anchor "$_cc_bin" not found'
      );
    } finally {
      errSpy.mockRestore();
    }
  });

  it('injects shell-valid wrapper paths (quoted)', () => {
    const out = writeSwapRipgrepForFff(SHADOW, WRAPPER)!;
    // each repointed invocation is ARGV0=${t} "<path>" ${o} or exec -a ${t} "<path>" ${o}
    expect(out).toContain('ARGV0=${t} ' + WQ + ' ${o}');
    expect(out).toContain('(exec -a ${t} ' + WQ + ' ${o})');
  });

  it('escapes non-ASCII / backtick / ${} in the wrapper path for the backtick shadow', () => {
    // A path with a non-ASCII char, a backtick, and a ${} — all hazards in the
    // backtick-template shadow (Bun Latin-1 mojibake / template-termination /
    // interpolation → the "function wrapper" boot crash).
    const tricky = '/Users/José/`x${HOME}/rg-fff';
    const out = writeSwapRipgrepForFff(SHADOW, tricky)!;
    expect(out).not.toBeNull();
    expect(out).not.toContain('José'); // no RAW non-ASCII byte in cli.js
    expect(out).toContain('Jos\\u00e9'); // escaped to \uXXXX
    expect(out).toContain('\\`'); // backtick escaped, can't terminate the template
    expect(out).toContain('\\${HOME}'); // ${ escaped, no live interpolation
    // the guard now also gates on the wrapper being executable
    expect(out).toContain('|| ! -x ');
  });
});
