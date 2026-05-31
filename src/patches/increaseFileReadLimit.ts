// Please see the note about writing patches in ./index

import { LocationResult, showDiff } from './index';

/**
 * Find the file read token limit (25000) that's associated with file reading.
 *
 * Approach: Find "=25000," and verify a known anchor appears nearby to ensure
 * we're targeting the correct value. Supports multiple anchors across CC
 * versions (tried in order, first hit wins):
 * - "MaxFileReadTokenExceededError" / "exceeds maximum allowed tokens"
 *   (CC >=2.1.83; the read-limit default `_m5=25000` feeds this error class)
 * - "tengu_amber_wren" (CC >=2.1.83; slightly farther feature-flag anchor)
 * - "<system-reminder>" (CC <2.1.83; legacy fallback)
 *
 * The window is 500 chars because in CC 2.1.158 the value sits ~150-430 chars
 * before these anchors — the `MaxFileReadTokenExceededError` class body and its
 * "File content (...) exceeds maximum allowed tokens" message now live between
 * the constant and the feature-flag gate, pushing the old 200-char window past
 * every anchor. All four anchors are unique to the file-read site, so the wider
 * window can't cross-match the three unrelated `=25000,` constants elsewhere in
 * cli.js (the nearest is ~2 MB away).
 */
const getFileReadLimitLocation = (oldFile: string): LocationResult | null => {
  // Try anchors in order of preference (most specific / closest first).
  const anchors = [
    'MaxFileReadTokenExceededError',
    'exceeds maximum allowed tokens',
    'tengu_amber_wren',
    '<system-reminder>',
  ];

  let match: RegExpMatchArray | null = null;
  for (const anchor of anchors) {
    const escaped = anchor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`=25000,([\\s\\S]{0,500})${escaped}`);
    match = oldFile.match(pattern);
    if (match && match.index !== undefined) break;
  }

  if (!match || match.index === undefined) {
    console.error(
      'patch: increaseFileReadLimit: failed to find 25000 token limit near known anchor'
    );
    return null;
  }

  // The "25000" starts at match.index + 1 (after the "=")
  const startIndex = match.index + 1;
  const endIndex = startIndex + 5; // "25000" is 5 characters

  return {
    startIndex,
    endIndex,
  };
};

export const writeIncreaseFileReadLimit = (oldFile: string): string | null => {
  const location = getFileReadLimitLocation(oldFile);
  if (!location) {
    return null;
  }

  const newValue = '1000000';
  const newFile =
    oldFile.slice(0, location.startIndex) +
    newValue +
    oldFile.slice(location.endIndex);

  showDiff(oldFile, newFile, newValue, location.startIndex, location.endIndex);
  return newFile;
};
