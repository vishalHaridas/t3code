## CURRENT

Notebook mode has Search and Ask over selected thread sources.

- Sources are selected thread details from the active project.
- Only non-streaming user/assistant messages are included.
- Ask builds a complete-source prompt and is blocked by the prompt-size guard when too large.
- Search posts a snapshot of selected threads to a Vite Web Worker, scans every selected message for the submitted query as one case-insensitive literal substring, and commits results only when the active worker run finishes.
- Stopping Search terminates the worker and keeps the last completed result visible.
- Typing during Search terminates the worker and clears only the active search run.

## RECENT

- Removed the retrieved-source branch.
- Notebook Search now behaves like normal find: common words and continuous phrases are searched literally.

## ARCHIVE
