import { beforeAll, expect, test } from "vitest";
import { initImagingCore } from "../src/lib/imaging-core";
import { composeSheet, type Layout, type SheetItem } from "../src/lib/sheet";

beforeAll(initImagingCore);

const item = (width: number, height: number, mmPerPx: number | null, label = "x"): SheetItem => ({
  image: new ImageData(width, height), mmPerPx, label,
});
/** an 85.6 by 54 mm card scanned at 300 dpi */
const card = (label: string) => item(1011, 638, 25.4 / 300, label);

const a4: Layout = {
  sheet: "a4", landscape: false, fit: "true", preset: "id-card", marginMm: 8, outputDpi: "source",
};

test("two sides of a card stack on one A4 at their measured size, centred", () => {
  const sheet = composeSheet([card("front"), card("back")], a4);
  expect(sheet.pages).toHaveLength(1);
  expect(sheet.note).toBe("as measured on the scan");
  const [front, back] = sheet.pages[0]!.placements;
  expect(front!.wMm).toBeCloseTo(85.6, 1);
  expect(front!.hMm).toBeCloseTo(54, 1);
  expect(back!.wMm).toBeCloseTo(85.6, 1);
  // same column, front above back, a gap between them
  expect(front!.xMm).toBe(back!.xMm);
  expect(back!.yMm).toBeGreaterThan(front!.yMm + front!.hMm);
  // centred on the page
  expect(front!.xMm + front!.wMm / 2).toBeCloseTo(105, 0);
  const middle = (front!.yMm + back!.yMm + back!.hMm) / 2;
  expect(middle).toBeCloseTo(148.5, 0);
});

test("a known size forces every item to the preset", () => {
  const sheet = composeSheet(
    [item(2000, 1260, null, "front"), item(1990, 1250, null, "back")],
    { ...a4, fit: "preset" },
  );
  expect(sheet.note).toBe("forced to ID or bank card");
  for (const size of sheet.itemsMm) {
    expect(size[0]).toBeCloseTo(85.6, 1);
    expect(size[1]).toBeGreaterThan(53);
    expect(size[1]).toBeLessThanOrEqual(54);
  }
});

test("real size without a scale falls back to filling the sheet, keeping relative sizes", () => {
  const sheet = composeSheet([item(1000, 500, null), item(500, 500, null)], a4);
  expect(sheet.note).toBe("no scale available, so filling the sheet");
  const [big, small] = sheet.itemsMm;
  expect(big![0]).toBeCloseTo(2 * small![0], 0);
  expect(big![0]).toBeLessThanOrEqual(210 - 16);
  expect(big![1] + small![1]).toBeLessThanOrEqual(297 - 16);
});

test("items go side by side when a column is too tall, and overflow to more pages after that", () => {
  const spread = (label: string) => item(1476, 2079, 25.4 / 300, label); // 125 by 176 mm
  const two = composeSheet([spread("a"), spread("b")], { ...a4, landscape: true });
  expect(two.pages).toHaveLength(1);
  const [a, b] = two.pages[0]!.placements;
  expect(a!.yMm).toBe(b!.yMm);
  expect(b!.xMm).toBeGreaterThan(a!.xMm + a!.wMm);

  const three = composeSheet([spread("a"), spread("b"), spread("c")], a4);
  expect(three.pages.length).toBeGreaterThan(1);
  expect(three.note).toContain("pages");
  const placed = three.pages.flatMap(page => page.placements);
  expect(placed).toHaveLength(3);
  for (const p of placed) {
    expect(p.wMm).toBeCloseTo(125, 0);
    expect(p.xMm).toBeGreaterThanOrEqual(8);
    expect(p.yMm + p.hMm).toBeLessThanOrEqual(297 - 8 + 0.1);
  }
});

test("no sheet wraps the page around the column", () => {
  const sheet = composeSheet([card("front"), card("back")], { ...a4, sheet: "none" });
  expect(sheet.pages[0]!.pageMm[0]).toBeCloseTo(85.6 + 16, 1);
  expect(sheet.pages[0]!.pageMm[1]).toBeCloseTo(54 * 2 + 8 + 16, 1);
});
