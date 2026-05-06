import { describe, expect, it } from "vitest";

import { getNotebookPromptCharLimit } from "./notebook.ts";

describe("getNotebookPromptCharLimit", () => {
  it("uses the raised GPT-5.4 Mini Notebook cap", () => {
    expect(
      getNotebookPromptCharLimit({
        provider: "codex",
        model: "gpt-5.4-mini",
      }),
    ).toBe(850_000);
  });

  it("uses the raised GPT-5.4 Notebook cap", () => {
    expect(
      getNotebookPromptCharLimit({
        provider: "codex",
        model: "gpt-5.4",
      }),
    ).toBe(1_000_000);
  });

  it("honors Claude 1M context-window selections", () => {
    expect(
      getNotebookPromptCharLimit({
        provider: "claudeAgent",
        model: "claude-sonnet-4-6",
        options: [{ id: "contextWindow", value: "1m" }],
      }),
    ).toBe(850_000);
  });

  it("falls back conservatively for unknown models", () => {
    expect(
      getNotebookPromptCharLimit({
        provider: "codex",
        model: "gpt-5.unknown",
      }),
    ).toBe(250_000);
  });
});
