import { expect, test } from "vitest";
import { turnBox, turnMask } from "../src/geometry";

test("quarter turns preserve a normalized crop through a full revolution", () => {
  const original = { x0: 0.1, y0: 0.2, x1: 0.6, y1: 0.8 };
  let turned = original;
  for (let i = 0; i < 4; i++) turned = turnBox(turned, 1);
  expect(turned.x0).toBeCloseTo(original.x0, 12);
  expect(turned.y0).toBeCloseTo(original.y0, 12);
  expect(turned.x1).toBeCloseTo(original.x1, 12);
  expect(turned.y1).toBeCloseTo(original.y1, 12);
});

test("quarter turns move mask cells in the same direction as the crop", () => {
  const mask = Float32Array.from([1, 2, 3, 4]);
  expect(Array.from(turnMask(mask, 2, 1))).toEqual([3, 1, 4, 2]);
  expect(Array.from(turnMask(mask, 2, 2))).toEqual([4, 3, 2, 1]);
  expect(Array.from(turnMask(mask, 2, 3))).toEqual([2, 4, 1, 3]);
});
