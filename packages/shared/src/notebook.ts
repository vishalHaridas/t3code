import {
  NOTEBOOK_SEND_TURN_MAX_INPUT_CHARS,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  type ModelSelection,
} from "@t3tools/contracts";

import { getModelSelectionStringOptionValue, normalizeModelSlug } from "./model.ts";

const NOTEBOOK_DEFAULT_PROMPT_CHAR_LIMIT = PROVIDER_SEND_TURN_MAX_INPUT_CHARS;

/**
 * Notebook asks are intentionally more permissive than normal chat turns
 * because they are one-shot retrieval/synthesis requests, not ongoing
 * conversational turns that need to preserve headroom for follow-ups.
 *
 * Keep these limits conservative: they are still char-based estimates layered
 * on top of token-based provider context windows, and they need room for
 * hidden/system scaffolding plus output tokens.
 */
export const NOTEBOOK_PROMPT_CHAR_LIMITS = {
  claudeAgent: {
    default: 500_000,
    oneMillionContextWindow: 850_000,
  },
  codex: {
    default: 250_000,
    models: {
      "gpt-5.4": 1_000_000,
      "gpt-5.4-mini": 850_000,
    },
  },
  cursor: {
    context272k: 500_000,
    default: 350_000,
    oneMillionContextWindow: 850_000,
  },
  opencode: {
    default: 250_000,
    openaiGpt5: 500_000,
  },
} as const;

function detectCursorContextHint(model: string | null): "1m" | "272k" | undefined {
  if (!model) return undefined;
  const lowered = model.toLowerCase();
  if (lowered.includes("context=1m")) return "1m";
  if (lowered.includes("context=272k")) return "272k";
  return undefined;
}

export function getNotebookPromptCharLimit(
  modelSelection: ModelSelection | null | undefined,
): number {
  if (!modelSelection) return NOTEBOOK_DEFAULT_PROMPT_CHAR_LIMIT;

  const normalizedModel = normalizeModelSlug(modelSelection.model, modelSelection.provider);
  const contextWindow = getModelSelectionStringOptionValue(modelSelection, "contextWindow");

  switch (modelSelection.provider) {
    case "codex": {
      const exactModelLimit = normalizedModel
        ? NOTEBOOK_PROMPT_CHAR_LIMITS.codex.models[
            normalizedModel as keyof typeof NOTEBOOK_PROMPT_CHAR_LIMITS.codex.models
          ]
        : undefined;
      return exactModelLimit ?? NOTEBOOK_PROMPT_CHAR_LIMITS.codex.default;
    }
    case "claudeAgent":
      if (contextWindow === "1m") {
        return NOTEBOOK_PROMPT_CHAR_LIMITS.claudeAgent.oneMillionContextWindow;
      }
      return NOTEBOOK_PROMPT_CHAR_LIMITS.claudeAgent.default;
    case "cursor": {
      if (contextWindow === "1m") {
        return NOTEBOOK_PROMPT_CHAR_LIMITS.cursor.oneMillionContextWindow;
      }
      const contextHint = detectCursorContextHint(normalizedModel);
      if (contextHint === "1m") {
        return NOTEBOOK_PROMPT_CHAR_LIMITS.cursor.oneMillionContextWindow;
      }
      if (contextHint === "272k") {
        return NOTEBOOK_PROMPT_CHAR_LIMITS.cursor.context272k;
      }
      return NOTEBOOK_PROMPT_CHAR_LIMITS.cursor.default;
    }
    case "opencode":
      if (normalizedModel?.startsWith("openai/gpt-5")) {
        return NOTEBOOK_PROMPT_CHAR_LIMITS.opencode.openaiGpt5;
      }
      return NOTEBOOK_PROMPT_CHAR_LIMITS.opencode.default;
    default:
      return NOTEBOOK_DEFAULT_PROMPT_CHAR_LIMIT;
  }
}

export function clampNotebookPromptCharLimit(limit: number): number {
  if (!Number.isFinite(limit)) return NOTEBOOK_DEFAULT_PROMPT_CHAR_LIMIT;
  return Math.max(
    NOTEBOOK_DEFAULT_PROMPT_CHAR_LIMIT,
    Math.min(NOTEBOOK_SEND_TURN_MAX_INPUT_CHARS, Math.floor(limit)),
  );
}
