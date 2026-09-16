import { assert, describe, it } from "@effect/vitest";
import { CodexSettings } from "@termweave/contracts";
import { Effect, Layer, Schema } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import type * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";

import {
  checkCodexProviderStatus,
  makePendingCodexProvider,
  requestAllCodexModels,
  resolveCodexProviderModels,
  type CodexAppServerProviderSnapshot,
} from "./CodexProvider";

const decodeCodexSettings = Schema.decodeUnknownSync(CodexSettings);

const unusedSpawnerLayer = Layer.succeed(
  ChildProcessSpawner.ChildProcessSpawner,
  ChildProcessSpawner.make(() => Effect.die("unexpected Codex process spawn")),
);

const authenticatedSnapshot: CodexAppServerProviderSnapshot = {
  account: {
    requiresOpenaiAuth: false,
    account: {
      type: "chatgpt",
      email: "maria@example.com",
      planType: "plus",
    },
  },
  version: "1.2.3",
  models: [
    {
      slug: "gpt-5.2",
      name: "GPT-5.2",
      isCustom: false,
      capabilities: null,
    },
  ],
  skills: [
    {
      name: "repo-search",
      path: "/tmp/repo-search",
      enabled: true,
    },
  ],
};

describe("CodexProvider", () => {
  it("uses live current models and enriches them with cached legacy models", () => {
    const capabilities = authenticatedSnapshot.models[0]!.capabilities;
    const models = resolveCodexProviderModels(
      [
        {
          slug: "gpt-stale",
          name: "GPT Stale",
          isCustom: false,
          capabilities,
        },
        {
          slug: "gpt-legacy",
          name: "GPT Legacy",
          isLegacy: true,
          isCustom: false,
          capabilities,
        },
      ],
      [
        {
          slug: "gpt-current",
          name: "GPT Current",
          isCustom: false,
          capabilities,
        },
      ],
    );

    assert.deepEqual(
      models.map((model) => model.slug),
      ["gpt-current", "gpt-legacy"],
    );
  });

  it.effect("requests and preserves hidden app-server models", () =>
    Effect.gen(function* () {
      const requests: Array<unknown> = [];
      const client = {
        request: (_method: string, params: unknown) =>
          Effect.sync(() => {
            requests.push(params);
            return {
              data: [
                {
                  id: "gpt-legacy",
                  model: "gpt-legacy",
                  displayName: "GPT Legacy",
                  description: "Previous generation",
                  hidden: true,
                  isDefault: false,
                  supportedReasoningEfforts: [],
                  defaultReasoningEffort: "medium",
                },
              ],
              nextCursor: null,
            };
          }),
      } as unknown as CodexClient.CodexAppServerClientShape;

      const models = yield* requestAllCodexModels(client);

      assert.deepEqual(requests, [{ includeHidden: true }]);
      assert.equal(models[0]?.slug, "gpt-legacy");
      assert.equal(models[0]?.isLegacy, true);
      assert.equal(models[0]?.description, "Previous generation");
    }),
  );

  it.effect("builds pending disabled snapshots", () =>
    Effect.gen(function* () {
      const snapshot = yield* makePendingCodexProvider(
        decodeCodexSettings({
          enabled: false,
          customModels: ["gpt-custom"],
        }),
      );

      assert.equal(snapshot.displayName, "Codex");
      assert.equal(snapshot.enabled, false);
      assert.equal(snapshot.status, "disabled");
      assert.equal(snapshot.auth.status, "unknown");
      assert.equal(snapshot.message, "Codex is disabled in Termweave settings.");
      assert.equal(
        snapshot.models.some((model) => model.slug === "gpt-custom" && model.isCustom),
        true,
      );
    }),
  );

  it.effect("builds pending enabled snapshots", () =>
    Effect.gen(function* () {
      const snapshot = yield* makePendingCodexProvider(decodeCodexSettings({}));

      assert.equal(snapshot.displayName, "Codex");
      assert.equal(snapshot.enabled, true);
      assert.equal(snapshot.status, "warning");
      assert.equal(
        snapshot.message,
        "Codex provider status has not been checked in this session yet.",
      );
    }),
  );

  it.effect("builds ready snapshots from app-server probe data", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkCodexProviderStatus(
        decodeCodexSettings({ binaryPath: "codex", customModels: ["gpt-custom"] }),
        () => Effect.succeed(authenticatedSnapshot),
      );

      assert.equal(snapshot.displayName, "Codex");
      assert.equal(snapshot.enabled, true);
      assert.equal(snapshot.installed, true);
      assert.equal(snapshot.version, "1.2.3");
      assert.equal(snapshot.status, "ready");
      assert.deepEqual(snapshot.auth, {
        status: "authenticated",
        type: "chatgpt",
        label: "ChatGPT Plus Subscription",
        email: "maria@example.com",
      });
      assert.deepEqual(snapshot.models, authenticatedSnapshot.models);
      assert.deepEqual(snapshot.skills, authenticatedSnapshot.skills);
    }).pipe(Effect.provide(unusedSpawnerLayer)),
  );

  it.effect("reports unauthenticated app-server accounts", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkCodexProviderStatus(decodeCodexSettings({}), () =>
        Effect.succeed({
          ...authenticatedSnapshot,
          account: {
            requiresOpenaiAuth: true,
            account: null,
          },
          models: [],
          skills: [],
        }),
      );

      assert.equal(snapshot.status, "error");
      assert.deepEqual(snapshot.auth, { status: "unauthenticated" });
      assert.equal(
        snapshot.message,
        "Codex CLI is not authenticated. Run `codex login` and try again.",
      );
    }).pipe(Effect.provide(unusedSpawnerLayer)),
  );

  it.effect("reports missing Codex CLI spawn failures", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkCodexProviderStatus(decodeCodexSettings({}), () =>
        Effect.fail(
          new CodexErrors.CodexAppServerSpawnError({
            command: "codex",
            cause: new Error("missing"),
          }),
        ),
      );

      assert.equal(snapshot.installed, false);
      assert.equal(snapshot.status, "error");
      assert.equal(snapshot.message, "Codex CLI (`codex`) is not installed or not on PATH.");
    }).pipe(Effect.provide(unusedSpawnerLayer)),
  );
});
