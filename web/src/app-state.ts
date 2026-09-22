import type { Box } from "./lib/detect";
import type { ObjectCandidate } from "./lib/objects";
import type { SheetItem } from "./lib/sheet";
import type { DocumentSource, Scan } from "./lib/source";

export type MaskState = { mask: Float32Array; size: number; box: Box };

export type PageState = {
  scan: Omit<Scan, "image">;
  original: ImageData;
  skew: number;
  mask: MaskState | null;
  box: Box;
  note: string;
  objects: ObjectCandidate[];
  selectedObjectId: number | null;
};

/** A crop pinned on the output sheet; the signature says which live state it was taken from. */
export type TrayItem = SheetItem & { id: number; signature: string };

export interface AppState {
  source: DocumentSource | null;
  page: number;
  pages: Map<number, PageState>;
  scan: Scan | null;
  toned: ImageData | null;
  original: ImageData | null;
  skew: number;
  mask: MaskState | null;
  box: Box;
  objects: ObjectCandidate[];
  selectedObjectId: number | null;
  /** crops pinned to print together on one sheet, in order */
  tray: TrayItem[];
  drag: null | { kind: "move" | "handle"; i: number; ox: number; oy: number };
}

export const defaultBox = (): Box => ({ x0: 0.05, y0: 0.05, x1: 0.95, y1: 0.95 });

export const state: AppState = {
  source: null,
  page: 0,
  pages: new Map(),
  scan: null,
  toned: null,
  original: null,
  skew: 0,
  mask: null,
  box: defaultBox(),
  objects: [],
  selectedObjectId: null,
  tray: [],
  drag: null,
};
