/**
 * SAM 2.1 in the browser: encode once per image, decode per prompt.
 *
 * The split is what makes this feel instant. The vision encoder is the expensive part and
 * runs once per image; every prompt afterwards is only the decoder, tens of milliseconds.
 * Encodings are remembered per image, so detecting again or switching to several-items mode
 * on the same scan costs no second encoder pass.
 */
import { SAM, type Precision, type Quality } from "./constants";
// `ort` is a global from the CDN script tag; see src/types/ort.d.ts.
import {
  artifactPair, cachedCount, fetchArtifacts, type ModelArtifacts,
} from "./model-loader";
import { silent, type Report } from "./progress";

export interface Embeddings {
  /**
   * Pristine encoder outputs. ORT's proxy worker detaches every feed buffer it is handed
   * (postMessage transfer), so these are never given to a session directly; decodeAll copies
   * from them each run.
   */
  masters: Record<string, { data: Float32Array; dims: readonly number[] }>;
  width: number;    // source pixel dimensions the prompts will be expressed against
  height: number;
}

export interface DecodedMask { mask: Float32Array; size: number; score: number }

export interface Prompt {
  box?: [number, number, number, number];
  points?: [number, number, 0 | 1][];
}

/** WASM first, because it is the path measured working end to end. WebGPU is opt in with
 *  ?gpu=1: a WebGPU session can be created successfully and still fail inside run(). */
function backendOrder(): string[] {
  return typeof location !== "undefined"
      && new URLSearchParams(location.search).get("gpu") === "1"
    ? ["webgpu", "wasm"] : ["wasm"];
}

/**
 * Whether session work runs in ORT's proxy worker. Building a base-plus encoder compiles
 * tens of megabytes of WebAssembly; on the main thread that freezes the tab solid. Once the
 * environment has answered, its decision sticks for every later session.
 */
let proxyDecided: boolean | null = null;

async function createSession(
  artifacts: ModelArtifacts,
): Promise<{ session: ort.InferenceSession; backend: string }> {
  // Weights live in a sidecar file; ORT will not discover it on its own.
  const externalData = [{ path: artifacts.weightsName, data: artifacts.weights }];
  // Proxy worker first; if this environment refuses worker-backed sessions (strict CSP, odd
  // embeds), retry once inline. Slower for the tab, but it works.
  const attempts = proxyDecided === null ? [true, false] : [proxyDecided];
  let lastError: unknown;
  for (const useProxy of attempts) {
    ort.env.wasm.proxy = useProxy;
    for (const backend of backendOrder()) {
      try {
        const session = await ort.InferenceSession.create(artifacts.graph, {
          executionProviders: [backend], externalData,
        });
        proxyDecided = useProxy;
        return { session, backend };
      } catch (error) {
        lastError = error;
        if (backend === "wasm") break;   // no point trying further providers
      }
    }
  }
  throw lastError ?? new Error("no execution provider available");
}

export class Sam {
  private encoder?: ort.InferenceSession;
  private decoder?: ort.InferenceSession;
  private loading?: Promise<void>;
  private readonly encodings = new WeakMap<ImageData, Embeddings>();

  backend = "";

  constructor(readonly quality: Quality = "tiny", readonly precision: Precision = "fp32") {}

  get loaded(): boolean { return !!(this.encoder && this.decoder); }

  /** Threads need cross origin isolation. Without it the encoder is several times slower. */
  static get threaded(): boolean {
    return typeof crossOriginIsolated !== "undefined" && crossOriginIsolated;
  }

  /** Which of the four files are already in the cache. */
  cached(): Promise<{ have: number; of: number }> {
    return cachedCount(this.quality, this.precision);
  }

  /** Download what is missing and build both sessions. Safe to call repeatedly. */
  ready(report: Report = silent): Promise<void> {
    if (this.loaded) return Promise.resolve();
    this.loading ??= this.load(report).finally(() => { this.loading = undefined; });
    return this.loading;
  }

