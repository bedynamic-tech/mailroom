import type { ReactNode } from "react";
import { ExternalLinkIcon } from "./Icons";

export function DashLink(props: { href: string; children: ReactNode }) {
  return (
    <a
      href={props.href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-0.5 font-medium text-foreground underline underline-offset-2"
    >
      {props.children}
      <ExternalLinkIcon className="h-3 w-3" />
    </a>
  );
}
