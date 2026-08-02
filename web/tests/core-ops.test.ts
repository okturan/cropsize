import { beforeAll, expect, test } from "vitest";
import {
  applyTone,
  cleanMask,
  extractRotated,
  initImagingCore,
  minimumAreaRect,
  planLayout,
  snapEdges,
  trimImageToMask,
} from "../src/lib/imaging-core";

beforeAll(initImagingCore);

const solidImage = (width: number, height: number, value: number) => {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = value; data[i + 1] = value; data[i + 2] = value; data[i + 3] = 255;
  }
  return new ImageData(data, width, height);
};

test("WASM convex hull bridges separated mask components", async () => {
  const size = 16;
  const mask = new Float32Array(size * size).fill(-1);
  for (let y = 3; y < 13; y++) {
    for (let x = 2; x < 6; x++) mask[y * size + x] = 1;
    for (let x = 10; x < 14; x++) mask[y * size + x] = 1;
  }
  const cleaned = await cleanMask(mask, size);
  expect(cleaned[8 * size + 3]).toBeGreaterThan(0);
  expect(cleaned[8 * size + 8]).toBeGreaterThan(0);
  expect(cleaned[8 * size + 12]).toBeGreaterThan(0);
});

test("WASM trim leaves a hand crop in the document interior unchanged", async () => {
  const size = 10;
  const mask = new Float32Array(size * size).fill(-1);
  for (let y = 1; y < 9; y++) {
    for (let x = 1; x < 9; x++) {
      const dx = x - 4.5, dy = y - 4.5;
      if (dx * dx + dy * dy <= 13) mask[y * size + x] = 1;
    }
  }
  const source = solidImage(40, 40, 120);
  const maskBox = { x0: 0.1, y0: 0.1, x1: 0.9, y1: 0.9 };
  const automatic = await trimImageToMask(source, maskBox, mask, size, maskBox);
  const hand = await trimImageToMask(
    source, { x0: 0.4, y0: 0.4, x1: 0.6, y1: 0.6 }, mask, size, maskBox,
  );
  expect(Array.from(automatic.data).filter((value, index) => index % 4 !== 3 && value === 255).length)
    .toBeGreaterThan(0);
  expect(Array.from(hand.data).filter((value, index) => index % 4 !== 3 && value !== 120))
    .toHaveLength(0);
});

test("WASM edge snap keeps its outward bias", async () => {
  const image = solidImage(200, 160, 255);
  for (let y = 32; y < 128; y++) {
    for (let x = 40; x < 160; x++) {
      const offset = (y * image.width + x) * 4;
      image.data[offset] = 180; image.data[offset + 1] = 180; image.data[offset + 2] = 180;
    }
    const line = (y * image.width + 55) * 4;
    image.data[line] = 0; image.data[line + 1] = 0; image.data[line + 2] = 0;
  }
  const result = await snapEdges(
    image, { x0: 0.22, y0: 0.22, x1: 0.78, y1: 0.78 }, 0.08, 0.5,
  );
  expect(Math.abs(result.x0 - 0.2)).toBeLessThanOrEqual(0.01);
  expect(Math.abs(result.x1 - 0.8)).toBeLessThanOrEqual(0.01);
});

test("WASM layout fits a tall crop inside the whole preset box", () => {
  const result = planLayout({
    width: 100,
    height: 200,
    box: { x0: 0, y0: 0, x1: 1, y1: 1 },
    mmPerPx: null,
    sheetMm: [210, 297],
    fit: 1,
    presetMm: [125, 88],
    marginMm: 8,
  });
  expect(result.contentMm).toEqual([44, 88]);
});

test("WASM tone, minimum rectangle and extraction cross the browser binding", async () => {
  const image = solidImage(50, 60, 160);
  const toned = applyTone(image, 0, true);
  expect(toned.width).toBe(50);
  expect(toned.data[3]).toBe(255);

  const mask = new Float32Array(50 * 60).fill(-1);
  for (let y = 20; y < 40; y++) {
    for (let x = 10; x < 30; x++) mask[y * 50 + x] = 1;
  }
  const rect = await minimumAreaRect(mask, 50, 60);
  expect(rect).not.toBeNull();
  const extracted = await extractRotated(image, rect!);
  expect(extracted.width).toBe(Math.round(rect![2]));
  expect(extracted.height).toBe(Math.round(rect![3]));
});
