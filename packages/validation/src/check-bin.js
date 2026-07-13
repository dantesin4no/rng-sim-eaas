/**
 * Quick statistical smoke test for exported .bin entropy files.
 * NOT a substitute for dieharder / NIST STS — a fast local gate only.
 *
 * Usage: node src/check-bin.js path/to/file.bin
 */
import { readFileSync } from "node:fs";

const path = process.argv[2];
if (!path) {
  console.error("usage: node src/check-bin.js <file.bin>");
  process.exit(2);
}
const data = readFileSync(path);
const nBits = data.length * 8;

// monobit
let ones = 0;
for (const byte of data) {
  let b = byte;
  while (b) { ones += b & 1; b >>= 1; }
}
const frac = ones / nBits;
// z-score for proportion of ones
const z = (2 * ones - nBits) / Math.sqrt(nBits);

// byte chi-square vs uniform
const counts = new Uint32Array(256);
for (const byte of data) counts[byte]++;
const exp = data.length / 256;
let chi2 = 0;
for (let i = 0; i < 256; i++) chi2 += ((counts[i] - exp) ** 2) / exp;
// df=255; mean 255, sd ~ sqrt(510) ~ 22.6. Flag beyond ~4 sd.
const chiOk = chi2 > 255 - 4 * 22.6 && chi2 < 255 + 4 * 22.6;

// Shannon entropy
let H = 0;
for (let i = 0; i < 256; i++) {
  if (counts[i]) {
    const p = counts[i] / data.length;
    H -= p * Math.log2(p);
  }
}

// serial correlation (lag-1, byte level)
let num = 0, sumX = 0, sumX2 = 0;
for (let i = 0; i < data.length - 1; i++) num += data[i] * data[i + 1];
for (const byte of data) { sumX += byte; sumX2 += byte * byte; }
const n = data.length;
const scc =
  (n * num - sumX * sumX + sumX * data[0] - sumX * data[n - 1]) /
  (n * sumX2 - sumX * sumX) || 0;

const results = [
  ["monobit |z|", Math.abs(z).toFixed(3), Math.abs(z) < 4],
  ["ones fraction", frac.toFixed(5), Math.abs(frac - 0.5) < 0.01],
  ["byte chi-square (df 255)", chi2.toFixed(1), chiOk],
  ["Shannon entropy (bits/byte)", H.toFixed(4), H > 7.9],
  ["serial correlation |scc|", Math.abs(scc).toFixed(5), Math.abs(scc) < 0.05],
];

let fail = false;
console.log(`\n${path} — ${data.length} bytes\n`);
for (const [name, val, ok] of results) {
  if (!ok) fail = true;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name.padEnd(30)} ${val}`);
}
console.log(
  fail
    ? "\nRESULT: FAIL — do not ship; investigate the pipeline stage that changed.\n"
    : "\nRESULT: PASS (smoke only — run dieharder for real assurance)\n"
);
process.exit(fail ? 1 : 0);
