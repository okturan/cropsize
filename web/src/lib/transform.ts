/** Rotate about the centre, same canvas size, white where the corners come in. */
export function rotate(img: ImageData, degrees: number): ImageData {
  if (Math.abs(degrees) < 0.01) return img;
  const src = new OffscreenCanvas(img.width, img.height);
  src.getContext("2d")!.putImageData(img, 0, 0);

  const out = new OffscreenCanvas(img.width, img.height);
  const ctx = out.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.translate(out.width / 2, out.height / 2);
  ctx.rotate((-degrees * Math.PI) / 180);
  ctx.drawImage(src, -img.width / 2, -img.height / 2);
  return ctx.getImageData(0, 0, out.width, out.height);
}

/** Quarter turns, lossless: no resampling, just a reorientation of the same pixels. */
export function quarterTurns(img: ImageData, quarters: number): ImageData {
  const k = ((quarters % 4) + 4) % 4;
  if (k === 0) return img;
  const swap = k % 2 === 1;
  const w = swap ? img.height : img.width;
  const h = swap ? img.width : img.height;

  const src = new OffscreenCanvas(img.width, img.height);
  src.getContext("2d")!.putImageData(img, 0, 0);
  const out = new OffscreenCanvas(w, h);
  const ctx = out.getContext("2d")!;
  ctx.translate(w / 2, h / 2);
  ctx.rotate((k * Math.PI) / 2);
  ctx.drawImage(src, -img.width / 2, -img.height / 2);
  return ctx.getImageData(0, 0, w, h);
}
