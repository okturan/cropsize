/**
 * One canvas per image, made once. Drawing an ImageData needs it on a canvas first, and
 * doing that per repaint copied the whole scan every time the crop moved: 48 MB per mouse
 * event on a phone photo. Images are never mutated in place here, only replaced, so a
 * canvas made from one stays valid for its lifetime.
 */
const canvases = new WeakMap<ImageData, OffscreenCanvas>();

export function canvasOf(image: ImageData): OffscreenCanvas {
  let canvas = canvases.get(image);
  if (!canvas) {
    canvas = new OffscreenCanvas(image.width, image.height);
    canvas.getContext("2d")!.putImageData(image, 0, 0);
    canvases.set(image, canvas);
  }
  return canvas;
}
