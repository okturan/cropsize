/** The settings strip: how to print, on what, and at what resolution. */
import { ui } from "../dom";
import type { Fit, Layout, OutputDpi, PresetName, SheetName } from "../lib/sheet";

let fit: Fit = "true";

export function currentFit(): Fit { return fit; }

export function layout(): Layout {
  const resolution = ui.resolution.value;
  const margin = Number.parseFloat(ui.margin.value);
  return {
    sheet: ui.sheet.value as SheetName,
    landscape: ui.landscape.checked,
    fit,
    preset: ui.preset.value as PresetName,
    // An empty or negative field means no margin, and anything wider than a third of A5 is
    // a typo; clamping keeps the layout arithmetic finite either way.
    marginMm: Number.isFinite(margin) ? Math.min(Math.max(margin, 0), 40) : 0,
    outputDpi: (resolution === "source" ? "source" : Number(resolution)) as OutputDpi,
  };
}

export function tone(): { clip: number; stretch: boolean } {
  return { clip: Number.parseFloat(ui.clahe.value) || 0, stretch: ui.stretch.checked };
}

/** Wire the strip: `onLayout` for anything that moves the page, `onTone` for pixel changes. */
export function bindSettings(onLayout: () => void, onTone: () => void): void {
  for (const button of ui.fitButtons) {
    button.addEventListener("click", () => {
      fit = (button.dataset.fit ?? "true") as Fit;
      for (const other of ui.fitButtons) other.setAttribute("aria-pressed", String(other === button));
      ui.preset.hidden = fit !== "preset";
      onLayout();
    });
  }
  for (const control of [ui.sheet, ui.margin, ui.landscape, ui.preset, ui.resolution]) {
    control.addEventListener("change", onLayout);
  }
  let toneTimer: number | undefined;
  for (const control of [ui.clahe, ui.stretch]) {
    control.addEventListener("input", () => {
      const clip = Number.parseFloat(ui.clahe.value);
      ui.claheOut.textContent = clip > 0 ? clip.toFixed(1) : "off";
      window.clearTimeout(toneTimer);
      toneTimer = window.setTimeout(onTone, 200);
    });
  }
}

export function showSourceResolution(dpi: number | null): void {
  const option = ui.resolution.querySelector<HTMLOptionElement>('option[value="source"]');
  if (option) option.textContent = dpi ? `Match source pixels (${Math.round(dpi)} dpi)` : "Match source pixels";
}
