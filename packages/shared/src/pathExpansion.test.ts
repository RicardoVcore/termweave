import { describe, expect, it } from "vitest";

import { expandHomePath, resolvePlatformHomeDirectory } from "./pathExpansion";

describe("pathExpansion", () => {
  it("expands tilde paths against an explicit home", () => {
    expect(expandHomePath("~/workspace", "/Users/maria")).toBe("/Users/maria/workspace");
    expect(expandHomePath("~\\workspace", "C:\\Users\\Maria", "win32")).toBe(
      "C:\\Users\\Maria\\workspace",
    );
  });

  it("prefers USERPROFILE on Windows", () => {
    expect(
      resolvePlatformHomeDirectory(
        { HOME: "/c/Users/Maria", USERPROFILE: "C:\\Users\\Maria" },
        "win32",
        "fallback",
      ),
    ).toBe("C:\\Users\\Maria");
  });

  it("prefers HOME on macOS and Linux", () => {
    expect(
      resolvePlatformHomeDirectory(
        { HOME: "/Users/maria", USERPROFILE: "ignored" },
        "darwin",
        "fallback",
      ),
    ).toBe("/Users/maria");
  });
});
