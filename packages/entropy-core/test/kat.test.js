import { test } from "node:test";
import assert from "node:assert/strict";
import { HmacDrbg } from "../src/index.js";

/**
 * HMAC-DRBG known-answer tests.
 *
 * Vectors fetched from https://github.com/isaracorp/test-vectors (ISARA
 * Corporation), generated with the same algorithm and procedure as the NIST
 * CAVP vectors (drbgvectors_pr_false), which only publish SHA-256:
 *
 *   1. Instantiate with the given seed material.
 *   2. Reseed with the given reseed material.
 *   3. Generate expected-length output; discard.
 *   4. Generate again; compare against expected.
 *
 * Passing these exactly verifies the instantiate/reseed/generate/update
 * sequencing of the implementation. The SHA-256 default then differs only
 * by the platform-tested WebCrypto hash primitive. Importing the official
 * NIST SHA-256 .rsp (drbgvectors_pr_false/HMAC_DRBG.rsp) remains a
 * plans/004 CI task — the file is too large to inline here.
 */

const hex = (s) => new Uint8Array(s.match(/../g).map((b) => parseInt(b, 16)));
const toHex = (u) => Array.from(u).map((b) => b.toString(16).padStart(2, "0")).join("");

const VECTORS = [
  {
    hash: "SHA-384",
    seed: "06032cd5eed33f39265f49ecb142c511da9aff2af71203bffaf34a9ca5bd9c0d0e66f71edc43e42a45ad3c6fc6cdc4df",
    reseed: "01920a4e669ed3a85ae8a33b35a74ad7fb2a6bb4cf395ce00334a9c9a5a5d552",
    expected:
      "59c398879ff106a1e5e0581023bea803efea44ca263b61473d5af515ad1e487734c48f8e1f71029468c897b496e0e64304397cc99e5875379a87119050fcc9a198fa3e24e4e5c8708a9a8d28fb0249b8c98cf9e10009bfa1dbfa99f03844be464af61f626cf08211633d2b2f15855ff3ab5473c01039363bc8817dc3c7907b3c",
  },
  {
    hash: "SHA-384",
    seed: "aadcf337788bb8ac01976640726bc51635d417777fe6939eded9ccc8a378c76a9ccc9d80c89ac55a8cfe0f99942f5a4d",
    reseed: "03a57792547e0c98ea1776e4ba80c007346296a56a270a35fd9ea2845c7e81e2",
    expected:
      "b741b677f17a9190627a3a5806fa22101a9e726d32c66eb7e2a16cde0d91958fd185c4927b9c6738bf1d3d1a2e5c66552cad5e1f99c0c2c0902ace1c02c5b1cda295fe5789fc575d59cf84355b40c785a211b254ee28dbe8527b0ff56517a0c8fc5fd7dea6e7d7a5c107b6d3ada5b333f7e8450053f803c6155972f7f3728726",
  },
  {
    hash: "SHA-512",
    seed: "06032cd5eed33f39265f49ecb142c511da9aff2af71203bffaf34a9ca5bd9c0d0e66f71edc43e42a45ad3c6fc6cdc4df",
    reseed: "01920a4e669ed3a85ae8a33b35a74ad7fb2a6bb4cf395ce00334a9c9a5a5d552",
    expected:
      "20544ca66237ad68aebc4b95ec42a2c5add64799491ace85b5729f9a3a0812560a24c272819a4cc91e25cab0cbcc5179e93a63675be3cf5bea9020eb5006530ae328ba7216bfed1b8934924618e3a8a5b7022fe7e128bb39477c7d5b7647d5d048adb4a48d7ab36a6dcffefaafca120476ab2ac739a30abe68909f5728b25f38",
  },
  {
    hash: "SHA-512",
    seed: "aadcf337788bb8ac01976640726bc51635d417777fe6939eded9ccc8a378c76a9ccc9d80c89ac55a8cfe0f99942f5a4d",
    reseed: "03a57792547e0c98ea1776e4ba80c007346296a56a270a35fd9ea2845c7e81e2",
    expected:
      "aca11c700445ab0bbb1fdacea0b6b13d16293659d90f79f236db8ea1c6450255c358491cbbf80014987cde024887f0f6eb155c125cb7a41311f049290220e4572379602671ba75777798e88014d34c3f0fd1d009eadd2ec4044f83765d7a75a1973bde7bae725a1a0865974e62a570e151e907f25e6d19dc2d65874089f17b2f",
  },
];

for (const [i, v] of VECTORS.entries()) {
  test(`KAT ${i + 1}: HMAC-DRBG ${v.hash} instantiate/reseed/generate matches published vector`, async () => {
    const d = new HmacDrbg({ hash: v.hash });
    await d.instantiate(hex(v.seed));
    await d.reseed(hex(v.reseed));
    const n = v.expected.length / 2;
    await d.generate(n); // first generate: discard, per CAVP procedure
    const out = await d.generate(n);
    assert.equal(toHex(out), v.expected);
  });
}
