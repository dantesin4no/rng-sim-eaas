// Isomorphic WebCrypto: browser `crypto.subtle` or Node's webcrypto.
let subtlePromise;
export async function getSubtle() {
  if (!subtlePromise) {
    subtlePromise = (async () => {
      if (globalThis.crypto?.subtle) return globalThis.crypto.subtle;
      const { webcrypto } = await import("node:crypto");
      return webcrypto.subtle;
    })();
  }
  return subtlePromise;
}
