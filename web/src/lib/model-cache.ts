/**
 * Model artifact cache, in the Cache API.
 *
 * It used to be IndexedDB. Chrome caps a single IndexedDB value at 127 MB, the base-plus
 * encoder weights are 153 MB, and an over-size put aborts the transaction without firing
 * `error`, so the write never settled and the first detection hung forever after its
 * download. The Cache API stores Responses with no per-entry cap, which is what these are.
 *
 * Every call here is best effort. Private windows, blocked storage and a full quota all
 * degrade to "not cached", never to an exception or a hang.
 */
const CACHE_NAME = "cropsize-models-v2";
const LEGACY_DATABASE = "cropsize-models";

/** Cache keys must be URLs. This one is never fetched; it only names the entry. */
function requestFor(key: string): Request {
  return new Request(new URL(`/__model-cache/${encodeURIComponent(key)}`, location.origin));
}

async function openCache(): Promise<Cache | null> {
  try {
    return typeof caches === "undefined" ? null : await caches.open(CACHE_NAME);
  } catch {
    return null;
  }
}

export async function getCached(key: string, expectedBytes: number): Promise<ArrayBuffer | null> {
  const cache = await openCache();
  if (!cache) return null;
  try {
    const response = await cache.match(requestFor(key));
    if (!response) return null;
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength === expectedBytes) return buffer;
    await cache.delete(requestFor(key));          // truncated or stale: drop it
    return null;
  } catch {
    return null;
  }
}

/**
 * Store a buffer. The body is copied when the Response is constructed, synchronously, so the
 * caller may hand the same buffer to ONNX Runtime straight away even if that detaches it.
 */
export function putCached(key: string, buffer: ArrayBuffer): Promise<void> {
  const response = new Response(buffer, {
    headers: {
      "content-type": "application/octet-stream",
      "content-length": String(buffer.byteLength),
    },
  });
  return openCache()
    .then(cache => cache?.put(requestFor(key), response))
    .catch(() => undefined);
}

/** Which of these keys are stored, so the UI can say "cached" honestly. */
export async function cachedKeys(keys: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  const cache = await openCache();
  if (!cache) return found;
  await Promise.all(keys.map(async key => {
    try {
      if (await cache.match(requestFor(key))) found.add(key);
    } catch {
      // unreadable counts as absent
    }
  }));
  return found;
}

/**
 * Drop entries that belong to no current key, such as a previous pinned revision, and the
 * old IndexedDB store, which holds nothing the Cache API version can use.
 */
export async function pruneCache(keep: Set<string>): Promise<void> {
  try {
    if (typeof indexedDB !== "undefined") indexedDB.deleteDatabase(LEGACY_DATABASE);
  } catch {
    // nothing to clean up
  }
  const cache = await openCache();
  if (!cache) return;
  try {
    const wanted = new Set([...keep].map(key => requestFor(key).url));
    for (const request of await cache.keys()) {
      if (!wanted.has(request.url)) await cache.delete(request);
    }
  } catch {
    // leave it for next time
  }
}
