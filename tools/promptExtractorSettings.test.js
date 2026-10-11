// Locks the settings-schema description class: capture ahead of the cache,
// and structural naming from the key path.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ex = require('./promptExtractor.js');

const settingsPrompt = (text, keyPath, extra = {}) => ({
  id: '',
  name: '',
  description: '',
  pieces: [text],
  identifiers: [],
  identifierMap: {},
  settings: { keyPath, part: 1, parts: 1, ...extra },
});

describe('shouldCapture with a settings description', () => {
  it('captures ahead of the classification cache and the prose gate', () => {
    expect(ex.shouldCapture('Short note', 'Short note', '', 500, {})).toBe(
      false
    );
    expect(
      ex.shouldCapture('Short note', 'Short note', '', 500, {
        settingsDescription: true,
      })
    ).toBe(true);
  });

  it('never captures a one-word description, whose body matches every use', () => {
    expect(
      ex.shouldCapture('Short', 'Short', '', 500, { settingsDescription: true })
    ).toBe(false);
  });

  it('still yields to the hard structural excludes', () => {
    expect(
      ex.shouldCapture('@internal Hidden', '@internal Hidden', '', 500, {
        settingsDescription: true,
      })
    ).toBe(false);
  });
});

describe('applySettingsDescriptionNames', () => {
  it('generates an id and name from the key path', () => {
    const [p] = ex.applySettingsDescriptionNames([
      settingsPrompt('Retention days', 'cleanupPeriodDays'),
    ]);
    expect(p.id).toBe('data-settings-cleanup-period-days-description');
    expect(p.name).toBe('Data: cleanupPeriodDays setting description');
    expect(p.description).toContain('also shown to users');
  });

  it('numbers the parts of a `+` chain', () => {
    const [p] = ex.applySettingsDescriptionNames([
      settingsPrompt('second half', 'modelPricing', { part: 2, parts: 3 }),
    ]);
    expect(p.id).toBe('data-settings-model-pricing-description-part-2');
    expect(p.name).toContain('(part 2 of 3)');
  });

  it('keeps an id the catalogue already carries', () => {
    const carried = settingsPrompt('Retention days', 'cleanupPeriodDays');
    carried.id = 'system-prompt-existing';
    const [p] = ex.applySettingsDescriptionNames([carried]);
    expect(p.id).toBe('system-prompt-existing');
  });

  it("adopts the reference catalogue's id for the same text", () => {
    const [p] = ex.applySettingsDescriptionNames(
      [settingsPrompt('Sync plugins', 'syncClaudeAiPlugins')],
      [
        {
          id: 'data-sync-claude-ai-plugins-setting',
          name: 'Data: sync plugins',
          description: 'd',
          pieces: ['Sync plugins'],
        },
      ]
    );
    expect(p.id).toBe('data-sync-claude-ai-plugins-setting');
    expect(p.name).toBe('Data: sync plugins');
  });

  it('gives one id to the same text at several key paths', () => {
    const out = ex.applySettingsDescriptionNames([
      settingsPrompt('Status message', 'hooks.hooks.(command).statusMessage'),
      settingsPrompt('Status message', 'hooks.hooks.(http).statusMessage'),
    ]);
    expect(new Set(out.map(p => p.id))).toEqual(
      new Set(['data-settings-hooks-hooks-status-message-description'])
    );
  });

  it('leaves prompts outside the class alone', () => {
    const plain = { ...settingsPrompt('x', 'k'), settings: undefined };
    const [p] = ex.applySettingsDescriptionNames([plain]);
    expect(p.id).toBe('');
  });
});
