/**
 * SAM 2.1 in the browser: encode once per image, decode per prompt.
 *
 * The split is what makes this feel instant. The vision encoder is the expensive part and
 * runs once; every click afterwards is only the decoder, measured at 36 ms on CPU with the
 * tiny model — fast enough for a hover preview, which a server round-trip could never be.
 */
import { SAM, downloadBytes, type Precision, type Quality } from "./constants";
// `ort` is a global from the CDN script tag; see src/types/ort.d.ts.
import { loadArtifacts, type LoadProgress, type ModelArtifacts } from "./model-loader";

export interface Embeddings {
  /**
   * Pristine encoder outputs. ORT's proxy worker detaches every feed buffer it is handed
   * (postMessage transfer), so these are never given to a session directly — decodeAll
   * copies from them each run. Kept as plain arrays rather than Tensors for that reason.
   */
  masters: Record<string, { data: Float32Array; dims: readonly number[] }>;
  width: number;    // source pixel dimensions the prompts will be expressed against
  height: number;
}

export interface DecodedMask { mask: Float32Array; size: number; score: number }

/** WASM first, because it is the path that has actually been measured working end to end.
 *  WebGPU is opt in with ?gpu=1 until it has been verified on real hardware: a WebGPU
 *  session can be created successfully and still fail inside run(). */
function backendOrder(): string[] {
  return typeof location !== "undefined"
      && new URLSearchParams(location.search).get("gpu") === "1"
    ? ["webgpu", "wasm"] : ["wasm"];
}

/**
 * Whether session work runs in ORT's proxy worker. Building a base-plus encoder compiles
 * tens of megabytes of WebAssembly; on the main thread that freezes the tab solid, which
 * reads as "the page stopped loading" — the exact failure this exists to prevent. Once the
 * environment has answered, its decision sticks for every later session.
 */
let proxyDecided: boolean | null = null;

async function sessionFrom(
  artifacts: ModelArtifacts,
  which: "vision_encoder" | "prompt_encoder_mask_decoder",
  onProgress: (p: LoadProgress) => void,
  currentFraction: () => number,
): Promise<{ session: ort.InferenceSession; backend: string }> {
  // Weights live in a sidecar file; ORT will not discover it on its own.
  const externalData = [{ path: artifacts.weightsName, data: artifacts.weights }];
  // Building the session is the slow part once the bytes are here, and it reports
  // nothing, so say what is happening rather than leaving a full bar sitting still.
  onProgress({
    fraction: currentFraction(), loadedBytes: 0, totalBytes: 0,
    status: `preparing ${which.replace(/_/g, " ")}, this takes a few seconds`,
  });
  // Proxy worker first; if this environment refuses worker-backed sessions (strict CSP,
  // odd embeds), retry once inline — slower for the tab, but it works.
  const attempts = proxyDecided === null ? [true, false] : [proxyDecided];
  let lastError: unknown;
  for (const useProxy of attempts) {
    ort.env.wasm.proxy = useProxy;
    for (const backend of backendOrder()) {
      try {
        const s = await ort.InferenceSession.create(artifacts.graph, {
          executionProviders: [backend], externalData,
        });
        proxyDecided = useProxy;
        return { session: s, backend };
      } catch (err) {
        lastError = err;
        if (backend === "wasm") break;   // no point trying further providers
      }
    }
  }
  throw lastError ?? new Error("no execution provider available");
}

export class Sam {
  private encoder?: ort.InferenceSession;
  private decoder?: ort.InferenceSession;

  backend = "";

  get loaded(): boolean { return !!(this.encoder && this.decoder); }

  constructor(private quality: Quality = "tiny", private precision: Precision = "fp32") {}

  async ready(onProgress: (p: LoadProgress) => void): Promise<void> {
    if (this.encoder && this.decoder) return;
    // One byte budget across all four files. Reporting each pair separately made the bar
    // fill, reset and then sit still, which reads as a hang rather than as progress.
    const totalBytes = downloadBytes(this.quality, this.precision);
    let loaded = 0;
    const bump = (delta: number) => {
      loaded += delta;
      onProgress({
        fraction: Math.min(loaded / totalBytes, 1),
        status: `downloading the model — ${(loaded / 1048576).toFixed(0)} / ${(totalBytes / 1048576).toFixed(0)} MB`,
        loadedBytes: loaded,
        totalBytes,
      });
    };
    // Start every download up front. The old order fetched the decoder only after the
    // encoder session had finished building, idling the network through the slowest step.
    const encArtifacts = loadArtifacts(this.quality, this.precision, "vision_encoder", bump);
    const decArtifacts =
      loadArtifacts(this.quality, this.precision, "prompt_encoder_mask_decoder", bump);
    if (!this.encoder) {
      const r = await sessionFrom(await encArtifacts, "vision_encoder",
        onProgress, () => Math.min(loaded / totalBytes, 1));
      this.encoder = r.session;
      this.backend = r.backend;
    }
    if (!this.decoder) {
      const r = await sessionFrom(await decArtifacts, "prompt_encoder_mask_decoder",
        onProgress, () => Math.min(loaded / totalBytes, 1));
      this.decoder = r.session;
    }
  }

