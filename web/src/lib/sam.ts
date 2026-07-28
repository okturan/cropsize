/**
 * SAM 2.1 in the browser: encode once per image, decode per prompt.
 *
 * The split is what makes this feel instant. The vision encoder is the expensive part and
 * runs once; every click afterwards is only the decoder, measured at 36 ms on CPU with the
 * tiny model — fast enough for a hover preview, which a server round-trip could never be.
 */
import { SAM, type Precision, type Quality } from "./constants";
// `ort` is a global from the CDN script tag; see src/types/ort.d.ts.
import { loadArtifacts, type LoadProgress } from "./model-loader";

export interface Embeddings {
  tensors: Record<string, ort.Tensor>;
  width: number;    // source pixel dimensions the prompts will be expressed against
  height: number;
}

async function session(
  quality: Quality, precision: Precision,
  which: "vision_encoder" | "prompt_encoder_mask_decoder",
  onProgress: (p: LoadProgress) => void,
): Promise<ort.InferenceSession> {
  const { graph, weights, weightsName } = await loadArtifacts(quality, precision, which, onProgress);
  return ort.InferenceSession.create(graph, {
    executionProviders: ["webgpu", "wasm"],
    // Weights live in a sidecar file; ORT will not discover it on its own.
    externalData: [{ path: weightsName, data: weights }],
  });
}

export class Sam {
  private encoder?: ort.InferenceSession;
  private decoder?: ort.InferenceSession;

  constructor(private quality: Quality = "tiny", private precision: Precision = "fp32") {}

  async ready(onProgress: (p: LoadProgress) => void): Promise<void> {
    this.encoder ??= await session(this.quality, this.precision, "vision_encoder", onProgress);
    this.decoder ??= await session(this.quality, this.precision, "prompt_encoder_mask_decoder", onProgress);
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
    const tensors: Record<string, ort.Tensor> = {};
    for (const name of SAM.encoderOutputs) {
      const t = out[name];
      if (!t) throw new Error(`encoder did not return ${name}`);
      tensors[name] = t;
    }
    return { tensors, width: image.width, height: image.height };
  }

  /**
   * Prompt with a box and/or points, in SOURCE pixel coordinates.
   * Returns the best mask as a 256x256 float array plus its score.
   */
  async decode(
    emb: Embeddings,
    opts: { box?: [number, number, number, number]; points?: [number, number, 0 | 1][] },
  ): Promise<{ mask: Float32Array; size: number; score: number }> {
    if (!this.decoder) throw new Error("call ready() first");
    const sx = SAM.inputSize / emb.width;
    const sy = SAM.inputSize / emb.height;

    const pts = opts.points ?? [];
    const feeds: Record<string, ort.Tensor> = {
      ...emb.tensors,
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
    let best = 0;
    for (let i = 1; i < scores.length; i++) {
      if ((scores[i] ?? -Infinity) > (scores[best] ?? -Infinity)) best = i;
    }
    return {
      mask: masks.slice(best * size * size, (best + 1) * size * size),
      size,
      score: scores[best] ?? 0,
    };
  }
}
