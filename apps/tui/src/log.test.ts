import { describe, expect, it } from "vitest";

import { serializeLogDetails } from "./log";

describe("TUI logger", () => {
  it("redacts credentials from keys and URLs", () => {
    const token = "must-never-enter-logs";
    const serialized = serializeLogDetails({
      authToken: token,
      warning: {
        url: `ws://127.0.0.1:41001/?token=${token}`,
      },
    });

    expect(serialized).not.toContain(token);
    expect(serialized).toContain("REDACTED");
  });
});