  /** Free the native sessions promptly; called when swapping models so ~160 MB of ORT
   *  heap does not stay pinned until the collector gets around to it. */
  async release(): Promise<void> {
    await Promise.allSettled([
      this.encoder?.release() ?? Promise.resolve(),
      this.decoder?.release() ?? Promise.resolve(),
    ]);
    this.encoder = undefined;
    this.decoder = undefined;
  }

  /** Threads need cross origin isolation. Without it the encoder is several times slower. */
  static get threaded(): boolean {
    return typeof crossOriginIsolated !== "undefined" && crossOriginIsolated;
  }

  /** Which of the four files are already in the cache. */
  async cached(): Promise<{ have: number; of: number }> {
    const { artifactNames } = await import("./constants");
    const { artifactKey } = await import("./model-loader");
    const { cachedKeys } = await import("./model-cache");
    const names = artifactNames(this.quality, this.precision);
    const found = await cachedKeys(names.map(n => artifactKey(this.quality, n)));
    return { have: found.size, of: names.length };
  }

  /** Letterbox-free resize to 1024x1024 plus ImageNet normalisation, as the export expects. */
  private preprocess(src: ImageData): Float32Array {
    const n = SAM.inputSize;
    const canvas = new OffscreenCanvas(n, n);
    const ctx = canvas.getContext("2d")!;
    const bmpSrc = new OffscreenCanvas(src.width, src.height);
    bmpSrc.getContext("2d")!.putImageData(src, 0, 0);
    ctx.drawImage(bmpSrc, 0, 0, n, n);          // deliberately not aspect-preserving
    const { data } = ctx.getImageData(0, 0, n, n);

    const out = new Float32Array(3 * n * n);
    const plane = n * n;
    const [mr, mg, mb] = SAM.mean;
    const [sr, sg, sb] = SAM.std;
    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
      out[p] = ((data[i] ?? 0) / 255 - mr) / sr;
      out[plane + p] = ((data[i + 1] ?? 0) / 255 - mg) / sg;
      out[2 * plane + p] = ((data[i + 2] ?? 0) / 255 - mb) / sb;
    }
    return out;
  }

  async encode(image: ImageData): Promise<Embeddings> {
    if (!this.encoder) throw new Error("call ready() first");
    const n = SAM.inputSize;
    const input = new ort.Tensor("float32", this.preprocess(image), [1, 3, n, n]);
    const out = await this.encoder.run({ pixel_values: input });
    const masters: Embeddings["masters"] = {};
    for (const name of SAM.encoderOutputs) {
      const t = out[name];
      if (!t || !(t.data instanceof Float32Array)) {
        throw new Error(`encoder did not return ${name}`);
      }
      masters[name] = { data: t.data, dims: t.dims };
    }
    return { masters, width: image.width, height: image.height };
  }

  /**
   * Prompt with a box and/or points, in SOURCE pixel coordinates.
   * Returns the best mask as a 256x256 float array plus its score.
   */
  async decode(
    emb: Embeddings,
    opts: { box?: [number, number, number, number]; points?: [number, number, 0 | 1][] },
  ): Promise<DecodedMask> {
    const candidates = await this.decodeAll(emb, opts);
    return candidates.reduce((best, candidate) => candidate.score > best.score ? candidate : best);
  }

  /** Return every mask proposal for a prompt; objects mode filters and groups them later. */
  async decodeAll(
    emb: Embeddings,
    opts: { box?: [number, number, number, number]; points?: [number, number, 0 | 1][] },
  ): Promise<DecodedMask[]> {
    if (!this.decoder) throw new Error("call ready() first");
    const sx = SAM.inputSize / emb.width;
    const sy = SAM.inputSize / emb.height;

    const pts = opts.points ?? [];
    // Fresh tensors from the pristine masters every call: under the proxy backend the
    // buffers are transferred away, so handing out the same tensor twice would detach it.
    const feeds: Record<string, ort.Tensor> = {
      ...Object.fromEntries(Object.entries(emb.masters).map(([name, m]) =>
        [name, new ort.Tensor("float32", new Float32Array(m.data), m.dims)])),
      input_points: new ort.Tensor("float32",
        Float32Array.from(pts.flatMap(([x, y]) => [x * sx, y * sy])), [1, 1, pts.length, 2]),
      input_labels: new ort.Tensor("int64",
        BigInt64Array.from(pts.map(([, , l]) => BigInt(l))), [1, 1, pts.length]),
      input_boxes: new ort.Tensor("float32",
        Float32Array.from(opts.box
          ? [opts.box[0] * sx, opts.box[1] * sy, opts.box[2] * sx, opts.box[3] * sy]
          : []),
        [1, opts.box ? 1 : 0, 4]),
    };

    const out = await this.decoder.run(feeds);
    if (!out.iou_scores || !out.pred_masks) throw new Error("decoder returned no masks");
    const scores = out.iou_scores.data as Float32Array;
    const masks = out.pred_masks.data as Float32Array;
    const size = SAM.maskSize;
    return Array.from(scores, (score, index) => ({
      mask: masks.slice(index * size * size, (index + 1) * size * size),
      size,
      score,
    }));
  }
}
