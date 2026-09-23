import { expect, test } from "vitest";
import type { DetectResult } from "../src/lib/detect";
import { fitFor, turnFit } from "../src/lib/fit";
import { exifFocal35 } from "../src/lib/source";

const [W, H] = [4032, 3024];
const DIAGONAL = Math.hypot(W, H);

/**
 * A w by h rectangle photographed by a camera of focal length `f` pixels that orbits its
 * centre: tipped `rx` degrees forward and turned `ry` degrees aside. Its corners, normalised
 * to the frame, top-left clockwise.
 */
function photographed(w: number, h: number, rx: number, ry: number, f: number): number[] {
  const [a, b] = [(rx * Math.PI) / 180, (ry * Math.PI) / 180];
  // R = Ry Rx; the plane's x and y axes in camera space are its first two columns
  const r1 = [Math.cos(b), 0, -Math.sin(b)];
  const r2 = [Math.sin(b) * Math.sin(a), Math.cos(a), Math.cos(b) * Math.sin(a)];
  return [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]].flatMap(([x, y]) => {
    const p = [0, 1, 2].map(i => r1[i]! * x! + r2[i]! * y! + (i === 2 ? f : 0));
    return [(f * p[0]! / p[2]! + W / 2) / W, (f * p[1]! / p[2]! + H / 2) / H];
  });
}

const found = (quad: number[]): DetectResult => ({
  box: { x0: 0, y0: 0, x1: 1, y1: 1 }, quad, kinds: ["edge", "edge", "edge", "edge"],
  whole: false, score: 1, method: "frame", mask: new Float32Array(), maskSize: 0,
});
const frame = { width: W, height: H } as ImageData;

test("a page photographed at an angle keeps its own proportions", () => {
  // both pairs of sides converge, so the corners fix the lens themselves
  const quad = photographed(2100, 1500, 25, 12, 0.9 * DIAGONAL);
  const fit = fitFor(found(quad), frame)!;
  expect(fit.card).toBe(false);
  expect(fit.aspect).toBeCloseTo(1.4, 2);
});

test("a page tipped straight back needs the lens: from the photo, or a phone's by default", () => {
  const phone = photographed(2100, 1500, 30, 0, 0.6 * DIAGONAL);
  expect(fitFor(found(phone), frame)!.aspect).toBeCloseTo(1.4, 2);
  const tele = photographed(2100, 1500, 20, 0, 1.2 * DIAGONAL);
  expect(fitFor(found(tele), frame, 1.2 * DIAGONAL)!.aspect).toBeCloseTo(1.4, 2);
  // without the lens a telephoto's tipped page is taken for a phone's, and comes out stretched
  expect(fitFor(found(tele), frame)!.aspect).toBeGreaterThan(1.4);
});

test("an ID-1 card photographed at an angle is a card, and a page photographed alike is not", () => {
  const card = fitFor(found(photographed(1712, 1080, 25, 10, 0.6 * DIAGONAL)), frame)!;
  expect(card.card).toBe(true);
  expect(card.aspect).toBeCloseTo(85.6 / 54, 6);
  const tipped = fitFor(found(photographed(1712, 1080, 30, 0, 0.6 * DIAGONAL)), frame)!;
  expect(tipped.card).toBe(true);
  const page = fitFor(found(photographed(2100, 1500, 30, 0, 0.6 * DIAGONAL)), frame)!;
  expect(page.card).toBe(false);
});

test("a scan turned on the glass is its sides' ratio, and a quarter turn swaps it", () => {
  const t = (3 * Math.PI) / 180;
  const quad = [[-1000, -700], [1000, -700], [1000, 700], [-1000, 700]].flatMap(([x, y]) => [
    (x! * Math.cos(t) - y! * Math.sin(t) + W / 2) / W, (x! * Math.sin(t) + y! * Math.cos(t) + H / 2) / H]);
  const fit = fitFor(found(quad), frame)!;
  expect(fit.aspect).toBeCloseTo(2000 / 1400, 6);
  expect(turnFit(fit, 1).aspect).toBeCloseTo(1400 / 2000, 6);
  expect(turnFit(fit, 2).aspect).toBeCloseTo(2000 / 1400, 6);
});

/** A JPEG that is only its EXIF block: a 35 mm focal length and the frame it was taken at. */
function jpegWithExif(focal35: number, taken: [number, number]): Uint8Array {
  const tiff = new DataView(new ArrayBuffer(8 + 18 + 42));
  tiff.setUint16(0, 0x4949);                                 // "II": little-endian
  tiff.setUint16(2, 42, true);
  tiff.setUint32(4, 8, true);                               // IFD0 at 8
  tiff.setUint16(8, 1, true);                               // one entry: the EXIF pointer
  tiff.setUint16(10, 0x8769, true);
  tiff.setUint16(12, 4, true);
  tiff.setUint32(14, 1, true);
  tiff.setUint32(18, 26, true);
  tiff.setUint16(26, 3, true);                              // EXIF IFD at 26: three entries
  const entry = (i: number, tag: number, type: number, value: number) => {
    const o = 28 + 12 * i;
    tiff.setUint16(o, tag, true);
    tiff.setUint16(o + 2, type, true);
    tiff.setUint32(o + 4, 1, true);
    if (type === 3) tiff.setUint16(o + 8, value, true);
    else tiff.setUint32(o + 8, value, true);
  };
  entry(0, 0xa405, 3, focal35);
  entry(1, 0xa002, 4, taken[0]);
  entry(2, 0xa003, 4, taken[1]);
  const body = new Uint8Array(tiff.buffer);
  const length = 2 + 6 + body.length;
  return Uint8Array.from([
    0xff, 0xd8, 0xff, 0xe1, length >> 8, length & 0xff, ...new TextEncoder().encode("Exif\0\0"), ...body,
    0xff, 0xda, 0, 2,
  ]);
}

test("the lens is read from a photo's EXIF, turned or scaled, but not from a crop of it", () => {
  const exif = jpegWithExif(26, [4032, 3024]);
  expect(exifFocal35(exif, 4032, 3024)).toBe(26);
  expect(exifFocal35(exif, 3024, 4032)).toBe(26);           // shown upright
  expect(exifFocal35(exif, 2016, 1512)).toBe(26);           // scaled down whole
  expect(exifFocal35(exif, 1988, 1278)).toBeNull();         // cropped: the lens no longer fits
  expect(exifFocal35(Uint8Array.from([0xff, 0xd8, 0xff, 0xda, 0, 2]), 4032, 3024)).toBeNull();
  expect(exifFocal35(Uint8Array.from([0x89, 0x50, 0x4e, 0x47]), 4032, 3024)).toBeNull();
});
