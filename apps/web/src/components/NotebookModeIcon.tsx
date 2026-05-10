import type { SVGProps } from "react";

export function NotebookModeIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path strokeWidth="2.1" d="M16.2 15.9 20.2 20" />
      <path strokeWidth="2.1" d="M16.8 10.6a6.2 6.2 0 1 1-2.4-4.9" />
      <path
        strokeWidth="1.8"
        d="m17.4 2.7.7 1.6c.1.3.4.6.7.7l1.6.7-1.6.7c-.3.1-.6.4-.7.7l-.7 1.6-.7-1.6c-.1-.3-.4-.6-.7-.7l-1.6-.7 1.6-.7c.3-.1.6-.4.7-.7l.7-1.6Z"
      />
    </svg>
  );
}
