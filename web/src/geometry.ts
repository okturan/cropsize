import type { Box } from "./lib/detect";

export function turnBox(box: Box, quarters: number): Box {
  const k = ((quarters % 4) + 4) % 4;
  if (k === 1) return { x0: 1 - box.y1, y0: box.x0, x1: 1 - box.y0, y1: box.x1 };
  if (k === 2) return {
    x0: 1 - box.x1, y0: 1 - box.y1, x1: 1 - box.x0, y1: 1 - box.y0,
  };
  if (k === 3) return { x0: box.y0, y0: 1 - box.x1, x1: box.y1, y1: 1 - box.x0 };
  return { ...box };
}

export function turnMask(mask: Float32Array, size: number, quarters: number): Float32Array {
  const k = ((quarters % 4) + 4) % 4;
  if (k === 0) return mask;
  const output = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const value = mask[y * size + x] ?? -1;
      const nextX = k === 1 ? size - 1 - y : k === 2 ? size - 1 - x : y;
      const nextY = k === 1 ? x : k === 2 ? size - 1 - y : size - 1 - x;
      output[nextY * size + nextX] = value;
    }
  }
  return output;
}
