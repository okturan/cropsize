/**
 * ONNX Runtime Web is loaded from a CDN <script> tag (see index.html) and reached through
 * the global `ort`. Only the surface cropsize uses is declared.
 */
declare namespace ort {
  class Tensor {
    constructor(type: string, data: Float32Array | BigInt64Array, dims: readonly number[]);
    readonly data: Float32Array | BigInt64Array;
    readonly dims: readonly number[];
  }
  interface RunResult { [name: string]: Tensor | undefined }
  interface ExternalDataEntry { path: string; data: ArrayBuffer }
  interface SessionOptions {
    executionProviders?: readonly string[];
    externalData?: readonly ExternalDataEntry[];
  }
  const env: {
    wasm: {
      /** Session build and run happen in a proxy worker instead of the main thread. */
      proxy?: boolean;
      numThreads?: number;
    };
  };
  class InferenceSession {
    static create(model: ArrayBuffer | string, options?: SessionOptions): Promise<InferenceSession>;
    run(feeds: Record<string, Tensor>): Promise<RunResult>;
    release(): Promise<void>;
  }
}

declare module "pdfjs-dist/build/pdf.worker.min.mjs" {
  export const WorkerMessageHandler: unknown;
}
