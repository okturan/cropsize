/**
 * Phone photos of ID-1 cards: after detection, the card's four edges are measured at full
 * resolution and the card is squared up. The expected corners were checked by eye on
 * magnified overlays: on the card face, outside the glare and the shadow, on every side.
 * Private fixtures; see fixtures/README.md.
 */
import * as ortModule from "onnxruntime-web";
import { expect, test } from "vitest";
import { extractCard, fitCard } from "../src/lib/card";
import { detect } from "../src/lib/detect";
import { estimateSkew } from "../src/lib/imaging-core";
import { Sam } from "../src/lib/sam";
import { loadRaster } from "../src/lib/source";
import { rotate } from "../src/lib/transform";

declare const __RUN_MODEL_CORPUS__: boolean;

Object.assign(globalThis, { ort: ortModule });
ortModule.env.wasm.numThreads = 4;
const sam = new Sam("base-plus", "fp16");

// corners top-left, top-right, bottom-right, bottom-left, in straightened-photo pixels
const cards: Record<string, number[]> = {
  "okan-id-front": [506, 1354, 2650, 1353, 2655, 2702, 504, 2702],
  "okan-id-back": [316, 1269, 2701, 1260, 2716, 2768, 317, 2768],
  "irene-ikamet-front": [19, 10, 1405, 15, 1414, 892, 10, 902],
  "irene-ikamet-back": [16, 4, 1420, -1, 1424, 887, 17, 887],
  "ilkyaz-id-front": [27, 6, 1334, 8, 1340, 832, 26, 840],
  "ilkyaz-id-back": [18, 4, 1446, 1, 1448, 903, 24, 911],
};

for (const [name, expected] of Object.entries(cards)) {
  test.skipIf(!__RUN_MODEL_CORPUS__)(`${name}: edges measured, card squared up`, async () => {
    const response = await fetch(`/private/${name}.jpg`);
    if (!response.headers.get("content-type")?.startsWith("image/")) return;   // not on this machine
    const scan = await (await loadRaster(await response.blob(), name)).loadPage(0);
    const skew = await estimateSkew(scan.image);
    const straight = rotate(scan.image, skew);
    const found = await detect(sam, straight, () => {});
    const fit = await fitCard(straight, found.box, skew);
    expect(fit, "the card's edges should be found").not.toBeNull();
    const corners = fit!.quad.map((v, i) => v * (i % 2 === 0 ? straight.width : straight.height));
    corners.forEach((v, i) => expect(Math.abs(v - expected[i]!), `coordinate ${i}`).toBeLessThanOrEqual(3));

    const { image, radii } = await extractCard(straight, fit!);
    expect(Math.abs(image.width / image.height - 85.6 / 54)).toBeLessThan(0.005);
    const mm = image.width / 85.6;
    for (const r of radii) {
      expect(r / mm).toBeGreaterThan(2.3);
      expect(r / mm).toBeLessThan(4.5);
    }
    // the corners outside the rounding are paper white
    for (const [x, y] of [[0, 0], [image.width - 1, 0], [0, image.height - 1], [image.width - 1, image.height - 1]]) {
      const o = (y! * image.width + x!) * 4;
      expect([image.data[o], image.data[o + 1], image.data[o + 2]]).toEqual([255, 255, 255]);
    }
  }, 300_000);
}
