/**
 * Pinned model artifacts.
 *
 * Weights are served from Hugging Face at an immutable revision, never `main`, and every
 * download is checked against the exact byte size recorded here. A truncated, oversized or
 * substituted response fails instead of half-loading — the same discipline tinyvoice uses.
 *
 * Note the sidecar layout: onnx-community ships graph and weights separately, so each
 * artifact is a `.onnx` plus a `.onnx_data`. ONNX Runtime Web must be told about the
 * second file explicitly via the session's `externalData` option; it will not find it.
 */

export type Quality = "tiny" | "base-plus";
export type Precision = "fp32" | "fp16";

interface ModelSpec {
  repo: string;
  revision: string;
  files: Readonly<Record<string, number>>;
}

/** Verified against the Hugging Face model API on 2026-07-29. */
export const MODELS: Readonly<Record<Quality, ModelSpec>> = {
  tiny: {
    repo: "onnx-community/sam2.1-hiera-tiny-ONNX",
    revision: "814a066640debee5a91e70aa401fb8e17e030503",
    files: {
      "vision_encoder.onnx": 354_238,
      "vision_encoder.onnx_data": 134_084_864,
      "vision_encoder_fp16.onnx": 314_925,
      "vision_encoder_fp16.onnx_data": 67_005_504,
      "prompt_encoder_mask_decoder.onnx": 213_114,
      "prompt_encoder_mask_decoder.onnx_data": 20_958_208,
      "prompt_encoder_mask_decoder_fp16.onnx": 229_799,
      "prompt_encoder_mask_decoder_fp16.onnx_data": 10_454_016,
    },
  },
  "base-plus": {
    repo: "onnx-community/sam2.1-hiera-base-plus-ONNX",
    revision: "bab18593f44e652f04cf18b60b3690f60e8996b0",
    files: {
      "vision_encoder.onnx": 702_836,
      "vision_encoder.onnx_data": 305_746_496,
      "vision_encoder_fp16.onnx": 643_078,
      "vision_encoder_fp16.onnx_data": 152_780_640,
      "prompt_encoder_mask_decoder.onnx": 213_114,
      "prompt_encoder_mask_decoder.onnx_data": 20_958_208,
      "prompt_encoder_mask_decoder_fp16.onnx": 229_799,
      "prompt_encoder_mask_decoder_fp16.onnx_data": 10_454_016,
    },
  },
} as const;

export function modelBase(quality: Quality): string {
  // ?models=local serves the weights from this origin instead of Hugging Face, which is how
  // the app gets exercised offline and in automated capture, where a cross origin fetch of
  // 78 MB does not settle.
  if (typeof location !== "undefined"
      && new URLSearchParams(location.search).get("models") === "local") {
    return new URL("models/", location.href).toString();
  }
  const { repo, revision } = MODELS[quality];
  return `https://huggingface.co/${repo}/resolve/${revision}/onnx/`;
}

/** Manifest lookup that fails loudly: an unknown artifact must never be fetched blind. */
export function artifactSize(quality: Quality, name: string): number {
  const size = MODELS[quality].files[name];
  if (size === undefined) throw new Error(`Not in the pinned manifest: ${name}`);
  return size;
}

/** The four files one quality and precision needs: two graphs, two weight sidecars. */
export function artifactNames(quality: Quality, precision: Precision): string[] {
  const suffix = precision === "fp16" ? "_fp16" : "";
  return [
    `vision_encoder${suffix}.onnx`,
    `vision_encoder${suffix}.onnx_data`,
    `prompt_encoder_mask_decoder${suffix}.onnx`,
    `prompt_encoder_mask_decoder${suffix}.onnx_data`,
  ];
}

export function revision(quality: Quality): string {
  return MODELS[quality].revision;
}

/** Total first-visit download, for the UI to state before it starts. */
export function downloadBytes(quality: Quality, precision: Precision): number {
  const suffix = precision === "fp16" ? "_fp16" : "";
  return (
    artifactSize(quality, `vision_encoder${suffix}.onnx`) +
    artifactSize(quality, `vision_encoder${suffix}.onnx_data`) +
    artifactSize(quality, `prompt_encoder_mask_decoder${suffix}.onnx`) +
    artifactSize(quality, `prompt_encoder_mask_decoder${suffix}.onnx_data`)
  );
}

/**
 * Preprocessing contract, read off the exported graphs rather than assumed.
 *
 *   vision_encoder    pixel_values [1,3,1024,1024] -> embeddings at 256², 128², 64²
 *   prompt_decoder    embeddings + points/boxes    -> iou_scores, pred_masks [1,1,3,256,256]
 *
 * The resize to 1024x1024 does NOT preserve aspect ratio, so prompt coordinates scale
 * independently per axis, and masks come back at 256x256 to be upsampled to full size.
 */
export const SAM = {
  inputSize: 1024,
  maskSize: 256,
  mean: [0.485, 0.456, 0.406] as const,   // ImageNet
  std: [0.229, 0.224, 0.225] as const,
  encoderOutputs: ["image_embeddings.0", "image_embeddings.1", "image_embeddings.2"] as const,
} as const;

/** Measured with onnxruntime 1.28 on CPU, tiny/fp32: encoder 0.74 s, decoder 36 ms. */
