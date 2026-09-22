/**
 * What model work reports while it runs. The domain code emits these; the UI decides how to
 * draw them. Nothing here knows about the DOM.
 *
 *   download  bytes arriving, across every file the step needs
 *   compile   ONNX Runtime building a session, which reports nothing itself
 *   encode    the vision encoder reading the image, the slow part of every detection
 *   decode    prompt passes against one encoding, counted
 *   refine    geometry clean-up after the model, counted
 */
export type ProgressEvent =
  | { phase: "download"; loaded: number; total: number; fromCache: boolean }
  | { phase: "compile"; part: "encoder" | "decoder"; state: "start" | "done" }
  | { phase: "encode"; state: "start" | "done" | "reused" }
  | { phase: "decode"; done: number; total: number }
  | { phase: "refine"; done: number; total: number };

export type Report = (event: ProgressEvent) => void;

export const silent: Report = () => {};
