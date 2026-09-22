/**
 * Fetch, verify and cache model artifacts.
 *
 * onnx-community ships weights in a sidecar `.onnx_data`, so the filename allowlist admits
 * that extension and artifacts come in pairs. Every file is checked against the byte size in
 * the pinned manifest; a truncated, oversized or substituted response fails instead of
 * half-loading.
 *
 * Downloads are shared. The background warm-up and a real load ask for the same files, and
 * both attach to one in-flight fetch rather than racing or restarting it.
 */
import {
  MODELS, artifactNames, artifactSize, modelBase,
  type Precision, type Quality,
} from "./constants";
import { cachedKeys, getCached, putCached, pruneCache } from "./model-cache";

const MODEL_FILE_PATTERN = /^[a-z0-9][a-z0-9_.-]*\.onnx(_data)?$/iu;
const MAX_MODEL_BYTES = 512 * 1024 * 1024;

export interface ModelArtifacts {
  graph: ArrayBuffer;
  weights: ArrayBuffer;
  weightsName: string;       // what the graph's external-data record points at
}

/** Cache keys carry the revision, so re-pinning the model evicts the old files. */
export function artifactKey(quality: Quality, name: string): string {
  return `${MODELS[quality].revision}/${name}`;
}

function artifactUrl(quality: Quality, name: string): string {
  if (!MODEL_FILE_PATTERN.test(name) || name.includes("..")) {
    throw new Error(`Refusing unexpected model filename: ${name}`);
  }
  return new URL(encodeURIComponent(name), modelBase(quality)).toString();
}

interface Download {
  loaded: number;
  fromCache: boolean;
  listeners: Set<() => void>;
  promise: Promise<ArrayBuffer>;
}

const inFlight = new Map<string, Download>();

async function fetchVerified(
  quality: Quality, name: string, expected: number, download: Download,
): Promise<ArrayBuffer> {
  const bump = (bytes: number) => {
    download.loaded += bytes;
    for (const listener of download.listeners) listener();
  };
  const cached = await getCached(artifactKey(quality, name), expected);
  if (cached) {
    download.fromCache = true;
    bump(expected);
    return cached;
  }
  const response = await fetch(artifactUrl(quality, name));
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) !== expected) {
    throw new Error(`${name}: server declared ${declared} bytes, manifest says ${expected}`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error(`${name}: no response body`);
  const bytes = new Uint8Array(expected);
  let offset = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    // Bail mid-stream rather than write past the manifest size.
    if (offset + value.byteLength > expected) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`${name}: response exceeded ${expected} bytes`);
    }
    bytes.set(value, offset);
    offset += value.byteLength;
    bump(value.byteLength);
  }
  if (offset !== expected) throw new Error(`${name}: got ${offset} bytes, manifest says ${expected}`);
  void putCached(artifactKey(quality, name), bytes.buffer);    // never waited on
  return bytes.buffer;
}

/** Start or join the download of one artifact. */
function download(quality: Quality, name: string): Download {
  const key = artifactKey(quality, name);
  const existing = inFlight.get(key);
  if (existing) return existing;
  const expected = artifactSize(quality, name);
  if (expected > MAX_MODEL_BYTES) throw new Error(`Manifest entry too large: ${name}`);
  const entry: Download = {
    loaded: 0, fromCache: false, listeners: new Set(), promise: Promise.resolve(new ArrayBuffer(0)),
  };
  entry.promise = fetchVerified(quality, name, expected, entry)
    .finally(() => inFlight.delete(key));
  inFlight.set(key, entry);
  return entry;
}

/**
 * Fetch several artifacts at once and report their combined progress. `onProgress` is called
 * with bytes loaded so far, the total, and whether everything came from the cache.
 */
export async function fetchArtifacts(
  quality: Quality,
  names: string[],
  onProgress: (loaded: number, total: number, fromCache: boolean) => void,
): Promise<ArrayBuffer[]> {
  const downloads = names.map(name => download(quality, name));
  const total = names.reduce((sum, name) => sum + artifactSize(quality, name), 0);
  const emit = () => onProgress(
    downloads.reduce((sum, item) => sum + item.loaded, 0),
    total,
    downloads.every(item => item.fromCache),
  );
  for (const item of downloads) item.listeners.add(emit);
  emit();
  try {
    return await Promise.all(downloads.map(item => item.promise));
  } finally {
    for (const item of downloads) item.listeners.delete(emit);
  }
}

export function artifactPair(
  precision: Precision, which: "vision_encoder" | "prompt_encoder_mask_decoder",
): [string, string] {
  const graph = `${which}${precision === "fp16" ? "_fp16" : ""}.onnx`;
  return [graph, `${graph}_data`];
}

/** How many of one model's files are in the cache already. */
export async function cachedCount(
  quality: Quality, precision: Precision,
): Promise<{ have: number; of: number }> {
  const names = artifactNames(quality, precision);
  const found = await cachedKeys(names.map(name => artifactKey(quality, name)));
  return { have: found.size, of: names.length };
}

/**
 * Fill the cache in the background before the user has picked anything. One file at a time,
 * so the warm-up never competes hard with the page it is warming up for; a real load joins
 * whichever file is in flight and starts the rest itself. Stopping only takes effect between
 * files, because a half-downloaded file is wasted bytes.
 */
export async function warmCache(
  quality: Quality,
  precision: Precision,
  shouldStop: () => boolean,
  onProgress: (loaded: number, total: number) => void,
): Promise<void> {
  const names = artifactNames(quality, precision);
  const present = await cachedKeys(names.map(name => artifactKey(quality, name)));
  const missing = names.filter(name => !present.has(artifactKey(quality, name)));
  const total = missing.reduce((sum, name) => sum + artifactSize(quality, name), 0);
  let finished = 0;
  for (const name of missing) {
    if (shouldStop()) return;
    const item = download(quality, name);
    const emit = () => onProgress(finished + item.loaded, total);
    item.listeners.add(emit);
    try {
      await item.promise;
    } finally {
      item.listeners.delete(emit);
    }
    finished += artifactSize(quality, name);
  }
}

/** Remove cache entries for anything outside the current manifest. */
export function pruneModelCache(): Promise<void> {
  const keep = new Set<string>();
  for (const quality of Object.keys(MODELS) as Quality[]) {
    for (const name of Object.keys(MODELS[quality].files)) keep.add(artifactKey(quality, name));
  }
  return pruneCache(keep);
}
