export type ModelMenuRow<T> =
  | { readonly kind: "model"; readonly option: T }
  | { readonly kind: "legacyHeader" };

export function buildModelMenuRows<T>(
  currentOptions: ReadonlyArray<T>,
  legacyOptions: ReadonlyArray<T>,
  legacyExpanded: boolean,
): ReadonlyArray<ModelMenuRow<T>> {
  return [
    ...currentOptions.map((option): ModelMenuRow<T> => ({ kind: "model", option })),
    ...(legacyOptions.length > 0 ? ([{ kind: "legacyHeader" }] as const) : []),
    ...(legacyExpanded
      ? legacyOptions.map((option): ModelMenuRow<T> => ({ kind: "model", option }))
      : []),
  ];
}

export type ModelMenuDisplayRow<T> =
  | { readonly kind: "row"; readonly index: number; readonly row: T }
  | { readonly kind: "moreAbove"; readonly count: number }
  | { readonly kind: "moreBelow"; readonly count: number };

export type ModelMenuWindow<T> = {
  readonly startIndex: number;
  readonly rows: ReadonlyArray<ModelMenuDisplayRow<T>>;
};

/**
 * Keep-in-view window over menu rows. The window only moves when the selected
 * row leaves it (keyboard navigation), never on its own, so mouse hover over
 * rows cannot scroll the menu. Hint rows ("more above/below") are carved out
 * of the visible rows so the rendered row count never exceeds `maxRows` and
 * a fixed popup height stays fixed.
 */
export function menuWindow<T>(
  rows: ReadonlyArray<T>,
  selectedIndex: number,
  maxRows: number,
  previousStartIndex: number,
): ModelMenuWindow<T> {
  const windowSize = Math.max(Math.floor(maxRows), 0);
  if (rows.length === 0 || windowSize === 0) {
    return { startIndex: 0, rows: [] };
  }
  const index = Math.min(Math.max(Math.floor(selectedIndex), 0), rows.length - 1);
  const scrolls = rows.length > windowSize;
  // Reserve one row per hint so selection tracking never lands a selected row
  // under a hint row.
  const keepInViewSize = scrolls ? Math.max(windowSize - 2, 1) : windowSize;
  const maxStartIndex = Math.max(rows.length - keepInViewSize, 0);
  let startIndex = Math.min(Math.max(Math.floor(previousStartIndex), 0), maxStartIndex);
  if (index < startIndex) {
    startIndex = index;
  } else if (index > startIndex + keepInViewSize - 1) {
    startIndex = index - keepInViewSize + 1;
  }
  startIndex = Math.min(startIndex, maxStartIndex);

  const display = buildDisplayRows(rows, startIndex, windowSize);
  return { startIndex, rows: display };
}

function buildDisplayRows<T>(
  rows: ReadonlyArray<T>,
  startIndex: number,
  windowSize: number,
): ReadonlyArray<ModelMenuDisplayRow<T>> {
  const display: ModelMenuDisplayRow<T>[] = [];
  const moreAbove = startIndex;
  const rowsAboveHint = moreAbove > 0 ? 1 : 0;
  const visibleCount = Math.min(windowSize - rowsAboveHint, rows.length - startIndex);
  const hiddenBelowCount = rows.length - startIndex - visibleCount;
  // Shrink by one when a "more below" hint is needed; never below one row so
  // the selected row stays visible.
  const rowCount = hiddenBelowCount > 0 ? Math.max(visibleCount - 1, 1) : visibleCount;
  if (moreAbove > 0) {
    display.push({ kind: "moreAbove", count: moreAbove });
  }
  for (let offset = 0; offset < rowCount; offset += 1) {
    display.push({ kind: "row", index: startIndex + offset, row: rows[startIndex + offset]! });
  }
  const hiddenBelow = rows.length - startIndex - rowCount;
  if (hiddenBelow > 0) {
    display.push({ kind: "moreBelow", count: hiddenBelow });
  }
  return display;
}

/** Derive a human label from a model slug that has no server-provided name
 * (e.g. a saved thread model the current catalog no longer lists). */
export function modelSlugLabel(slug: string): string {
  const parts = slug
    .replace(/^claude-/i, "")
    .replace(/-\d{8}$/u, "")
    .split("-");
  const label: string[] = [];
  let numericRun: string[] = [];
  const flushNumericRun = () => {
    if (numericRun.length > 0) {
      label.push(numericRun.join("."));
      numericRun = [];
    }
  };
  for (const part of parts) {
    if (/^\d/.test(part)) {
      numericRun.push(part);
    } else {
      flushNumericRun();
      label.push(part.charAt(0).toUpperCase() + part.slice(1));
    }
  }
  flushNumericRun();
  return label.join(" ").trim();
}