  private async load(report: Report): Promise<void> {
    const encoderFiles = artifactPair(this.precision, "vision_encoder");
    const decoderFiles = artifactPair(this.precision, "prompt_encoder_mask_decoder");
    // All four files in parallel; progress is one byte budget across them.
    const [encoderGraph, encoderWeights, decoderGraph, decoderWeights] = await fetchArtifacts(
      this.quality, [...encoderFiles, ...decoderFiles],
      (loaded, total, fromCache) => report({ phase: "download", loaded, total, fromCache }),
    );
    report({ phase: "compile", part: "encoder", state: "start" });
    const encoder = await createSession({
      graph: encoderGraph!, weights: encoderWeights!, weightsName: encoderFiles[1],
    });
    report({ phase: "compile", part: "encoder", state: "done" });
    report({ phase: "compile", part: "decoder", state: "start" });
    const decoder = await createSession({
      graph: decoderGraph!, weights: decoderWeights!, weightsName: decoderFiles[1],
    });
    report({ phase: "compile", part: "decoder", state: "done" });
    this.encoder = encoder.session;
    this.decoder = decoder.session;
    this.backend = encoder.backend;
  }

  /** Free the native sessions promptly, so ~160 MB of ORT heap is not pinned until GC. */
  async release(): Promise<void> {
    await this.loading?.catch(() => undefined);
    await Promise.allSettled([
      this.encoder?.release() ?? Promise.resolve(),
      this.decoder?.release() ?? Promise.resolve(),
    ]);
    this.encoder = undefined;
    this.decoder = undefined;
  }

  /** Letterbox-free resize to 1024x1024 plus ImageNet normalisation, as the export expects. */
  private preprocess(source: ImageData): Float32Array {
    const n = SAM.inputSize;
    const canvas = new OffscreenCanvas(n, n);
    const context = canvas.getContext("2d")!;
    const full = new OffscreenCanvas(source.width, source.height);
    full.getContext("2d")!.putImageData(source, 0, 0);
    context.drawImage(full, 0, 0, n, n);          // deliberately not aspect-preserving
    const { data } = context.getImageData(0, 0, n, n);

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

  async encode(image: ImageData, report: Report = silent): Promise<Embeddings> {
    const known = this.encodings.get(image);
    if (known) {
      report({ phase: "encode", state: "reused" });
      return known;
    }
    if (!this.encoder) throw new Error("call ready() first");
    report({ phase: "encode", state: "start" });
    const n = SAM.inputSize;
    const input = new ort.Tensor("float32", this.preprocess(image), [1, 3, n, n]);
    const out = await this.encoder.run({ pixel_values: input });
    const masters: Embeddings["masters"] = {};
    for (const name of SAM.encoderOutputs) {
      const tensor = out[name];
      if (!tensor || !(tensor.data instanceof Float32Array)) {
        throw new Error(`encoder did not return ${name}`);
      }
      masters[name] = { data: tensor.data, dims: tensor.dims };
    }
    const embeddings = { masters, width: image.width, height: image.height };
    this.encodings.set(image, embeddings);
    report({ phase: "encode", state: "done" });
    return embeddings;
  }

  /** The best mask for a prompt given in SOURCE pixel coordinates. */
  async decode(emb: Embeddings, prompt: Prompt): Promise<DecodedMask> {
    const candidates = await this.decodeAll(emb, prompt);
    return candidates.reduce((best, candidate) => candidate.score > best.score ? candidate : best);
  }

  /** Every mask proposal for a prompt, 256x256 each with its predicted IoU score. */
  async decodeAll(emb: Embeddings, prompt: Prompt): Promise<DecodedMask[]> {
    if (!this.decoder) throw new Error("call ready() first");
    const sx = SAM.inputSize / emb.width;
    const sy = SAM.inputSize / emb.height;
    const points = prompt.points ?? [];
    // Fresh tensors from the pristine masters every call: under the proxy backend the
    // buffers are transferred away, so handing out the same tensor twice would detach it.
    const feeds: Record<string, ort.Tensor> = {
      ...Object.fromEntries(Object.entries(emb.masters).map(([name, master]) =>
        [name, new ort.Tensor("float32", new Float32Array(master.data), master.dims)])),
      input_points: new ort.Tensor("float32",
        Float32Array.from(points.flatMap(([x, y]) => [x * sx, y * sy])), [1, 1, points.length, 2]),
      input_labels: new ort.Tensor("int64",
        BigInt64Array.from(points.map(([, , label]) => BigInt(label))), [1, 1, points.length]),
      input_boxes: new ort.Tensor("float32",
        Float32Array.from(prompt.box
          ? [prompt.box[0] * sx, prompt.box[1] * sy, prompt.box[2] * sx, prompt.box[3] * sy]
          : []),
        [1, prompt.box ? 1 : 0, 4]),
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
