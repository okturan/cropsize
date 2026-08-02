import * as ortModule from "onnxruntime-web";
import { expect, test } from "vitest";
import { detect } from "../src/lib/detect";
import { estimateSkew } from "../src/lib/imaging-core";
import { Sam } from "../src/lib/sam";
import { cropCanvas, measure, trimToMask } from "../src/lib/sheet";
import { loadPdf } from "../src/lib/source";
import { rotate } from "../src/lib/transform";

declare const __PRIVATE_FIXTURES_AVAILABLE__: boolean;
declare const __RUN_MODEL_CORPUS__: boolean;

interface Row {
  id: string;
  visibility: "public" | "private";
  file: string;
  source_name: string;
  page_mm: [number, number];
  expected: {
    box: [number, number, number, number];
    measured_mm: [number, number];
    trim_changed_fraction: number;
  };
  tolerance: {
    box_mm: number;
    measured_mm: number;
    trim_changed_fraction: number;
  };
  limits: { trim_changed_fraction: number };
}

const response = await fetch("/corpus.json");
if (!response.ok) throw new Error(`corpus manifest: HTTP ${response.status}`);
const corpus = await response.json() as { render_dpi: number; fixtures: Row[] };

// Production loads ORT as a global script. Give the same global to Sam while keeping this
// opt-in suite self-contained.
Object.assign(globalThis, { ort: ortModule });
ortModule.env.wasm.numThreads = 4;
const sam = new Sam("base-plus", "fp16");

const changedFraction = (before: ImageData, after: ImageData): number => {
  let changed = 0;
  for (let i = 0; i < before.data.length; i += 4) {
    if (before.data[i] !== after.data[i]
        || before.data[i + 1] !== after.data[i + 1]
        || before.data[i + 2] !== after.data[i + 2]) changed++;
  }
  return changed / (before.width * before.height);
};

for (const row of corpus.fixtures) {
  const unavailable = row.visibility === "private" && !__PRIVATE_FIXTURES_AVAILABLE__;
  test.skipIf(!__RUN_MODEL_CORPUS__ || unavailable)(
    `${row.id}: browser model matches detected box, size and trim contract`, async () => {
      const pdf = await fetch(`/${row.file}`);
      const source = await loadPdf(await pdf.arrayBuffer(), row.source_name, corpus.render_dpi);
      try {
        const scan = await source.loadPage(0);
        const skew = await estimateSkew(scan.image);
        const straight = rotate(scan.image, skew);
        const detected = await detect(sam, straight, () => {});

        const actual = [detected.box.x0, detected.box.y0, detected.box.x1, detected.box.y1];
        for (let i = 0; i < 4; i++) {
          const axisMm = i % 2 === 0 ? row.page_mm[0] : row.page_mm[1];
          expect(Math.abs(actual[i]! - row.expected.box[i]!) * axisMm)
            .toBeLessThanOrEqual(row.tolerance.box_mm);
        }

        const measured = measure(straight, detected.box, scan.mmPerPx)!;
        expect(Math.abs(measured[0] - row.expected.measured_mm[0]))
          .toBeLessThanOrEqual(row.tolerance.measured_mm);
        expect(Math.abs(measured[1] - row.expected.measured_mm[1]))
          .toBeLessThanOrEqual(row.tolerance.measured_mm);

        const beforeCanvas = cropCanvas(straight, detected.box);
        const before = beforeCanvas.getContext("2d")!
          .getImageData(0, 0, beforeCanvas.width, beforeCanvas.height);
        const afterCanvas = cropCanvas(straight, detected.box);
        await trimToMask(afterCanvas, detected.box, detected.mask, detected.maskSize, detected.box);
        const after = afterCanvas.getContext("2d")!
          .getImageData(0, 0, afterCanvas.width, afterCanvas.height);
        const trim = changedFraction(before, after);
        const trimDifference = Math.abs(trim - row.expected.trim_changed_fraction);
        expect(trimDifference).toBeLessThanOrEqual(row.tolerance.trim_changed_fraction);
        expect(trim).toBeLessThan(row.limits.trim_changed_fraction);
      } finally {
        await source.close();
      }
    },
    300_000,
  );
}
