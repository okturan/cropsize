#!/usr/bin/env node
/**
 * End-to-end smoke test: drives the real app in Chrome, through the UI, the way a person
 * would, and checks what comes out. Unit tests cover the maths; this covers the wiring.
 *
 *   npm run e2e                      start a dev server and test it
 *   npm run e2e -- --url https://cropsize.pages.dev    test a deployed build
 *   npm run e2e -- --shots DIR       also save screenshots of each stage
 *   npm run e2e -- --headed          watch it
 *
 * Model weights come from web/.models/<size>/ when that folder exists (fast, offline),
 * otherwise from Hugging Face. The first model load is throttled so the download bar has
 * something to show, and every progress panel state is recorded along the way.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument } from "pdf-lib";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const web = resolve(here, "..");
const fixtures = resolve(web, "../fixtures");
const args = process.argv.slice(2);
const flag = name => args.includes(name);
const option = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const shots = option("--shots");
if (shots) mkdirSync(shots, { recursive: true });

/* ----------------------------------------------------------------------- reporting */
const results = [];
let failures = 0;
function check(name, ok, detail = "") {
  results.push(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
  console.log(results.at(-1));
}
const near = (a, b, tolerance) => Math.abs(a - b) <= tolerance;
const mm = text => (text?.match(/([\d.]+) by ([\d.]+) mm/) ?? []).slice(1).map(Number);

/* ---------------------------------------------------------------------- dev server */
async function startServer() {
  const port = 5170 + Math.floor(Math.random() * 20);
  const child = spawn(process.execPath, [join(web, "node_modules/vite/bin/vite.js"), "--port", String(port), "--strictPort"], {
    cwd: web, stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error("vite did not start")), 30_000);
    child.stdout.on("data", chunk => {
      if (String(chunk).includes("Local:")) { clearTimeout(timer); resolveReady(); }
    });
    child.on("exit", code => reject(new Error(`vite exited with ${code}`)));
  });
  return { url: `http://localhost:${port}/`, stop: () => child.kill() };
}

const server = option("--url") ? null : await startServer();
const base = option("--url") ?? server.url;
const local = !option("--url") && existsSync(join(web, ".models/base-plus"));
const appUrl = extra => `${base}?${new URLSearchParams({ ...(local ? { models: "local" } : {}), ...extra })}`;

/* ------------------------------------------------------------------------- browser */
const browser = await chromium.launch({ channel: "chrome", headless: !flag("--headed") });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
const page = await context.newPage();
const problems = [];
page.on("pageerror", error => problems.push(`pageerror: ${error.message}`));
page.on("console", message => {
  if (message.type() === "error") problems.push(`console: ${message.text()}`);
});
page.on("response", response => {
  if (response.status() >= 400) problems.push(`HTTP ${response.status()} ${response.url()}`);
});
let shot = 0;
const snap = async name => {
  if (shots) await page.screenshot({ path: join(shots, `${String(++shot).padStart(2, "0")}-${name}.png`) });
};
const text = selector => page.locator(selector).textContent();
const note = () => text("#note");

/** Record every distinct state of the loading panel until `done()` resolves. */
function watchProgress() {
  const seen = [];
  let last = "";
  let snapped = new Set();
  const timer = setInterval(async () => {
    try {
      const state = await page.evaluate(() => {
        const panel = document.getElementById("progress");
        if (!panel || panel.hidden) return null;
        return {
          title: document.getElementById("progressTitle").textContent,
          steps: [...document.querySelectorAll("#progressSteps .step")].map(step => ({
            label: step.querySelector(".stepLabel").textContent,
            state: step.dataset.state,
            meta: step.querySelector(".stepMeta").textContent,
            bar: step.querySelector(".barFill").style.width,
            kind: step.querySelector(".bar").className,
          })),
        };
      });
      if (!state) return;
      const key = JSON.stringify(state);
      if (key !== last) { seen.push(state); last = key; }
      const active = state.steps.find(step => step.state === "active");
      if (active && !snapped.has(active.label)) {
        snapped.add(active.label);
        await snap(`progress-${active.label.split(",")[0].replace(/\W+/g, "-").toLowerCase()}`);
      }
    } catch {
      // the page navigated or closed
    }
  }, 100);
  return { seen, stop: () => clearInterval(timer) };
}

