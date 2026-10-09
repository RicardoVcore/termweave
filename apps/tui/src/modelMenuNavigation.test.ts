import { describe, expect, it } from "vitest";

import { buildModelMenuRows, menuWindow } from "./modelMenuNavigation";

describe("buildModelMenuRows", () => {
  it("keeps collapsed legacy models out of keyboard navigation", () => {
    expect(buildModelMenuRows(["current"], ["legacy-1", "legacy-2"], false)).toEqual([
      { kind: "model", option: "current" },
      { kind: "legacyHeader" },
    ]);
  });

  it("adds every legacy model after the interactive header when expanded", () => {
    expect(buildModelMenuRows(["current"], ["legacy-1", "legacy-2"], true)).toEqual([
      { kind: "model", option: "current" },
      { kind: "legacyHeader" },
      { kind: "model", option: "legacy-1" },
      { kind: "model", option: "legacy-2" },
    ]);
  });
});

describe("menuWindow", () => {
  it("moves its window to keep the selected row visible", () => {
    expect(menuWindow([0, 1, 2, 3, 4], 4, 3)).toEqual({
      startIndex: 2,
      rows: [2, 3, 4],
    });
  });

  it("starts at zero while the selection fits in the first window", () => {
    expect(menuWindow([0, 1, 2, 3, 4], 1, 3)).toEqual({
      startIndex: 1,
      rows: [1, 2, 3],
    });
  });
});
