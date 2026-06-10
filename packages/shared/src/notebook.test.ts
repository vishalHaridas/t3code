import { describe, expect, it } from "vite-plus/test";
import { ProviderInstanceId } from "@t3tools/contracts";

import { getNotebookPromptCharLimit } from "./notebook.ts";

describe("getNotebookPromptCharLimit", () => {
  it("uses the raised GPT-5.4 Mini Notebook cap", () => {
    expect(
      getNotebookPromptCharLimit({
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4-mini",
      }),
    ).toBe(850_000);
  });

  it("uses the raised GPT-5.4 Notebook cap", () => {
    expect(
      getNotebookPromptCharLimit({
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
      }),
    ).toBe(1_000_000);
  });

  it("honors Claude 1M context-window selections", () => {
    expect(
      getNotebookPromptCharLimit({
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-sonnet-4-6",
        options: [{ id: "contextWindow", value: "1m" }],
      }),
    ).toBe(850_000);
  });

  it("falls back conservatively for unknown models", () => {
    expect(
      getNotebookPromptCharLimit({
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.unknown",
      }),
    ).toBe(250_000);
  });
});
