import { describe, it, expect } from 'vitest';
import { writeThemes } from './themes';
import { Theme } from '../types';

const theme: Theme = {
  name: 'Neon',
  id: 'neon',
  colors: { autoAccept: '#0f0', text: '#fff' } as unknown as Theme['colors'],
};

// Minimal cli.js shape carrying the three theme locations the patch rewrites:
// the color switch, the options array, and the name-mapping object (`hM3={...}`).
const cli =
  // The id registry sits at a LOWER offset than the other three in the real
  // bundle, which is why the writer has to splice it last.
  'Kls=["dark","light","light-daltonized","dark-daltonized","light-ansi","dark-ansi"],' +
  'Rin=["auto",...Kls];' +
  'function x1o(e){return typeof e==="string"&&Kls.includes(e)}' +
  'switch(Z){case"light":return AA;case"dark":return BB;default:return CC};' +
  'X=[{label:"Dark mode",value:"dark"},{label:"Light mode",value:"light"}];' +
  'hM3={auto:"Auto (match terminal)",dark:"Dark mode"};' +
  'render=()=>hM3[sel.value.toString()]??sel.value.toString()';

describe('themes patch', () => {
  it('preserves the name-map assignment prefix (hM3=) instead of rewriting it to return{...}', () => {
    // Regression guard: a non-capturing prefix group made objMatch[1] undefined,
    // objPrefix defaulted to `return`, and `hM3={...}` became `return{...}` —
    // leaving hM3 undefined so `/config` crashed with
    // "undefined is not an object (evaluating 'hM3[...]')".
    const out = writeThemes(cli, [theme]);
    expect(out).not.toBeNull();
    expect(out).toMatch(/hM3=\{/); // binding preserved
    expect(out).not.toMatch(/[;}]return\{"neon"/); // not rewritten to an orphan return{...}
    expect(out).toContain('"neon":"Neon"'); // user theme injected into the map
  });

  it('registers custom ids in the theme-id whitelist, keeping the built-ins', () => {
    // Patching the colour switch, option array and name map but NOT the id
    // whitelist leaves the theme rendering through the switch while every
    // caller that validates the id first (`x1o`) rejects it — a split palette
    // instead of a clean failure. The built-ins must survive: CC resolves
    // auto/daltonized/ansi through this same array, and `Rin` is built from it.
    const out = writeThemes(cli, [theme]);
    expect(out).not.toBeNull();
    const registry = out!.match(/Kls=(\[[^\]]*\])/)?.[1];
    expect(registry).toBeDefined();
    const ids = JSON.parse(registry!);
    expect(ids).toContain('neon');
    expect(ids).toEqual(
      expect.arrayContaining([
        'dark',
        'light',
        'light-daltonized',
        'dark-daltonized',
        'light-ansi',
        'dark-ansi',
      ])
    );
    // The `Rin=["auto",...Kls]` superset must still reference the same binding.
    expect(out).toContain('Rin=["auto",...Kls]');
  });

  it('leaves the whitelist alone when no theme adds a new id', () => {
    const builtinOnly: Theme = { ...theme, id: 'dark', name: 'Dark mode' };
    const out = writeThemes(cli, [builtinOnly]);
    expect(out).not.toBeNull();
    expect(out).toContain(
      'Kls=["dark","light","light-daltonized","dark-daltonized","light-ansi","dark-ansi"]'
    );
  });

  it('spreads the pristine theme under each user theme so keys a newer CC adds are never undefined', () => {
    // CC 2.1.285 added `effortUltra`; a user theme written before it crashed
    // the startup logo with "undefined is not an object (evaluating 'e.match')".
    const light: Theme = { ...theme, id: 'light', name: 'Light mode' };
    const lightCustom: Theme = { ...theme, id: 'my-light', name: 'Mine' };
    const out = writeThemes(cli, [theme, light, lightCustom]);
    expect(out).not.toBeNull();
    expect(out).toContain('case"neon":return{...CC,...{');
    expect(out).toContain('case"light":return{...AA,...{');
    expect(out).toContain('case"my-light":return{...AA,...{');
    expect(out).toContain('default:return{...CC,...{');
  });
});
