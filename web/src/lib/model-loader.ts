/**
 * Fetch, verify and cache model artifacts.
 *
 * Adapted from tinyvoice's loader, with one structural difference: onnx-community ships
 * weights in a sidecar `.onnx_data`, so the filename allowlist must admit that extension
 * and artifacts are fetched in pairs. tinyvoice's `/\.onnx$/` pattern rejects them.
 */
import { MODELS, artifactSize, modelBase, type Precision, type Quality } from "./constants";
import { getCached, setCache } from "./model-cache";

const MODEL_FILE_PATTERN = /^[a-z0-9][a-z0-9_.-]*\.onnx(_data)?$/iu;
const MAX_MODEL_BYTES = 512 * 1024 * 1024;

export interface LoadProgress {
  fraction: number;          // 0..1 across the whole request
  status: string;
  loadedBytes: number;
  totalBytes: number;
}

export interface ModelArtifacts {
  graph: ArrayBuffer;
  weights: ArrayBuffer;
  weightsName: string;       // what the graph's external-data record points at
}

function artifactUrl(quality: Quality, name: string): string {
  if (!MODEL_FILE_PATTERN.test(name) || name.includes("..")) {
    throw new Error(`Refusing unexpected model filename: ${name}`);
  }
  return new URL(encodeURIComponent(name), modelBase(quality)).toString();
}

async function fetchExact(
  quality: Quality,
  name: string,
  onChunk: (delta: number) => void,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  const expected = artifactSize(quality, name);
  if (expected > MAX_MODEL_BYTES) throw new Error(`Manifest entry too large: ${name}`);

  const cacheKey = `${MODELS[quality].revision}/${name}`;
  const cached = await getCached(cacheKey);
  if (cached && cached.byteLength === expected) {
    onChunk(expected);
    return cached;
  }

  const res = await fetch(artifactUrl(quality, name), { signal });
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);

  const declared = res.headers.get("content-length");
  if (declared !== null && Number(declared) !== expected) {
    throw new Error(`${name}: server declared ${declared} bytes, manifest says ${expected}`);
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = res.body?.getReader();
  if (!reader) throw new Error(`${name}: no response body`);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      // Bail mid-stream rather than buffering an unbounded response.
      if (total > expected) throw new Error(`${name}: response exceeded ${expected} bytes`);
      chunks.push(value);
      onChunk(value.byteLength);
    }
  }
  if (total !== expected) {
    throw new Error(`${name}: got ${total} bytes, manifest says ${expected}`);
  }

  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
  await setCache(cacheKey, buf.buffer).catch(() => undefined);   // cache is best-effort
  return buf.buffer;
}

export async function loadArtifacts(
  quality: Quality,
  precision: Precision,
  which: "vision_encoder" | "prompt_encoder_mask_decoder",
  onProgress: (p: LoadProgress) => void,
  signal?: AbortSignal,
): Promise<ModelArtifacts> {
  const suffix = precision === "fp16" ? "_fp16" : "";
  const graphName = `${which}${suffix}.onnx`;
  const weightsName = `${graphName}_data`;
  const totalBytes = artifactSize(quality, graphName) + artifactSize(quality, weightsName);

  let loaded = 0;
  const bump = (delta: number) => {
    loaded += delta;
    onProgress({
      fraction: Math.min(loaded / totalBytes, 1),
      status: `${which.replace(/_/g, " ")} — ${(loaded / 1048576).toFixed(0)} / ${(totalBytes / 1048576).toFixed(0)} MB`,
      loadedBytes: loaded,
      totalBytes,
    });
  };

  const graph = await fetchExact(quality, graphName, bump, signal);
  const weights = await fetchExact(quality, weightsName, bump, signal);
  return { graph, weights, weightsName };
}
