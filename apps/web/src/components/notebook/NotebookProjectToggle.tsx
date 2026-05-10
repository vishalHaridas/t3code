import { XIcon } from "lucide-react";
import type { MouseEvent } from "react";

import { NotebookModeIcon } from "../NotebookModeIcon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

interface NotebookProjectToggleProps {
  readonly projectName: string;
  readonly isNotebookProject: boolean;
  readonly shortcutLabel: string | null;
  readonly onClick: (event: MouseEvent<HTMLButtonElement>) => void;
}

export function NotebookProjectToggle({
  projectName,
  isNotebookProject,
  shortcutLabel,
  onClick,
}: NotebookProjectToggleProps) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={
              isNotebookProject
                ? `Exit notebook mode for ${projectName}`
                : `Open notebook mode for ${projectName}`
            }
            className={`inline-flex size-5 cursor-pointer items-center justify-center rounded-md text-muted-foreground/70 hover:bg-secondary hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring ${
              isNotebookProject ? "group/notebook-toggle bg-secondary text-foreground" : ""
            }`}
            onClick={onClick}
          >
            {isNotebookProject ? (
              <span className="relative inline-flex size-3.5 items-center justify-center">
                <NotebookModeIcon className="absolute size-3.5 transition-opacity group-hover/notebook-toggle:opacity-0" />
                <XIcon className="absolute size-3.5 opacity-0 transition-opacity group-hover/notebook-toggle:opacity-100" />
              </span>
            ) : (
              <NotebookModeIcon className="size-3.5" />
            )}
          </button>
        }
      />
      <TooltipPopup side="top">
        {isNotebookProject
          ? "Exit notebook mode"
          : shortcutLabel
            ? `Notebook mode (${shortcutLabel})`
            : "Notebook mode"}
      </TooltipPopup>
    </Tooltip>
  );
}
