/**
 * Phone photos and scans of other documents: how detection finds each side and where it puts
 * the corners. Every outcome here was checked by eye on magnified overlays of every side, so
 * a change to the rules shows up as the list of documents it moved. Private fixtures; see
 * fixtures/README.md.
 */
import * as ortModule from "onnxruntime-web";
import { expect, test } from "vitest";
import { detect } from "../src/lib/detect";
import { estimateSkew, type SideKind } from "../src/lib/imaging-core";
import { Sam } from "../src/lib/sam";
import { loadPdf, loadRaster } from "../src/lib/source";
import { rotate } from "../src/lib/transform";

declare const __RUN_MODEL_CORPUS__: boolean;

Object.assign(globalThis, { ort: ortModule });
ortModule.env.wasm.numThreads = 4;
const sam = new Sam("base-plus", "fp16");

// sides top, right, bottom, left; corners top-left, top-right, bottom-right, bottom-left, in
// straightened pixels
const documents: Record<string, { kinds: SideKind[]; corners: number[] }> = {
  "bg-sheet-1.jpg": { kinds: ["border", "border", "border", "model"], corners: [4, 0, 966, 0, 966, 1288, 4, 1288] },
  "bg-sheet-2.jpg": { kinds: ["edge", "border", "border", "border"], corners: [0, 12, 966, 14, 966, 1288, 0, 1288] },
  "bg-sheet-3.jpg": { kinds: ["border", "border", "border", "model"], corners: [4, 0, 966, 0, 966, 1288, 4, 1288] },
  "bg-sheet-4.jpg": { kinds: ["border", "edge", "edge", "border"], corners: [0, 0, 923, 0, 962, 1242, 0, 1228] },
  "bg-sheet-5.jpg": { kinds: ["border", "model", "border", "border"], corners: [0, 0, 962, 0, 962, 1288, 0, 1288] },
  "bg-sheet-6.jpg": { kinds: ["border", "border", "border", "edge"], corners: [14, 0, 966, 0, 966, 1288, 0, 1288] },
  "bg-sheet-7.jpg": { kinds: ["border", "border", "border", "model"], corners: [0, 0, 966, 0, 966, 1288, 0, 1288] },
  "drawing.jpg": { kinds: ["border", "border", "border", "border"], corners: [0, 0, 1960, 0, 1960, 4032, 0, 4032] },
  "nihal-card-back.jpg": { kinds: ["edge", "edge", "edge", "edge"], corners: [2, 14, 1981, 4, 1970, 1253, 7, 1251] },
  "nihal-card-front.jpg": { kinds: ["edge", "border", "edge", "edge"], corners: [8, 6, 1988, 10, 1988, 1278, 2, 1265] },
  "okan-diploma.jpg": { kinds: ["border", "edge", "border", "edge"], corners: [59, 0, 3560, 0, 3560, 2518, 62, 2518] },
  "okan-licence.jpg": { kinds: ["model", "edge", "edge", "edge"], corners: [1, 18, 1884, 18, 1878, 1134, 6, 1131] },
  "scan-birth-register.pdf": { kinds: ["border", "border", "border", "border"], corners: [0, 0, 2550, 0, 2550, 3300, 0, 3300] },
  "scan-cedula-two-sides.pdf": { kinds: ["border", "model", "edge", "edge"], corners: [367, 0, 2072, 0, 2072, 2869, 372, 2872] },
  "scan-certificate.pdf": { kinds: ["border", "border", "border", "border"], corners: [0, 0, 3508, 0, 3508, 2480, 0, 2480] },
  "scan-civil-register.pdf": { kinds: ["border", "border", "border", "model"], corners: [0, 0, 3488, 0, 3488, 4592, 0, 4592] },
  "scan-consent.pdf": { kinds: ["outer-edge", "outer-edge", "outer-edge", "outer-edge"], corners: [11, 189, 2367, 179, 2366, 3486, 14, 3485] },
  "scan-contract.pdf": { kinds: ["border", "border", "border", "outer-edge"], corners: [132, 0, 2479, 0, 2479, 3508, 107, 3508] },
  "scan-deed.pdf": { kinds: ["edge", "edge", "border", "edge"], corners: [90, 91, 2209, 88, 2207, 3508, 86, 3508] },
  "scan-diploma.pdf": { kinds: ["edge", "edge", "edge", "edge"], corners: [106, 111, 3002, 122, 2998, 2028, 103, 2018] },
  "scan-family-booklet.pdf": { kinds: ["border", "border", "border", "border"], corners: [0, 0, 2683, 0, 2683, 2413, 0, 2413] },
  "scan-id-two-sides.pdf": { kinds: ["border", "border", "border", "border"], corners: [0, 0, 5304, 0, 5304, 7503, 0, 7503] },
  "scan-marriage.pdf": { kinds: ["border", "border", "border", "border"], corners: [0, 0, 2576, 0, 2576, 4528, 0, 4528] },
  "scan-passport-okan.pdf": { kinds: ["model", "border", "edge", "model"], corners: [19, 85, 4971, 85, 4971, 7173, 19, 7213] },
  "scan-passport-small.pdf": { kinds: ["edge", "edge", "edge", "edge"], corners: [509, 729, 1979, 726, 1974, 2783, 498, 2779] },
  "scan-passport-stamps.pdf": { kinds: ["edge", "edge", "border", "edge"], corners: [62, 27, 2145, 27, 2153, 1553, 75, 1553] },
  "scan-registro-civil.pdf": { kinds: ["border", "border", "border", "border"], corners: [0, 0, 2481, 0, 2481, 3507, 0, 3507] },
};

for (const [file, expected] of Object.entries(documents)) {
  test.skipIf(!__RUN_MODEL_CORPUS__)(`${file}: ${expected.kinds.join(", ")}`, async () => {
    const response = await fetch(`/private/docs/${file}`);
    if (!response.ok || response.headers.get("content-type")?.startsWith("text/html")) return;   // not on this machine
    const blob = await response.blob();
    const source = file.endsWith(".pdf")
      ? await loadPdf(await blob.arrayBuffer(), file)
      : await loadRaster(blob, file);
    try {
      const scan = await source.loadPage(0);
      const skew = await estimateSkew(scan.image);
      const straight = rotate(scan.image, skew);
      const found = await detect(sam, straight, skew, () => {});
      expect(found.kinds).toEqual(expected.kinds);
      const corners = found.quad.map((v, i) => v * (i % 2 === 0 ? straight.width : straight.height));
      corners.forEach((v, i) =>
        expect(Math.abs(v - expected.corners[i]!), `coordinate ${i}`).toBeLessThanOrEqual(3));
    } finally {
      await source.close();
    }
  }, 300_000);
}
