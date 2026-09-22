/** The two list panels above the panes: several found items, and crops pinned on the sheet. */
import { ui } from "../dom";
import { measuredObject, type ObjectCandidate } from "../lib/objects";
import type { AppState } from "../state";

const sizeText = (size: [number, number] | null) =>
  size ? `${size[0]} by ${size[1]} mm` : "scale unknown";

function removeButton(title: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "objDel";
  button.title = title;
  button.setAttribute("aria-label", title);
  button.textContent = "×";
  button.addEventListener("click", event => {
    event.stopPropagation();
    onClick();
  });
  return button;
}

export interface ObjectActions {
  select(id: number): void;
  toggleMerge(id: number, on: boolean): void;
  choose(index: number, choice: number): void;
  undoMerge(index: number): void;
  remove(id: number): void;
}

export function renderObjects(state: AppState, merging: Set<number>, actions: ObjectActions): void {
  ui.objPanel.hidden = state.objects.length === 0;
  ui.findSeveral.textContent = state.objects.length ? "Back to one item" : "Find several items";
  ui.objCount.textContent = state.objects.length ? `${state.objects.length} items` : "";
  ui.mergeObjects.disabled = merging.size < 2;
  ui.mergeObjects.title = ui.mergeObjects.disabled
    ? "tick two or more items first" : "combine the ticked items into one";
  ui.objList.replaceChildren();
  const scan = state.scan;
  if (!scan) return;
  state.objects.forEach((item: ObjectCandidate, index) => {
    const row = document.createElement("li");
    row.className = `objRow${item.id === state.selectedObjectId ? " on" : ""}`;
    row.tabIndex = 0;
    row.setAttribute("aria-selected", String(item.id === state.selectedObjectId));

    const tick = document.createElement("input");
    tick.type = "checkbox";
    tick.checked = merging.has(item.id);
    tick.title = `Tick item ${index + 1} to merge it`;
    tick.setAttribute("aria-label", tick.title);
    tick.addEventListener("click", event => {
      event.stopPropagation();
      actions.toggleMerge(item.id, tick.checked);
    });

    const number = document.createElement("span");
    number.className = "objNum";
    number.textContent = String(index + 1);
    const size = document.createElement("span");
    size.className = "objSize";
    size.textContent = sizeText(measuredObject(item, scan.image, scan.mmPerPx));
    const angle = document.createElement("span");
    angle.className = "objAngle";
    angle.textContent = `${item.angle.toFixed(1)}°`;
    row.append(tick, number, size, angle);

    const choices = item.choices ?? [];
    if (choices.length > 1) {
      const select = document.createElement("select");
      select.className = "objChoices";
      select.title = "other outlines the model proposed for this item";
      choices.forEach((choice, choiceIndex) => {
        const option = document.createElement("option");
        option.value = String(choiceIndex);
        option.textContent = `${choiceIndex + 1} of ${choices.length}: ${
          sizeText(measuredObject(choice, scan.image, scan.mmPerPx))}`;
        option.selected = choiceIndex === (item.choiceIndex ?? 0);
        select.append(option);
      });
      select.addEventListener("click", event => event.stopPropagation());
      select.addEventListener("change", () => actions.choose(index, Number(select.value)));
      row.append(select);
    }
    if (item.mergedParts?.length) {
      const undo = document.createElement("button");
      undo.type = "button";
      undo.className = "objUndo";
      undo.textContent = `Undo merge (${item.mergedParts.length})`;
      undo.addEventListener("click", event => {
        event.stopPropagation();
        actions.undoMerge(index);
      });
      row.append(undo);
    }
    row.append(removeButton(`Remove item ${index + 1}`, () => actions.remove(item.id)));
    const select = () => actions.select(item.id);
    row.addEventListener("click", select);
    row.addEventListener("keydown", event => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        select();
      }
    });
    ui.objList.append(row);
  });
}

export function renderTray(state: AppState, onRemove: (id: number) => void): void {
  ui.trayPanel.hidden = state.tray.length === 0;
  ui.trayCount.textContent = state.tray.length ? `${state.tray.length} on the sheet` : "";
  ui.trayList.replaceChildren();
  state.tray.forEach((item, index) => {
    const row = document.createElement("li");
    row.className = "objRow trayRow";
    const number = document.createElement("span");
    number.className = "objNum";
    number.textContent = String(index + 1);
    const label = document.createElement("span");
    label.className = "objLabel";
    label.textContent = item.label;
    label.title = item.label;
    const size = document.createElement("span");
    size.className = "objSize";
    size.textContent = sizeText(item.mmPerPx
      ? [item.image.width, item.image.height].map(v => Math.round(v * item.mmPerPx! * 10) / 10) as [number, number]
      : null);
    row.append(number, label, size,
      removeButton(`Take item ${index + 1} off the sheet`, () => onRemove(item.id)));
    ui.trayList.append(row);
  });
}
