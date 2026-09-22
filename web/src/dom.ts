/**
 * Every element the app touches, looked up once. A missing id fails at startup with its name,
 * instead of as a null dereference the first time someone clicks the control.
 */
function find<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`index.html has no #${id}`);
  return element as T;
}

type Input = HTMLInputElement;
type Select = HTMLSelectElement;
type Button = HTMLButtonElement;

export const ui = {
  // header and start screen
  engine: find("engine"),
  start: find("start"),
  drop: find("drop"),
  dropError: find("dropError"),
  file: find<Input>("file"),
  sample: find<Button>("sample"),
  // loading panel
  progress: find("progress"),
  progressTitle: find("progressTitle"),
  progressElapsed: find("progressElapsed"),
  progressSteps: find<HTMLOListElement>("progressSteps"),
  progressFoot: find("progressFoot"),
  // toolbar
  app: find("app"),
  fileName: find("fileName"),
  file2: find<Input>("file2"),
  pageNav: find("pageNav"),
  pageSelect: find<Select>("pageSelect"),
  pageTotal: find("pageTotal"),
  rotL: find<Button>("rotL"),
  rotR: find<Button>("rotR"),
  rot180: find<Button>("rot180"),
  redetect: find<Button>("redetect"),
  findSeveral: find<Button>("findSeveral"),
  startOver: find<Button>("startOver"),
  model: find<Select>("model"),
  skew: find<Input>("skew"),
  skewOut: find("skewOut"),
  trim: find<Input>("trim"),
  note: find("note"),
  // several items and the sheet tray
  objPanel: find("objPanel"),
  objCount: find("objCount"),
  objList: find<HTMLUListElement>("objList"),
  mergeObjects: find<Button>("mergeObjects"),
  trayPanel: find("trayPanel"),
  trayCount: find("trayCount"),
  trayList: find<HTMLUListElement>("trayList"),
  clearTray: find<Button>("clearTray"),
  // panes
  canvas: find<HTMLCanvasElement>("canvas"),
  scanViewport: find("scanViewport"),
  zoomOut: find<Button>("zoomOut"),
  zoomReset: find<Button>("zoomReset"),
  zoomIn: find<Button>("zoomIn"),
  panTool: find<Button>("panTool"),
  sheetChip: find("sheetChip"),
  sheetImg: find<HTMLImageElement>("sheetImg"),
  // settings strip
  fitButtons: [...document.querySelectorAll<Button>(".segBtn")],
  preset: find<Select>("preset"),
  clahe: find<Input>("clahe"),
  claheOut: find("claheOut"),
  stretch: find<Input>("stretch"),
  sheet: find<Select>("sheet"),
  landscape: find<Input>("landscape"),
  margin: find<Input>("margin"),
  resolution: find<Select>("resolution"),
  factScan: find("factScan"),
  factOut: find("factOut"),
  factSheet: find("factSheet"),
  addToSheet: find<Button>("addToSheet"),
  download: find<Button>("download"),
  scaleNote: find("scaleNote"),
} as const;

/** Buttons that start model work, disabled together while the model is busy. */
export const modelButtons = (): HTMLButtonElement[] => [
  ui.redetect, ui.findSeveral, ui.sample,
];
