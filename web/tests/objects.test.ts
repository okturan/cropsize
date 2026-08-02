import { PDFDocument } from "pdf-lib";
import { beforeAll, expect, test } from "vitest";
import { initImagingCore } from "../src/lib/imaging-core";
import {
  candidateFromMask,
  findObjectGroups,
  groupCandidates,
  mergeObjects,
  measuredObject,
  type ObjectCandidate,
} from "../src/lib/objects";
import type { Sam } from "../src/lib/sam";
import { exportPdf, mergePdfPages, outputPixelSize, type Layout } from "../src/lib/sheet";
import type { Scan } from "../src/lib/source";

beforeAll(initImagingCore);

const rectangleMask = (size: number, angleDegrees = 0) => {
  const mask = new Float32Array(size * size).fill(-1);
  const angle = angleDegrees * Math.PI / 180;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - size / 2, dy = y - size / 2;
      const rx = dx * Math.cos(angle) + dy * Math.sin(angle);
      const ry = -dx * Math.sin(angle) + dy * Math.cos(angle);
      if (Math.abs(rx) <= size * 0.24 && Math.abs(ry) <= size * 0.12) {
        mask[y * size + x] = 1;
      }
    }
  }
  return mask;
};

test("shape filtering fits each item with its own angle", async () => {
  const item = await candidateFromMask(rectangleMask(64, 20), 64, 640, 640, 0.95);
  expect(item).not.toBeNull();
  expect(Math.abs(Math.abs(item!.angle) - 20)).toBeLessThan(2);
  const measured = measuredObject(item!, new ImageData(640, 640), 0.1);
  expect(measured![0]).toBeGreaterThan(measured![1]);

  const sliver = new Float32Array(64 * 64).fill(-1);
  for (let y = 0; y < 64; y++) sliver[y * 64 + 2] = 1;
  expect(await candidateFromMask(sliver, 64, 640, 640, 0.99)).toBeNull();
});

test("grouping uses containment as well as overlap", () => {
  const item = (id: number, width: number, height: number, score: number): ObjectCandidate => ({
    id, cx: 0.5, cy: 0.5, width, height, angle: 0, score,
    mask: new Float32Array(), maskSize: 0, alternatives: [],
  });
  const sleeve = item(1, 0.7, 0.7, 0.97);
  const page = item(2, 0.35, 0.65, 0.96);
  const separate = { ...item(3, 0.2, 0.2, 0.9), cx: 0.1, cy: 0.1 };
  const groups = groupCandidates([page, separate, sleeve]);
  expect(groups).toHaveLength(2);
  expect(groups.find(group => group.some(candidate => candidate.id === 1))).toHaveLength(2);
});

test("the point grid encodes once and groups repeated proposals", async () => {
  const mask = rectangleMask(64);
  let encodes = 0, decodes = 0;
  const fake = {
    ready: async () => {},
    encode: async (image: ImageData) => {
      encodes++;
      return { tensors: {}, width: image.width, height: image.height };
    },
    decodeAll: async () => {
      decodes++;
      return [{ mask, size: 64, score: 0.95 }];
    },
  } as unknown as Sam;
  const groups = await findObjectGroups(fake, new ImageData(640, 640), () => {}, 2);
  expect(encodes).toBe(1);
  expect(decodes).toBe(4);
  expect(groups).toHaveLength(1);
  expect(groups[0]![0]!.alternatives).toHaveLength(3);
});

test("several selected items export as one PDF page each", async () => {
  const image = new ImageData(120, 80);
  image.data.fill(255);
  const scan: Scan = {
    image, mmPerPx: 0.1, pageMm: [12, 8], dpi: 254,
    origin: "synthetic objects test", name: "objects",
  };
  const layout: Layout = {
    sheet: "a4", landscape: false, fit: "true", preset: "id-card", marginMm: 8,
    outputDpi: "source",
  };
  const box = { x0: 0, y0: 0, x1: 1, y1: 1 };
  const first = await exportPdf(scan, box, layout);
  const merged = await mergePdfPages([first, first, first]);
  const pdf = await PDFDocument.load(await merged.arrayBuffer());
  expect(pdf.getPageCount()).toBe(3);
});

test("output resolution defaults to source pixels and explicit dpi keeps physical size", () => {
  const image = new ImageData(1200, 800);
  const scan: Scan = {
    image, mmPerPx: 25.4 / 300, pageMm: [101.6, 67.7], dpi: 300,
    origin: "300 dpi fixture", name: "resolution",
  };
  const box = { x0: 0.25, y0: 0.25, x1: 0.75, y1: 0.75 };
  const layout: Layout = {
    sheet: "none", landscape: false, fit: "true", preset: "id-card", marginMm: 0,
    outputDpi: "source",
  };
  expect(outputPixelSize(scan, box, layout)).toEqual([600, 400]);
  expect(outputPixelSize(scan, box, { ...layout, outputDpi: 150 })).toEqual([300, 200]);
  expect(outputPixelSize(scan, box, { ...layout, outputDpi: 600 })).toEqual([1200, 801]);
});

test("merged items retain their original parts for undo", async () => {
  const image = new ImageData(1000, 600);
  const part = (id: number, cx: number): ObjectCandidate => ({
    id, cx, cy: 0.5, width: 0.3, height: 0.5, angle: 0, score: 0.9,
    mask: new Float32Array(), maskSize: 0, alternatives: [],
  });
  const parts = [part(10, 0.3), part(11, 0.7)];
  const merged = await mergeObjects(image, parts);
  expect(merged.mergedParts).toEqual(parts);
  expect(merged.cx).toBeCloseTo(0.5, 2);
  expect(merged.width).toBeCloseTo(0.7, 2);
  expect(merged.height).toBeCloseTo(0.5, 2);
});
