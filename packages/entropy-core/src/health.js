/**
 * SP 800-90B continuous health tests, run on every raw sample.
 *
 * Cutoffs default to alpha ~ 2^-30 assuming >= 4 bits/sample min-entropy.
 * If you change the noise source or the entropy estimate, RE-DERIVE the
 * cutoffs — do not tweak them by feel. See .claude/skills/entropy-validation.
 */
export class HealthMonitor {
  constructor({ rctCutoff = 12, aptWindow = 512, aptCutoff = 84 } = {}) {
    this.rctCutoff = rctCutoff;
    this.aptWindow = aptWindow;
    this.aptCutoff = aptCutoff;
    this.reset();
  }

  reset() {
    this.failure = null; // null | "RCT" | "APT"
    this._rctLast = -1;
    this._rctRun = 0;
    this._aptFirst = -1;
    this._aptCount = 0;
    this._aptIdx = 0;
  }

  get healthy() {
    return this.failure === null;
  }

  /** Feed one raw sample (0-255). Returns current health. Failure latches. */
  check(b) {
    // Repetition Count Test — catches a stuck source.
    if (b === this._rctLast) {
      this._rctRun++;
      if (this._rctRun >= this.rctCutoff) this.failure = this.failure || "RCT";
    } else {
      this._rctLast = b;
      this._rctRun = 1;
    }
    // Adaptive Proportion Test — catches bias drift.
    if (this._aptIdx === 0) {
      this._aptFirst = b;
      this._aptCount = 1;
      this._aptIdx = 1;
    } else {
      if (b === this._aptFirst) {
        this._aptCount++;
        if (this._aptCount >= this.aptCutoff) this.failure = this.failure || "APT";
      }
      this._aptIdx++;
      if (this._aptIdx >= this.aptWindow) this._aptIdx = 0;
    }
    return this.healthy;
  }
}

/** Min-entropy per SP 800-90B most-common-value estimator (upper-bounded p). */
export function minEntropyMCV(counts, total) {
  if (total < 256) return 0;
  let maxC = 0;
  for (let i = 0; i < counts.length; i++) if (counts[i] > maxC) maxC = counts[i];
  const p = maxC / total;
  const pUb = Math.min(1, p + 2.576 * Math.sqrt((p * (1 - p)) / total));
  return -Math.log2(pUb);
}
