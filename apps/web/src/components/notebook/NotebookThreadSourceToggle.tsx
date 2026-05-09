import { CheckIcon } from "lucide-react";

interface NotebookThreadSourceToggleProps {
  readonly threadTitle: string;
  readonly isSelected: boolean;
  readonly disabled: boolean;
  readonly locked: boolean;
  readonly onToggle: () => void;
}

export function NotebookThreadSourceToggle({
  threadTitle,
  isSelected,
  disabled,
  locked,
  onToggle,
}: NotebookThreadSourceToggleProps) {
  return (
    <button
      type="button"
      aria-label={
        isSelected
          ? `Remove ${threadTitle} from notebook sources`
          : `Add ${threadTitle} to notebook sources`
      }
      className={`inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md border transition-colors ${
        isSelected
          ? "border-primary bg-primary text-primary-foreground"
          : disabled
            ? "cursor-not-allowed border-border bg-background text-muted-foreground opacity-45"
            : "border-border bg-background text-muted-foreground hover:text-foreground"
      } ${locked ? "cursor-not-allowed opacity-45" : ""}`}
      disabled={locked || disabled}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (locked || disabled) return;
        onToggle();
      }}
    >
      {isSelected ? <CheckIcon className="size-3.5" /> : null}
    </button>
  );
}
