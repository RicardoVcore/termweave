import { describe, expect, it } from "vitest";
import { Cause, Effect } from "effect";
import type { FormField1, FormInfo1 } from "@opencode/client";

import {
  OpenCodeFormAnswerError,
  parseOpenCodeModelSlug,
  parseServerUrlFromOutput,
  toOpenCodeFormAnswers,
  toOpenCodeFormQuestions,
} from "./opencodeRuntime.ts";

const asForm = (fields: ReadonlyArray<FormField1>): FormInfo1 =>
  ({ id: "form_1", sessionID: "ses_1", title: "Details", fields }) as FormInfo1;

describe("parseServerUrlFromOutput", () => {
  it("parses the OpenCode 2.x ready line", () => {
    expect(parseServerUrlFromOutput("server listening on http://127.0.0.1:4096\n")).toBe(
      "http://127.0.0.1:4096",
    );
  });

  it("parses the ready line when preceded by other startup output", () => {
    const output = [
      "|  opencode v2.2.7",
      "ready=123ms",
      "server listening on http://127.0.0.1:52341",
    ].join("\n");
    expect(parseServerUrlFromOutput(output)).toBe("http://127.0.0.1:52341");
  });

  it("returns null for the 1.x ready line and unrelated output", () => {
    expect(parseServerUrlFromOutput("opencode server listening on http://127.0.0.1:4096\n")).toBe(
      null,
    );
    expect(parseServerUrlFromOutput("some other output\n")).toBe(null);
    expect(parseServerUrlFromOutput("")).toBe(null);
  });
});

describe("parseOpenCodeModelSlug", () => {
  it("splits on the first slash so model ids containing slashes survive", () => {
    expect(parseOpenCodeModelSlug("openrouter/google/gemini-4-hydrogen")).toEqual({
      providerID: "openrouter",
      modelID: "google/gemini-4-hydrogen",
    });
  });

  it("rejects slugs without a provider segment", () => {
    expect(parseOpenCodeModelSlug("just-a-model")).toBe(null);
    expect(parseOpenCodeModelSlug("/leading")).toBe(null);
    expect(parseOpenCodeModelSlug("trailing/")).toBe(null);
    expect(parseOpenCodeModelSlug(undefined)).toBe(null);
  });
});

