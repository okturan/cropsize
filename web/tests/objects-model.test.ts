import * as ortModule from "onnxruntime-web";
import { expect, test } from "vitest";
import { findObjectGroups, measuredObject } from "../src/lib/objects";
import { estimateSkew } from "../src/lib/imaging-core";
import { Sam } from "../src/lib/sam";
import { loadPdf } from "../src/lib/source";
import { rotate } from "../src/lib/transform";

declare const __RUN_MODEL_CORPUS__: boolean;
declare const __PRIVATE_FIXTURES_AVAILABLE__: boolean;

Object.assign(globalThis, { ort: ortModule });
ortModule.env.wasm.numThreads = 4;
const sam = new Sam("base-plus", "fp16");

const expected = [
  { size: [85.6, 54.0] as const, angle: -7 },
  { size: [58.0, 78.0] as const, angle: 10 },
  { size: [72.0, 50.0] as const, angle: 3 },
];

function sizeDistance(actual: [number, number], wanted: readonly [number, number]): number {
  const direct = Math.abs(actual[0] - wanted[0]) + Math.abs(actual[1] - wanted[1]);
  const swapped = Math.abs(actual[0] - wanted[1]) + Math.abs(actual[1] - wanted[0]);
  return Math.min(direct, swapped);
}

const ordered = (size: readonly [number, number]): [number, number] => (
  size[0] <= size[1] ? [size[0], size[1]] : [size[1], size[0]]
);

test.skipIf(!__RUN_MODEL_CORPUS__)(
  "one flatbed scan becomes three independently measured and rotated objects",
  async () => {
    const pdf = await fetch("/public/objects-flatbed.pdf");
    const source = await loadPdf(await pdf.arrayBuffer(), "objects-flatbed.pdf", 150);
    try {
      const scan = await source.loadPage(0);
      const groups = await findObjectGroups(sam, scan.image, () => {});
      const actual = groups.map(group => {
        const item = group[0]!;
        return { item, size: measuredObject(item, scan.image, scan.mmPerPx)! };
      });

      expect(actual).toHaveLength(3);
      for (const wanted of expected) {
        const match = actual.reduce((best, candidate) => (
          sizeDistance(candidate.size, wanted.size) < sizeDistance(best.size, wanted.size)
            ? candidate : best
        ));
        const actualSize = ordered(match.size);
        const expectedSize = ordered(wanted.size);
        expect(Math.abs(actualSize[0] - expectedSize[0])).toBeLessThanOrEqual(1);
        expect(Math.abs(actualSize[1] - expectedSize[1])).toBeLessThanOrEqual(1);
        expect(Math.abs(match.item.angle - wanted.angle)).toBeLessThanOrEqual(0.2);
      }
    } finally {
      await source.close();
    }
  },
  300_000,
);

test.skipIf(!__RUN_MODEL_CORPUS__ || !__PRIVATE_FIXTURES_AVAILABLE__)(
  "the passport sleeve keeps its overlapping page alternatives",
  async () => {
    const pdf = await fetch("/private/irene.pdf");
    const source = await loadPdf(await pdf.arrayBuffer(), "irene pspt.pdf", 300);
    try {
      const scan = await source.loadPage(0);
      const straight = rotate(scan.image, await estimateSkew(scan.image));
      const groups = await findObjectGroups(sam, straight, () => {});
      const readings = groups.map(group => (group[0]!.choices ?? group)
        .map(item => measuredObject(item, straight, scan.mmPerPx)!));
      const flat = readings.flat();
      const isPage = ([width, height]: [number, number]) => (
        width >= 115 && width <= 142 && height >= 84 && height <= 102
      );
      const isSleeve = ([width, height]: [number, number]) => (
        width >= 124 && width <= 132 && height >= 184 && height <= 190
      );
      const isFalseSpread = ([width, height]: [number, number]) => (
        width >= 120 && width <= 130 && height >= 168 && height <= 182
      );
      expect(groups.length).toBeGreaterThanOrEqual(2);
      expect(flat.filter(isPage).length).toBeGreaterThanOrEqual(2);
      expect(flat.some(isSleeve)).toBe(true);
      expect(flat.some(isFalseSpread)).toBe(false);
    } finally {
      await source.close();
    }
  },
  300_000,
);
