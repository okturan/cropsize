/**
 * Phone photos of cards. On a plain surface the box prompt answers with the whole frame and a
 * single centre point answers with a speck of text on the card, so this locks in the
 * multi-prompt vote that finds the card itself; card-photo.test.ts then checks the fitted
 * edges. The photos are private fixtures; see fixtures/README.md.
 */
import * as ortModule from "onnxruntime-web";
import { expect, test } from "vitest";
import { detect } from "../src/lib/detect";
import { estimateSkew } from "../src/lib/imaging-core";
import { Sam } from "../src/lib/sam";
import { loadRaster } from "../src/lib/source";
import { rotate } from "../src/lib/transform";

declare const __RUN_MODEL_CORPUS__: boolean;

Object.assign(globalThis, { ort: ortModule });
ortModule.env.wasm.numThreads = 4;
const sam = new Sam("base-plus", "fp16");

const photos = [
  // a card on a plain surface: the box prompt answers with the surface
  { file: "private/okan-id-front.jpg", box: [0.168, 0.336, 0.875, 0.672] },
  { file: "private/okan-id-back.jpg", box: [0.105, 0.313, 0.895, 0.688] },
  // photos taken tight on a card: the frame is the card, and the vote must not swap it for
  // the chip or the QR code
  { file: "private/irene-ikamet-back.jpg", box: [0.011, 0.002, 0.988, 0.992] },
  { file: "private/ilkyaz-id-back.jpg", box: [0.014, 0.002, 0.988, 0.980] },
];

for (const photo of photos) {
  test.skipIf(!__RUN_MODEL_CORPUS__)(`${photo.file}: the card, not the surface or a detail`, async () => {
    const response = await fetch(`/${photo.file}`);
    if (!response.headers.get("content-type")?.startsWith("image/")) return;   // not on this machine
    const source = await loadRaster(await response.blob(), photo.file);
    const scan = await source.loadPage(0);
    const straight = rotate(scan.image, await estimateSkew(scan.image));
    const found = await detect(sam, straight, () => {});
    const actual = [found.box.x0, found.box.y0, found.box.x1, found.box.y1];
    for (let i = 0; i < 4; i++) expect(Math.abs(actual[i]! - photo.box[i]!)).toBeLessThan(0.03);
    // a card is wider than tall, about 1.585 to 1
    const aspect = ((found.box.x1 - found.box.x0) * straight.width)
      / ((found.box.y1 - found.box.y0) * straight.height);
    expect(aspect).toBeGreaterThan(1.5);
    expect(aspect).toBeLessThan(1.7);
  }, 300_000);
}
