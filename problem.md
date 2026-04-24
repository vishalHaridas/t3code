## CURRENT

Build a rapid prototype of a NotebookLM-like mode for T3 Code. The mode lets a user switch the current project into a temporary research/chat view over selected historical threads.

Prototype scope:

- Add a project-scoped Notebook mode toggle near the existing new-thread affordance.
- While active, keep the current project visible but make other projects and normal thread navigation inactive/dimmed.
- Start with zero selected threads.
- Let the user select multiple threads from the current project as sources.
- Lazy-load selected thread details and include only non-streaming user/assistant messages.
- Submit notebook questions as ephemeral chat over a raw exported thread dump assembled at submit time.
- Keep the existing model picker/provider selection.
- Hide coding-agent controls that do not make sense in Notebook mode, including build/plan, access, worktree, and branch controls where practical.
- Add a simple size guard if it is cheap.

Out of scope for the prototype:

- Mind maps.
- Notes/studio panel.
- Persistent notebook chats.
- Cross-project source selection.
- Dedicated SQL/retrieval tools.
- A separate model picker.

Important future direction:

- A real implementation should not rely on injecting large raw dumps. It should use scoped, read-only thread-query tools over the projection database so the model can inspect threads by search, date, branch, worktree, and message ranges without receiving all source content upfront.

Minimal data model:

- Notebook mode state: active/inactive, scoped to one current project.
- Selected sources: thread IDs selected by the user.
- Source dump: selected thread user/assistant messages, built lazily at submit time.
- Notebook chat messages: ephemeral local conversation, discarded on exit for now.

First implementation target:

- Implement the mode switch, sidebar source selection, simplified notebook chat pane, raw source dump assembly, and hidden irrelevant controls for the MVP.

## RECENT

- Brainstorming settled on raw exported thread dump for the prototype, while documenting SQL-backed read-only query tools as the real direction.

## ARCHIVE
