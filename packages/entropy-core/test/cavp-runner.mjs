/**
 * NIST CAVP .rsp runner for HMAC_DRBG.
 *
 * Usage: node test/cavp-runner.mjs path/to/HMAC_DRBG.rsp [SHA-256]
 *
 * Parses the official CAVP response format (drbgvectors_pr_false /
 * drbgvectors_no_reseed) and runs every COUNT of the selected hash through
 * the implementation:
 *
 *   instantiate( EntropyInput || Nonce || PersonalizationString )
 *   [ reseed( EntropyInputReseed || AdditionalInputReseed ) ]   if present
 *   generate( len, AdditionalInput#1 )                          discard
 *   generate( len, AdditionalInput#2 )                          compare
 *
 * Exits non-zero on any mismatch. Intended for CI (nightly-battery.yml),
 * where the official NIST file is downloaded at run time.
 */
import { readFileSync } from "node:fs";
import { HmacDrbg, concatBytes } from "../src/index.js";

const file = process.argv[2];
const wantHash = process.argv[3] || "SHA-256";
if (!file) {
  console.error("usage: node test/cavp-runner.mjs <HMAC_DRBG.rsp> [SHA-256]");
  process.exit(2);
}

const hex = (s) => new Uint8Array((s.match(/../g) || []).map((b) => parseInt(b, 16)));
const toHex = (u) => Array.from(u).map((b) => b.toString(16).padStart(2, "0")).join("");

// --- parse ---
const lines = readFileSync(file, "utf8").split(/\r?\n/);
let section = null; // current [SHA-xxx]
let cur = null;
const cases = [];

for (const raw of lines) {
  const line = raw.trim();
  if (!line || line.startsWith("#")) continue;
  const secMatch = line.match(/^\[(SHA-[0-9/]+)\]$/);
  if (secMatch) { section = secMatch[1]; continue; }
  if (line.startsWith("[")) continue; // [PredictionResistance = ...] etc.
  const kv = line.match(/^(\w+)\s*=\s*(.*)$/);
  if (!kv) continue;
  const [, key, valRaw] = kv;
  const val = valRaw.trim();
  if (key === "COUNT") {
    if (cur) cases.push(cur);
    cur = { hash: section, additional: [], count: val };
    continue;
  }
  if (!cur) continue;
  if (key === "EntropyInput") cur.entropy = val;
  else if (key === "Nonce") cur.nonce = val;
  else if (key === "PersonalizationString") cur.pers = val;
  else if (key === "EntropyInputReseed") cur.reseedEntropy = val;
  else if (key === "AdditionalInputReseed") cur.reseedAdditional = val;
  else if (key === "AdditionalInput") cur.additional.push(val);
  else if (key === "ReturnedBits") cur.returned = val;
}
if (cur) cases.push(cur);

const selected = cases.filter((c) => c.hash === wantHash && c.returned);
if (selected.length === 0) {
  console.error(`no ${wantHash} cases found in ${file}`);
  process.exit(2);
}

// --- run ---
let pass = 0, fail = 0;
for (const c of selected) {
  const d = new HmacDrbg({ hash: wantHash });
  const seed = concatBytes([hex(c.entropy || ""), hex(c.nonce || ""), hex(c.pers || "")]);
  await d.instantiate(seed);
  if (c.reseedEntropy !== undefined) {
    await d.reseed(concatBytes([hex(c.reseedEntropy), hex(c.reseedAdditional || "")]));
  }
  const n = c.returned.length / 2;
  await d.generate(n, hex(c.additional[0] || ""));
  const out = await d.generate(n, hex(c.additional[1] || ""));
  if (toHex(out) === c.returned.toLowerCase()) pass++;
  else {
    fail++;
    console.error(`FAIL ${wantHash} COUNT=${c.count}`);
    if (fail <= 3) {
      console.error(`  expected ${c.returned.slice(0, 64)}…`);
      console.error(`  got      ${toHex(out).slice(0, 64)}…`);
    }
  }
}
console.log(`CAVP ${wantHash}: ${pass} pass, ${fail} fail (${selected.length} cases)`);
process.exit(fail ? 1 : 0);
