import { describe, expect, test } from "vitest";
import type { Box } from "../src/lib/detect";
import { estimateSkew as estimateSkewCore, frameInCore } from "../src/lib/imaging-core";
import { measure } from "../src/lib/sheet";
import { loadPdf } from "../src/lib/source";

declare const __PRIVATE_FIXTURES_AVAILABLE__: boolean;

interface CorpusRow {
  id: string;
  visibility: "public" | "private";
  file: string;
  source_name: string;
  page_mm: [number, number];
  expected: {
    skew_degrees: number;
    box: [number, number, number, number];
    measured_mm: [number, number];
    trim_changed_fraction: number;
  };
  tolerance: {
    skew_degrees: number;
    box_mm: number;
    measured_mm: number;
    trim_changed_fraction: number;
  };
  limits: { trim_changed_fraction: number };
}

interface Corpus {
  version: number;
  render_dpi: number;
  fixtures: CorpusRow[];
}

const response = await fetch("/corpus.json");
if (!response.ok) throw new Error(`corpus manifest: HTTP ${response.status}`);
const corpus = await response.json() as Corpus;

const boxFrom = ([x0, y0, x1, y1]: CorpusRow["expected"]["box"]): Box =>
  ({ x0, y0, x1, y1 });

describe("golden document corpus", () => {
  for (const row of corpus.fixtures) {
    const unavailable = row.visibility === "private" && !__PRIVATE_FIXTURES_AVAILABLE__;

    test.skipIf(unavailable)(`${row.id}: WASM deskew and physical scale`, async () => {
      const pdf = await fetch(`/${row.file}`);
      expect(pdf.ok, `${row.file} should be installed`).toBe(true);
      const source = await loadPdf(await pdf.arrayBuffer(), row.source_name, corpus.render_dpi);
      try {
        const scan = await source.loadPage(0);
        expect(scan.pageMm).not.toBeNull();
        expect(Math.abs(scan.pageMm![0] - row.page_mm[0])).toBeLessThanOrEqual(0.2);
        expect(Math.abs(scan.pageMm![1] - row.page_mm[1])).toBeLessThanOrEqual(0.2);

        const coreSkew = await estimateSkewCore(scan.image);
        expect(
          Math.abs(coreSkew - row.expected.skew_degrees),
          `${row.id} core skew: got ${coreSkew}, expected ${row.expected.skew_degrees}`,
        ).toBeLessThanOrEqual(row.tolerance.skew_degrees);

        const measured = measure(scan.image, boxFrom(row.expected.box), scan.mmPerPx);
        expect(measured).not.toBeNull();
        expect(Math.abs(measured![0] - row.expected.measured_mm[0]))
          .toBeLessThanOrEqual(row.tolerance.measured_mm);
        expect(Math.abs(measured![1] - row.expected.measured_mm[1]))
          .toBeLessThanOrEqual(row.tolerance.measured_mm);
      } finally {
        await source.close();
      }
    });
  }

  test("a frame remains in one WASM allocation across repeated estimates", async () => {
    const pdf = await fetch(`/${corpus.fixtures[0]!.file}`);
    const source = await loadPdf(
      await pdf.arrayBuffer(), corpus.fixtures[0]!.source_name, corpus.render_dpi,
    );
    try {
      const scan = await source.loadPage(0);
      const frame = await frameInCore(scan.image);
      try {
        const pointer = frame.pixels_ptr();
        const length = frame.pixels_len();
        const buffer = frame.pixels_view().buffer;
        expect(frame.estimate_skew()).toBe(frame.estimate_skew());
        expect(frame.pixels_ptr()).toBe(pointer);
        expect(frame.pixels_len()).toBe(length);
        expect(frame.pixels_view().buffer).toBe(buffer);
      } finally {
        frame.free();
      }
    } finally {
      await source.close();
    }
  });
});
