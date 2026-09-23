/**
 * The open document: its pages, the current scan, detection, several-items mode and the
 * sheet tray. Every long action runs as one progress run with its own steps, and model work
 * goes through the model queue so it never overlaps.
 */
import { ui } from "./dom";
import { turnBox, turnMask } from "./geometry";
import { fitFor, turnFit, type Fit } from "./lib/fit";
import { detect, type DetectResult } from "./lib/detect";
import { applyTone, estimateSkew } from "./lib/imaging-core";
import {
  findObjectGroups, mergeObjects, refineObject, type ObjectCandidate,
} from "./lib/objects";
import type { DocumentSource } from "./lib/source";
import { quarterTurns, rotate } from "./lib/transform";
import type { ModelController } from "./model";
import { defaultBox, state as S, type Note, type PageState } from "./state";
import { renderObjects, renderTray, type ObjectActions } from "./ui/lists";
import type { ProgressPanel, ProgressRun } from "./ui/progress";
import { showSourceResolution, tone } from "./ui/settings";

interface Deps {
  model: ModelController;
  progress: ProgressPanel;
  draw(): void;
  refresh(): void;
  addLiveToSheet(): Promise<unknown>;
  /** called once the app view is on screen, before the first page is drawn */
  onShown(): void;
}

/** Let the browser paint before a stretch of synchronous work. */
const paint = () => new Promise<void>(resolve =>
  requestAnimationFrame(() => window.setTimeout(resolve, 0)));

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function createWorkspace(deps: Deps) {
  const { model, progress } = deps;
  const merging = new Set<number>();
  let note: Note = { text: "" };
  let loading = false;

  /* ------------------------------------------------------------------ status line */
  function setNote(next: Note) {
    note = next;
    ui.note.textContent = next.text;
    ui.note.title = next.detail ? `${next.text} ${next.detail}` : next.text;
    ui.note.classList.toggle("warn", !!next.warn);
  }

  function update() {
    renderObjectsPanel();
    deps.draw();
    deps.refresh();
    remember();
  }

  /* ------------------------------------------------------------------------ pages */
  function remember() {
    if (!S.scan || !S.original) return;
    const { image: _image, ...scan } = S.scan;
    S.pages.set(S.page, {
      scan,
      original: S.original,
      skew: S.skew,
      mask: S.mask ? { ...S.mask, box: { ...S.mask.box } } : null,
      box: { ...S.box },
      fit: S.fit,
      note,
      objects: S.objects,
      selectedObjectId: S.selectedObjectId,
    });
  }

  function showSkew() {
    ui.skew.value = String(S.skew);
    ui.skewOut.textContent = S.skew.toFixed(1);
  }

  function retone() {
    if (!S.scan) return;
    const { clip, stretch } = tone();
    S.toned = clip > 0 || stretch ? applyTone(S.scan.image, clip, stretch) : null;
  }

  function showPage(saved: PageState, index: number) {
    S.page = index;
    S.original = saved.original;
    S.skew = saved.skew;
    S.scan = { ...saved.scan, image: rotate(saved.original, saved.skew) };
    S.mask = saved.mask ? { ...saved.mask, box: { ...saved.mask.box } } : null;
    S.box = { ...saved.box };
    S.fit = saved.fit;
    S.objects = saved.objects;
    S.selectedObjectId = saved.selectedObjectId;
    S.drag = null;
    merging.clear();
    ui.pageSelect.value = String(index);
    ui.fileName.textContent = saved.scan.name;
    ui.fileName.title = saved.scan.name;
    showSkew();
    showSourceResolution(saved.scan.mmPerPx ? saved.scan.dpi : null);
    setNote(saved.note);
    retone();
    update();
  }

  function showPageControls(source: DocumentSource) {
    ui.pageSelect.replaceChildren(...Array.from({ length: source.pageCount }, (_, i) => {
      const option = document.createElement("option");
      option.value = String(i);
      option.textContent = String(i + 1);
      return option;
    }));
    ui.pageTotal.textContent = `of ${source.pageCount}`;
    ui.pageNav.hidden = source.pageCount <= 1;
  }

  /** Read, straighten and detect one page, as a single progress run. */
  async function loadFreshPage(index: number) {
    const source = S.source!;
    const run = progress.begin("Finding the document", [
      { id: "read", label: source.pageCount > 1
        ? `Open page ${index + 1} of ${source.pageCount}` : "Open the scan" },
      { id: "straighten", label: "Measure the tilt" },
      ...model.loadingSteps(),
      { id: "encode", label: "Analyse the scan" },
      { id: "decode", label: "Find the document" },
      { id: "refine", label: "Measure the edges" },
    ], model.quality, { delayMs: 0 });
    try {
      run.start("read");
      await paint();
      const scan = await source.loadPage(index);
      run.done("read", `${scan.image.width} by ${scan.image.height} px`);
      S.page = index;
      S.original = scan.image;
      S.scan = null;
      S.toned = null;
      S.mask = null;
      S.objects = [];
      S.selectedObjectId = null;
      S.box = defaultBox();
      S.fit = null;
      S.drag = null;
      merging.clear();
      ui.fileName.textContent = scan.name;
      ui.fileName.title = scan.name;
      ui.pageSelect.value = String(index);
      showSourceResolution(scan.mmPerPx ? scan.dpi : null);
      setNote({ text: "" });
      renderObjectsPanel();

      // Straighten first, the order the Python build uses, so the crop box and the
      // measurement both refer to the upright frame.
      run.start("straighten");
      await paint();
      S.skew = await estimateSkew(scan.image);
      run.done("straighten", `${S.skew.toFixed(1)}°`);
      showSkew();
      S.scan = { ...scan, image: rotate(scan.image, S.skew) };
      retone();
      deps.draw();
    } catch (error) {
      run.fail(`Could not read this page. ${message(error)}`);
      return;
    }
    await detectInto(run);
  }

  /* -------------------------------------------------------------------- detection */
  function describe(result: DetectResult, fit: Fit | null): Note {
    const straightened = Math.abs(S.skew) >= 0.05
      ? ` Straightened by ${Math.abs(S.skew).toFixed(1)}°.` : "";
    if (fit?.card) {
      return {
        text: `Found the card and squared it up.${straightened}`,
        detail: "Its four edges were measured at full resolution, so glare and shadow stay out, "
          + "and each corner is rounded as the card is. Drag the box to crop by hand instead.",
      };
    }
    if (result.whole) {
      return {
        text: `The document fills the photo, so all of it is kept.${straightened}`,
        detail: "No edge of a separate document was found inside the photo. Drag the box to crop by hand.",
      };
    }
    const measured = result.kinds.filter(k => k === "edge" || k === "outer-edge").length;
    return {
      text: `${fit ? "Found the document and squared it up." : "Found the document."}${straightened}`,
      detail: `${measured} of its 4 edges were measured at full resolution; `
        + "the rest follow the model's outline or the photo's border. Drag the box to crop by hand instead.",
    };
  }

  /** Run detection on the current scan, inside `run` or a fresh one. */
  async function detectInto(existing?: ProgressRun) {
    if (!S.scan) return;
    const run = existing ?? progress.begin("Finding the document", [
      ...model.loadingSteps(),
      { id: "encode", label: "Analyse the scan" },
      { id: "decode", label: "Find the document" },
      { id: "refine", label: "Measure the edges" },
    ], model.quality);
    const image = S.scan.image;
    let result: DetectResult;
    try {
      const turn = S.skew;
      result = await model.exclusive(sam => detect(sam, image, turn, run.report));
    } catch (error) {
      if (!model.sam.loaded) {
        run.fail(`The model could not start. ${message(error)} Check the connection, then press Detect again.`);
        setNote({ text: "The model could not start.", detail: message(error), warn: true });
      } else {
        run.close();
        setNote({
          text: "Could not find the document, so drag the box yourself.",
          detail: message(error), warn: true,
        });
      }
      update();
      return;
    }
    run.close();
    // The scan changed while this ran (a turn, a new tilt): this answer is for an image that
    // is no longer on screen.
    if (S.scan?.image !== image) return;
    const fit = fitFor(result, image, S.scan.focal ?? null);
    S.box = { ...result.box };
    S.mask = result.whole ? null : { mask: result.mask, size: result.maskSize, box: { ...result.box } };
    S.fit = fit;
    setNote(describe(result, fit));
    update();
  }

  /* ---------------------------------------------------------------- several items */
  async function toggleObjects() {
    if (!S.scan) return;
    if (S.objects.length) {
      S.objects = [];
      S.selectedObjectId = null;
      merging.clear();
      setNote({ text: "Back to one item." });
      update();
      return;
    }
    const run = progress.begin("Finding every item", [
      ...model.loadingSteps(),
      { id: "encode", label: "Analyse the scan" },
      { id: "decode", label: "Try 64 points across the scan" },
      { id: "refine", label: "Fit each item" },
    ], model.quality);
    const image = S.scan.image;
    try {
      const groups = await model.exclusive(sam => findObjectGroups(sam, image, run.report));
      run.close();
      if (S.scan?.image !== image) return;
      S.objects = groups.map(group => group[0]!).filter(Boolean);
      S.selectedObjectId = S.objects[0]?.id ?? null;
      merging.clear();
      setNote(S.objects.length
        ? { text: `Found ${S.objects.length} item${S.objects.length === 1 ? "" : "s"}; each keeps its own angle.` }
        : { text: "No separate document-shaped items were found.", warn: true });
    } catch (error) {
      if (!model.sam.loaded) run.fail(`The model could not start. ${message(error)}`);
      else run.close();
      setNote({ text: "Could not find several items.", detail: message(error), warn: true });
    }
    update();
  }

  const objectActions: ObjectActions = {
    select(id) {
      S.selectedObjectId = id;
      update();
    },
    toggleMerge(id, on) {
      if (on) merging.add(id);
      else merging.delete(id);
      renderObjectsPanel();
    },
    async choose(index, choiceIndex) {
      const current = S.objects[index];
      const choice = current?.choices?.[choiceIndex];
      if (!S.scan || !current?.choices || !choice) return;
      const refined = await refineObject(S.scan.image, choice);
      current.choices[choiceIndex] = {
        ...refined, alternatives: [], choices: undefined, choiceIndex: undefined,
      };
      const stable: ObjectCandidate = {
        ...refined,
        id: current.id,
        choices: current.choices,
        choiceIndex,
        alternatives: current.choices.filter((_, i) => i !== choiceIndex),
      };
      S.objects[index] = stable;
      S.selectedObjectId = stable.id;
      update();
    },
    undoMerge(index) {
      const merged = S.objects[index];
      if (!merged?.mergedParts?.length) return;
      S.objects.splice(index, 1, ...merged.mergedParts);
      merging.clear();
      S.selectedObjectId = merged.mergedParts[0]?.id ?? null;
      update();
    },
    remove(id) {
      S.objects = S.objects.filter(item => item.id !== id);
      merging.delete(id);
      if (S.selectedObjectId === id) S.selectedObjectId = S.objects[0]?.id ?? null;
      update();
    },
  };

  function renderObjectsPanel() {
    renderObjects(S, merging, objectActions);
  }

  async function mergeTicked() {
    if (!S.scan || merging.size < 2) return;
    const picked = S.objects.filter(item => merging.has(item.id));
    if (picked.length < 2) return;
    const first = Math.min(...picked.map(item => S.objects.indexOf(item)));
    const merged = await mergeObjects(S.scan.image, picked);
    S.objects = S.objects.filter(item => !merging.has(item.id));
    S.objects.splice(first, 0, merged);
    merging.clear();
    S.selectedObjectId = merged.id;
    update();
  }

  /* ---------------------------------------------------------------- orientation */
  /**
   * Quarter turns are exact, so nothing is recomputed: the crop box, the mask and the tilt
   * rotate with the frame, and the turn is instant.
   */
  function turn(quarters: number) {
    if (!S.scan || !S.original) return;
    const k = ((quarters % 4) + 4) % 4;
    S.objects = [];
    S.selectedObjectId = null;
    merging.clear();
    S.original = quarterTurns(S.original, k);
    S.scan = { ...S.scan, image: rotate(S.original, S.skew) };
    S.box = turnBox(S.box, k);
    if (S.fit) S.fit = turnFit(S.fit, k);
    if (S.mask) {
      S.mask = { mask: turnMask(S.mask.mask, S.mask.size, k), size: S.mask.size, box: turnBox(S.mask.box, k) };
    }
    retone();
    update();
  }

  /** Straighten by hand. The old box was fitted to the old angle, so say so. */
  function setSkew(degrees: number) {
    if (!S.scan || !S.original) return;
    S.skew = degrees;
    showSkew();
    S.scan = { ...S.scan, image: rotate(S.original, degrees) };
    S.mask = null;
    S.fit = null;
    S.objects = [];
    S.selectedObjectId = null;
    merging.clear();
    retone();
    setNote({ text: "Straightened by hand. Press Detect again to refit the box." });
    update();
  }

  /* ----------------------------------------------------------------- open, pages */
  async function open(loader: () => Promise<DocumentSource>) {
    if (loading) return;
    const hadDocument = !!S.source;
    const refuse = (text: string) => {
      if (hadDocument) {
        setNote({ text, warn: true });
      } else {
        ui.dropError.textContent = text;
        ui.dropError.hidden = false;
      }
    };
    ui.dropError.hidden = true;
    if (!model.runtimeAvailable) {
      refuse("The model runtime did not load, so detection cannot run. Refresh the page.");
      return;
    }
    loading = true;
    try {
      let source: DocumentSource;
      try {
        source = await loader();
      } catch (error) {
        refuse(`Could not open that. ${message(error)}`);
        return;
      }
      await S.source?.close().catch(() => undefined);
      S.source = source;
      S.pages.clear();
      S.page = 0;
      showPageControls(source);
      ui.app.hidden = false;
      ui.start.hidden = true;
      deps.onShown();
      await loadFreshPage(0);
      remember();
    } finally {
      loading = false;
    }
  }

  async function selectPage(index: number) {
    if (!S.source || index === S.page || loading) return;
    remember();
    const saved = S.pages.get(index);
    if (saved) {
      showPage(saved, index);
      return;
    }
    loading = true;
    try {
      await loadFreshPage(index);
      remember();
    } finally {
      loading = false;
    }
  }

  /* ------------------------------------------------------------------------ tray */
  async function addToSheet() {
    const added = await deps.addLiveToSheet();
    if (!added) return;
    renderTray(S, removeFromSheet);
    setNote({
      text: S.tray.length === 1
        ? "Pinned on the sheet. Open the other side next; its crop joins this one on the page."
        : `Pinned. ${S.tray.length} items on the sheet.`,
    });
    remember();
  }

  function removeFromSheet(id: number) {
    S.tray = S.tray.filter(item => item.id !== id);
    renderTray(S, removeFromSheet);
    deps.refresh();
  }

  function clearSheet() {
    S.tray = [];
    renderTray(S, removeFromSheet);
    deps.refresh();
  }

  /** The crop box was moved by hand: that replaces the measured edges. */
  function cropEdited() {
    if (S.fit) {
      S.fit = null;
      setNote({ text: "Cropping to your box. Press Detect again to measure the edges." });
      deps.draw();
    }
    deps.refresh();
    remember();
  }

  return {
    open, selectPage, turn, setSkew, retone, cropEdited,
    redetect: () => detectInto(),
    toggleObjects, mergeTicked, addToSheet, clearSheet,
    setNote, remember,
    get busy() { return loading; },
  };
}
