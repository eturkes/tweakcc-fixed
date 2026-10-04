// Assign work items to packets so every packet carries roughly the same AMOUNT
// OF WORK, rather than the same NUMBER of items.
//
// Contiguous slicing by count is what this replaces. Measured on the CC 2.1.237
// packet sets, count was even to within 4% while the actual text ran 6.45x
// max/mean in one set (29,681 chars against 1,876) and 4.70x in another. A
// fan-out's wall clock is its slowest agent, so it ran at the speed of its
// unluckiest packet — 27.1 minutes against a 13.8 minute median on the stage-1
// run this came from.
//
// Greedy longest-processing-time: heaviest item first, into whichever bin is
// currently lightest. LPT is within 4/3 of optimal in the worst case and hits
// the exact lower bound on the real corpus. Ties break on the item key so
// reruns produce byte-identical packets.
//
// The floor is max(heaviest single item, total / binCount) and no assignment
// can beat it. On the 216-id set that means one 128,980-char skill takes a
// packet to itself while the other 14 land inside a 3.9% spread — which is the
// right answer, not a failure to balance.
export const packByWeight = (items, binCount, weightOf, keyOf = x => String(x)) => {
  const n = Math.max(1, Math.floor(binCount) || 1);
  const bins = Array.from({ length: n }, () => ({ items: [], weight: 0 }));
  const weights = new Map();
  const w = it => {
    const k = keyOf(it);
    if (!weights.has(k)) weights.set(k, Math.max(0, Number(weightOf(it)) || 0));
    return weights.get(k);
  };
  const ordered = [...items].sort(
    (a, b) => w(b) - w(a) || keyOf(a).localeCompare(keyOf(b))
  );
  for (const it of ordered) {
    let light = bins[0];
    for (const b of bins) if (b.weight < light.weight) light = b;
    light.items.push(it);
    light.weight += w(it);
  }
  return bins.filter(b => b.items.length);
};

// The best achievable max-bin weight, for reporting how close a packing got.
export const packingFloor = (items, binCount, weightOf) => {
  const ws = items.map(it => Math.max(0, Number(weightOf(it)) || 0));
  if (!ws.length) return 0;
  const total = ws.reduce((a, b) => a + b, 0);
  return Math.max(Math.max(...ws), total / Math.max(1, binCount));
};

// Cut an ORDERED list into at most `binCount` contiguous runs whose heaviest
// run is as light as possible. Unlike packByWeight it never reorders: callers
// rely on neighbours (one emitting function's strings, ids that share
// carriers) landing in the same run. Binary search on the run capacity with a
// greedy fill, which is exact for contiguous partitions. An item heavier than
// total / binCount gets a run of its own; the caller splits such an item
// beforehand when it must not.
export const partitionContiguous = (items, binCount, weightOf) => {
  const n = Math.max(1, Math.floor(binCount) || 1);
  const ws = items.map(it => Math.max(0, Number(weightOf(it)) || 0));
  if (!items.length) return [];
  const runsAt = cap => {
    const runs = [];
    let cur = [];
    let w = 0;
    items.forEach((it, i) => {
      if (cur.length && w + ws[i] > cap) {
        runs.push(cur);
        cur = [];
        w = 0;
      }
      cur.push(it);
      w += ws[i];
    });
    if (cur.length) runs.push(cur);
    return runs;
  };
  let lo = Math.max(...ws);
  let hi = ws.reduce((a, b) => a + b, 0);
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (runsAt(mid).length <= n) hi = mid;
    else lo = mid;
  }
  return runsAt(runsAt(lo).length <= n ? lo : hi);
};

// How many agents a stage needs for `count` items at `perAgent` items each.
export const agentsFor = (count, perAgent) =>
  Math.max(1, Math.ceil(count / Math.max(1, Math.floor(perAgent) || 1)));
