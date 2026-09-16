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

export function menuWindow<T>(
  rows: ReadonlyArray<T>,
  selectedIndex: number,
  maxRows: number,
): { readonly startIndex: number; readonly rows: ReadonlyArray<T> } {
  const windowSize = Math.max(maxRows, 0);
  const maxStartIndex = Math.max(rows.length - windowSize, 0);
  const startIndex = Math.max(0, Math.min(selectedIndex, maxStartIndex));
  return {
    startIndex,
    rows: rows.slice(startIndex, startIndex + windowSize),
  };
}
