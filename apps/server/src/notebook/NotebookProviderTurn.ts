import {
  ChatAttachment,
  ModelSelection,
  NOTEBOOK_SEND_TURN_MAX_INPUT_CHARS,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  ProviderInteractionMode,
  type ProviderSendTurnInput,
  ThreadId,
  TrimmedNonEmptyString,
  type ModelSelection as ModelSelectionType,
} from "@t3tools/contracts";
import { getNotebookPromptCharLimit } from "@t3tools/shared/notebook";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ProviderValidationError } from "../provider/Errors.ts";

const NotebookProviderSendTurnInput = Schema.Struct({
  threadId: ThreadId,
  input: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(NOTEBOOK_SEND_TURN_MAX_INPUT_CHARS)),
  ),
  attachments: Schema.optional(
    Schema.Array(ChatAttachment).check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS)),
  ),
  modelSelection: Schema.optional(ModelSelection),
  interactionMode: Schema.optional(ProviderInteractionMode),
});
const decodeNotebookProviderSendTurnInputSchema = Schema.decodeUnknownEffect(
  NotebookProviderSendTurnInput,
);

export const decodeNotebookProviderSendTurnInput = Effect.fn("decodeNotebookProviderSendTurnInput")(
  function* (rawInput: unknown, operation: string) {
    const parsed = yield* decodeNotebookProviderSendTurnInputSchema(rawInput).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderValidationError({
            operation,
            issue: cause.message,
            cause,
          }),
      ),
    );

    return parsed as ProviderSendTurnInput;
  },
);

export function validateNotebookPromptForModel(input: {
  readonly operation: string;
  readonly prompt: string | undefined;
  readonly modelSelection: ModelSelectionType | undefined;
  readonly fallbackModelName: string;
}): Effect.Effect<void, ProviderValidationError> {
  if (!input.prompt) {
    return Effect.void;
  }

  const promptLimit = getNotebookPromptCharLimit(input.modelSelection);
  if (input.prompt.length <= promptLimit) {
    return Effect.void;
  }

  return Effect.fail(
    new ProviderValidationError({
      operation: input.operation,
      issue: `Notebook prompt is too large for model '${input.modelSelection?.model ?? input.fallbackModelName}'. Limit: ${promptLimit.toLocaleString()} chars.`,
    }),
  );
}