describe("toOpenCodeFormAnswers", () => {
  const runAnswers = (fields: ReadonlyArray<FormField1>, answers: Record<string, unknown>) =>
    Effect.runPromiseExit(toOpenCodeFormAnswers(fields, answers));

  it("maps selected option labels back onto option values", async () => {
    const fields: ReadonlyArray<FormField1> = [
      {
        key: "model",
        type: "string",
        options: [
          { value: "gpt-6", label: "GPT-6" },
          { value: "claude-5", label: "Claude 5" },
        ],
      },
    ];

    const result = await runAnswers(fields, { model: "Claude 5" });

    expect(result._tag).toBe("Success");
    if (result._tag !== "Success") {
      throw new Error("expected a successful conversion");
    }
    expect(result.value).toEqual({ model: "claude-5" });
  });

  it("converts integer answers to numbers", async () => {
    const fields: ReadonlyArray<FormField1> = [{ key: "count", type: "integer" }];

    const result = await runAnswers(fields, { count: "3" });

    if (result._tag !== "Success") {
      throw new Error("expected a successful conversion");
    }
    expect(result.value).toEqual({ count: 3 });
  });

  it("converts boolean Yes/No answers", async () => {
    const fields: ReadonlyArray<FormField1> = [{ key: "confirm", type: "boolean" }];

    const yes = await runAnswers(fields, { confirm: "Yes" });
    const no = await runAnswers(fields, { confirm: "No" });

    if (yes._tag !== "Success" || no._tag !== "Success") {
      throw new Error("expected successful conversions");
    }
    expect(yes.value).toEqual({ confirm: true });
    expect(no.value).toEqual({ confirm: false });
  });

  it("splits multiselect answers on commas and maps labels to values", async () => {
    const fields: ReadonlyArray<FormField1> = [
      {
        key: "tags",
        type: "multiselect",
        options: [
          { value: "alpha", label: "Alpha" },
          { value: "beta", label: "Beta" },
        ],
      },
    ];

    const result = await runAnswers(fields, { tags: "Alpha, Beta" });

    if (result._tag !== "Success") {
      throw new Error("expected a successful conversion");
    }
    expect(result.value).toEqual({ tags: ["alpha", "beta"] });
  });

  it("maps option labels containing commas from the joined answer", async () => {
    const fields: ReadonlyArray<FormField1> = [
      {
        key: "vendors",
        type: "multiselect",
        options: [
          { value: "acme", label: "ACME, Inc." },
          { value: "other", label: "Other" },
        ],
      },
    ];

    const result = await runAnswers(fields, { vendors: "ACME, Inc., Other" });

    if (result._tag !== "Success") {
      throw new Error("expected a successful conversion");
    }
    expect(result.value).toEqual({ vendors: ["acme", "other"] });
  });

  it("accepts an empty answer for an optional multiselect", async () => {
    const fields: ReadonlyArray<FormField1> = [
      {
        key: "tags",
        type: "multiselect",
        required: false,
        options: [
          { value: "alpha", label: "Alpha" },
          { value: "beta", label: "Beta" },
        ],
      },
    ];

    const result = await runAnswers(fields, { tags: [] });

    if (result._tag !== "Success") {
      throw new Error("expected a successful conversion");
    }
    expect(result.value).toEqual({ tags: [] });
  });

  it("rejects an empty answer for a required multiselect", async () => {
    const fields: ReadonlyArray<FormField1> = [
      {
        key: "tags",
        type: "multiselect",
        required: true,
        options: [
          { value: "alpha", label: "Alpha" },
          { value: "beta", label: "Beta" },
        ],
      },
    ];

    const result = await runAnswers(fields, { tags: [] });

    if (result._tag !== "Failure") {
      throw new Error("expected a failed conversion");
    }
    const error = Cause.squash(result.cause);
    expect(OpenCodeFormAnswerError.is(error)).toBe(true);
    if (OpenCodeFormAnswerError.is(error)) {
      expect(error.fieldKey).toBe("tags");
    }
  });

  it("omits answers for fields whose when conditions are inactive", async () => {
    const fields: ReadonlyArray<FormField1> = [
      { key: "enabled", type: "boolean" },
      {
        key: "threshold",
        type: "integer",
        when: [{ key: "enabled", op: "eq", value: true }],
      },
    ];

    const result = await runAnswers(fields, { enabled: "No", threshold: "42" });

    if (result._tag !== "Success") {
      throw new Error("expected a successful conversion");
    }
    expect(result.value).toEqual({ enabled: false });
  });

  it("fails naming the field when an active answer cannot be converted", async () => {
    const fields: ReadonlyArray<FormField1> = [{ key: "count", type: "integer" }];

    const result = await runAnswers(fields, { count: "abc" });

    if (result._tag !== "Failure") {
      throw new Error("expected a failed conversion");
    }
    const error = Cause.squash(result.cause);
    expect(OpenCodeFormAnswerError.is(error)).toBe(true);
    if (OpenCodeFormAnswerError.is(error)) {
      expect(error.fieldKey).toBe("count");
    }
  });

  it("accepts multiselect answers as a label array from remote clients", async () => {
    const fields: ReadonlyArray<FormField1> = [
      {
        key: "tags",
        type: "multiselect",
        options: [
          { value: "alpha", label: "Alpha" },
          { value: "beta", label: "Beta" },
        ],
      },
    ];

    const result = await runAnswers(fields, { tags: ["Alpha", "Beta"] });

    if (result._tag !== "Success") {
      throw new Error("expected a successful conversion");
    }
    expect(result.value).toEqual({ tags: ["alpha", "beta"] });
  });

  it("fails for non-text answers instead of dropping them silently", async () => {
    const fields: ReadonlyArray<FormField1> = [{ key: "count", type: "integer" }];

    const result = await runAnswers(fields, { count: 3 });

    if (result._tag !== "Failure") {
      throw new Error("expected a failed conversion");
    }
    const error = Cause.squash(result.cause);
    expect(OpenCodeFormAnswerError.is(error)).toBe(true);
    if (OpenCodeFormAnswerError.is(error)) {
      expect(error.fieldKey).toBe("count");
    }
  });

  it("treats a blank number answer as invalid instead of zero", async () => {
    const fields: ReadonlyArray<FormField1> = [{ key: "count", type: "integer" }];

    const result = await runAnswers(fields, { count: "" });

    expect(result._tag).toBe("Failure");
  });
});

describe("toOpenCodeFormQuestions", () => {
  it("skips hidden and external fields and gives boolean fields Yes/No options", () => {
    const questions = toOpenCodeFormQuestions(
      asForm([
        { key: "secret", type: "string", hidden: true, title: "Secret" },
        { key: "docs", type: "external", url: "https://example.com" },
        { key: "confirm", type: "boolean", title: "Confirm" },
      ]),
    );

    expect(questions).toHaveLength(1);
    expect(questions[0]?.id).toBe("confirm");
    expect(questions[0]?.options.map((option) => option.label)).toEqual(["Yes", "No"]);
  });

  it("suffixes questions with their when conditions", () => {
    const questions = toOpenCodeFormQuestions(
      asForm([
        { key: "enabled", type: "boolean" },
        {
          key: "threshold",
          type: "integer",
          when: [{ key: "enabled", op: "eq", value: true }],
        },
      ]),
    );

    expect(questions).toHaveLength(2);
    expect(questions[1]?.question).toBe("threshold (only applies if enabled = true)");
  });

  it("renders neq conditions with != in the question suffix", () => {
    const questions = toOpenCodeFormQuestions(
      asForm([
        { key: "enabled", type: "boolean" },
        {
          key: "threshold",
          type: "integer",
          when: [{ key: "enabled", op: "neq", value: true }],
        },
      ]),
    );

    expect(questions).toHaveLength(2);
    expect(questions[1]?.question).toBe("threshold (only applies if enabled != true)");
  });
});
