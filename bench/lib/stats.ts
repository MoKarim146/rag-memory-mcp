// Uncertainty for benchmark tables: seeded bootstrap confidence intervals, so the same records always give the
// same interval. 2,000 resamples of the queries, percentile method.

function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const quantile = (sorted: number[], q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)))];

// 95% interval of the mean of values.
export function bootstrapMean(values: number[], resamples = 2000, seed = 1): [number, number] | null {
  if (values.length < 2) return null;
  const next = random(seed);
  const means: number[] = [];
  for (let i = 0; i < resamples; i++) {
    let sum = 0;
    for (let j = 0; j < values.length; j++) sum += values[Math.floor(next() * values.length)];
    means.push(sum / values.length);
  }
  means.sort((a, b) => a - b);
  return [quantile(means, 0.025), quantile(means, 0.975)];
}

// 95% interval of the mean difference a - b over paired values (the same queries).
export function bootstrapPairedDifference(a: number[], b: number[], resamples = 2000, seed = 1): { mean: number; interval: [number, number] | null } {
  const diffs = a.map((x, i) => x - b[i]);
  return { mean: diffs.reduce((s, x) => s + x, 0) / Math.max(1, diffs.length), interval: bootstrapMean(diffs, resamples, seed) };
}