const waitForNote = (pattern, timeout = 240_000) => page.waitForFunction(
  source => new RegExp(source).test(document.getElementById("note")?.textContent ?? ""),
  pattern.source, { timeout },
);
const settled = () => page.waitForTimeout(700);   // the preview recomposes after 120 ms
/** Wait until an action has finished: no panel, model not busy, a status line showing. */
async function idle(timeout = 240_000) {
  await page.waitForTimeout(400);
  await page.waitForFunction(() => document.getElementById("progress").hidden
    && !document.getElementById("redetect").disabled
    && !document.getElementById("pageSelect").disabled
    && (document.getElementById("note").textContent ?? "") !== "", null, { timeout });
  await settled();
}
const waitForFile = name => page.waitForFunction(
  wanted => (document.getElementById("fileName").textContent ?? "").includes(wanted), name, { timeout: 60_000 });

try {
  /* ------------------------------------------------------------------ start screen */
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false, latency: 20, downloadThroughput: 40 * 1024 * 1024, uploadThroughput: -1,
  });
  await page.goto(appUrl({}));
  await snap("start");
  check("start screen shows the drop target", await page.locator("#drop").isVisible());
  const badge = await text("#engine");
  check("header badge names the model", /SAM 2\.1/.test(badge), badge);

  /* ------------------------------------------- first detection, with a slow network */
  const watch = watchProgress();
  await page.click("#sample");
  await waitForNote(/Found the document|Could not/);
  watch.stop();
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
  });
  await settled();
  await snap("found");
  check("sample: document found", /Found the document/.test(await note()), await note());
  const labels = new Set(watch.seen.flatMap(state => state.steps.map(step => step.label)));
  check("progress panel appeared", watch.seen.length > 0, `${watch.seen.length} states`);
  for (const wanted of ["Open the scan", "Measure the tilt", "Start the model", "Analyse the scan", "Find the document"]) {
    check(`progress step shown: ${wanted}`, labels.has(wanted));
  }
  const downloads = watch.seen.flatMap(state => state.steps)
    .filter(step => step.label.startsWith("Download the model") && step.state === "active");
  const widths = downloads.map(step => Number.parseFloat(step.bar));
  check("download bar moves forward", widths.length >= 2 && widths.at(-1) > widths[0],
    widths.length ? `${widths[0]}% to ${widths.at(-1)}%` : "download step never active");
  check("download shows speed and time left", downloads.some(step => /MB\/s .* left/.test(step.meta)),
    downloads.at(-1)?.meta ?? "");
  const decodes = watch.seen.flatMap(state => state.steps)
    .filter(step => step.label === "Find the document" && step.state === "active");
  check("detection passes are counted", decodes.some(step => /\d+ of \d+/.test(step.meta)),
    decodes.at(-1)?.meta ?? "never active");
  check("panel closes when done", await page.locator("#progress").isHidden());

  const scanSize = mm(await text("#factScan"));
  check("sample measures 104.9 by 147.9 mm", near(scanSize[0], 104.9, 1.5) && near(scanSize[1], 147.9, 1.5),
    await text("#factScan"));
  check("real size prints what was measured", (await text("#factOut")) === (await text("#factScan")));
  check("preview image is composed", await page.locator("#sheetImg").evaluate(img => img.naturalWidth > 0));
  check("badge says the model is ready", /ready/.test(await text("#engine")), await text("#engine"));

  /* ------------------------------------------------------------------ orientation */
  await page.click("#rotR");
  await settled();
  const turned = mm(await text("#factScan"));
  check("quarter turn swaps width and height", near(turned[0], scanSize[1], 0.2) && near(turned[1], scanSize[0], 0.2),
    await text("#factScan"));
  await page.click("#rotL");
  await settled();
  const back = mm(await text("#factScan"));
  check("turning back restores the measurement", near(back[0], scanSize[0], 0.2), await text("#factScan"));

  /* -------------------------------------------------------------------- crop drag */
  const canvas = page.locator("#canvas");
  const bounds = await canvas.boundingBox();
  const cropBox = await page.evaluate(() => {
    const c = document.getElementById("canvas").getBoundingClientRect();
    return { left: c.left, top: c.top, width: c.width, height: c.height };
  });
  // Drag the top-left handle 30 px inwards: the crop must shrink.
  const startBox = await page.evaluate(() => {
    const box = JSON.parse(document.getElementById("canvas").dataset.box ?? "null");
    return box;
  });
  if (startBox) {
    const x = cropBox.left + startBox.x0 * cropBox.width;
    const y = cropBox.top + startBox.y0 * cropBox.height;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 30, y + 30, { steps: 5 });
    await page.mouse.up();
    await settled();
    const smaller = mm(await text("#factScan"));
    check("dragging a corner shrinks the crop", smaller[0] < scanSize[0] - 1, await text("#factScan"));
  } else {
    check("canvas exposes the crop box for testing", false);
  }
  await canvas.dblclick({ position: { x: bounds.width / 2, y: bounds.height / 2 } });
  await settled();
  const reset = mm(await text("#factScan"));
  check("double click resets the crop to nearly the whole frame", reset[0] > 200, await text("#factScan"));

  /* ------------------------------------------------------ detect again, reused encode */
  // The turns above made a new image, so this pass encodes; the one after must not.
  await page.click("#redetect");
  await idle();
  const t0 = Date.now();
  await page.click("#redetect");
  await idle();
  const redetectMs = Date.now() - t0 - 1100;        // idle() itself waits 1.1 s
  check("detect again restores the found crop", near(mm(await text("#factScan"))[0], scanSize[0], 0.5),
    await text("#factScan"));
  check("detect again reuses the encoding", redetectMs < 3000, `${redetectMs} ms`);

  /* ---------------------------------------------------------------- several items */
  await page.click("#findSeveral");
  await page.waitForFunction(() => /item|No separate/.test(document.getElementById("note").textContent), null, { timeout: 120_000 });
  await settled();
  await snap("several-items");
  const rows = await page.locator("#objList .objRow").count();
  check("several items lists at least one item", rows >= 1, `${rows} rows`);
  check("button offers the way back", (await text("#findSeveral")) === "Back to one item");
  await page.click("#findSeveral");
  await settled();
  check("back to one item hides the list", await page.locator("#objPanel").isHidden());

  /* ------------------------------------------------------------------ print modes */
  await page.click('.segBtn[data-fit="preset"]');
  await page.selectOption("#preset", "passport-page");
  await settled();
  const forced = mm(await text("#factOut"));
  check("known size fits the preset's longer side", Math.max(...forced) <= 125.1 && Math.max(...forced) >= 87.9,
    await text("#factOut"));
  await page.click('.segBtn[data-fit="fill"]');
  await settled();
  const filled = mm(await text("#factOut"));
  check("fill sheet fits inside A4 minus margins", filled[0] <= 194.1 && filled[1] <= 281.1 && Math.max(filled[0] / 194, filled[1] / 281) > 0.99,
    await text("#factOut"));
  await page.selectOption("#sheet", "none");
  await settled();
  check("no sheet wraps the page around the content", /no sheet/.test(await text("#factSheet")));
  await page.selectOption("#sheet", "a4");
  await page.click('.segBtn[data-fit="true"]');
  await settled();

  /* ----------------------------------------------------------------- PDF download */
  const readPdf = async () => {
    const [download] = await Promise.all([page.waitForEvent("download"), page.click("#download")]);
    const bytes = await readFile(await download.path());
    return { name: download.suggestedFilename(), pdf: await PDFDocument.load(bytes) };
  };
  const single = await readPdf();
  const { width: w, height: h } = single.pdf.getPage(0).getSize();
  check("PDF is one A4 page", single.pdf.getPageCount() === 1 && near(w, 595.3, 0.5) && near(h, 841.9, 0.5),
    `${single.pdf.getPageCount()} pages, ${w.toFixed(1)} by ${h.toFixed(1)} pt`);
  check("PDF is named after the scan", single.name === "sample-scan-cropsize.pdf", single.name);

  /* ------------------------------------------------- two files on one sheet (tray) */
  await page.click("#addToSheet");
  await settled();
  check("add to sheet pins the crop", (await page.locator("#trayList .objRow").count()) === 1);
  check("add to sheet button says it is pinned", (await text("#addToSheet")) === "On the sheet");
  const second = existsSync(join(fixtures, "private/okan-id-back.jpg"))
    ? join(fixtures, "private/okan-id-back.jpg") : join(fixtures, "public/objects-flatbed.pdf");
  await page.setInputFiles("#file2", second);
  await waitForFile(second.split("/").pop());
  await idle();
  await snap("two-on-a-sheet");
  check("tray survives opening another file", (await page.locator("#trayList .objRow").count()) === 1);
  check("the sheet shows two items", /^2 items/.test(await text("#factScan")), await text("#factScan"));
  const sheetPdf = await readPdf();
  check("sheet PDF is one page", sheetPdf.pdf.getPageCount() === 1, `${sheetPdf.pdf.getPageCount()} pages`);
  if (second.endsWith(".jpg")) {
    const printed = await text("#factOut");
    check("a photographed ID card prints at ID card size", /85\.\d by 54/.test(printed) || /54 by 85/.test(printed), printed);
  }
  await page.click("#clearTray");
  await settled();
  check("clearing the sheet hides the tray", await page.locator("#trayPanel").isHidden());

  /* ------------------------------------------- several items: merge, undo, remove */
  await page.setInputFiles("#file2", join(fixtures, "public/objects-flatbed.pdf"));
  await waitForFile("objects-flatbed.pdf");
  await idle();
  await page.click("#findSeveral");
  await idle();
  const rowCount = () => page.locator("#objList .objRow").count();
  check("the flatbed scan holds three items", (await rowCount()) === 3, `${await rowCount()} rows`);
  await page.locator("#objList .objRow input[type=checkbox]").nth(0).check();
  await page.locator("#objList .objRow input[type=checkbox]").nth(1).check();
  await page.click("#mergeObjects");
  await settled();
  check("merging two items leaves two rows", (await rowCount()) === 2);
  await page.locator("#objList .objUndo").first().click();
  await settled();
  check("undoing the merge brings three back", (await rowCount()) === 3);
  await page.locator("#objList .objRow").nth(1).click();
  await settled();
  check("clicking an item selects it", await page.locator("#objList .objRow").nth(1).evaluate(row => row.classList.contains("on")));
  await page.locator("#objList .objDel").last().click();
  await settled();
  check("removing an item leaves two", (await rowCount()) === 2);
  const itemsPdf = await readPdf();
  check("several-items PDF has one page per item", itemsPdf.pdf.getPageCount() === 2,
    `${itemsPdf.pdf.getPageCount()} pages, ${itemsPdf.name}`);
  await page.click("#findSeveral");
  await settled();

  /* ------------------------------------------------------- zoom, tilt and contrast */
  await page.click("#zoomIn");
  check("zooming in says by how much", (await text("#zoomReset")) === "125%", await text("#zoomReset"));
  await page.click("#zoomReset");
  check("fit resets the zoom", (await text("#zoomReset")) === "Fit");
  await page.locator("#skew").fill("1");
  await waitForNote(/Straightened by hand/, 10_000);
  check("moving the straighten slider asks for a new detection", true);
  await page.click("#redetect");
  await idle();
  check("detecting after straightening by hand finds the items page again", /Found the document/.test(await note()), await note());
  const before = await page.locator("#sheetImg").getAttribute("src");
  await page.locator("#clahe").fill("2");
  await page.waitForFunction(old => document.getElementById("sheetImg").getAttribute("src") !== old, before, { timeout: 15_000 });
  check("contrast recomposes the preview", true, await text("#claheOut"));
  await page.locator("#clahe").fill("0");
  await settled();

  /* ------------------------------------------------------------------ multi-page */
  const sample = await PDFDocument.load(await readFile(join(fixtures, "public/sample-scan.pdf")));
  const twoPages = await PDFDocument.create();
  for (const copied of await twoPages.copyPages(sample, [0, 0])) twoPages.addPage(copied);
  await page.setInputFiles("#file2", { name: "two-pages.pdf", mimeType: "application/pdf", buffer: Buffer.from(await twoPages.save()) });
  await waitForFile("two-pages.pdf");
  await idle();
  check("a two-page PDF shows the page selector", await page.locator("#pageNav").isVisible());
  await page.click("#rotR");
  await settled();
  await page.selectOption("#pageSelect", { value: "1" });
  await waitForFile("page 2");
  await idle();
  check("page 2 is detected on its own", /page 2/.test(await text("#fileName")), await text("#fileName"));
  await page.selectOption("#pageSelect", { value: "0" });
  await settled();
  const remembered = mm(await text("#factScan"));
  check("page 1 kept its quarter turn", remembered[0] > remembered[1], await text("#factScan"));

  /* ------------------------------------------------------------------ model switch */
  await page.selectOption("#model", "tiny");
  await page.waitForFunction(() => /tiny.*ready/.test(document.getElementById("engine").textContent), null, { timeout: 240_000 });
  await idle();
  check("switching to tiny detects again", /Found the document/.test(await note()), await note());
  check("badge follows the model", /tiny/.test(await text("#engine")), await text("#engine"));
  await page.reload();
  check("the model choice is remembered", (await page.locator("#model").inputValue()) === "tiny");
  await page.evaluate(() => localStorage.setItem("cropsize.model", "base-plus"));
} catch (error) {
  check("the run completed", false, error.message.split("\n")[0]);
  await snap("failure");
} finally {
  const unexpected = problems;
  check("no page errors, console errors or failed requests", unexpected.length === 0, unexpected.slice(0, 5).join(" | "));
  await browser.close();
  server?.stop();
  console.log(`\n${results.length - failures} passed, ${failures} failed`);
  process.exitCode = failures ? 1 : 0;
}
