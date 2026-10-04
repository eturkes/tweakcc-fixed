// A curated cut can join two sentences that were adjacent in an older release,
// so the windows spanning the join read as a re-injection even though both
// halves are live in current pristine. `curTok` is the current pristine token
// stream joined by single spaces.
export const MIN_HALF = 3;

export const isAdjacencyRun = (runText, curTok) => {
  const tk = runText.split(' ').filter(Boolean);
  const hay = ` ${curTok} `;
  const live = part => hay.includes(` ${part.join(' ')} `);
  for (let k = MIN_HALF; k + MIN_HALF <= tk.length; k++) {
    if (live(tk.slice(0, k)) && live(tk.slice(k))) return true;
  }
  return false;
};
