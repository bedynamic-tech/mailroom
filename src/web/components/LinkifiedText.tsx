import { linkifyPlainText, removeRedundantGoogleRedirects } from "../../shared/linkify";

export function LinkifiedText({ text }: { text: string }) {
  return linkifyPlainText(removeRedundantGoogleRedirects(text)).map((segment, index) =>
    segment.type === "link" ? (
      <a
        key={`${index}-${segment.href}`}
        href={segment.href}
        target="_blank"
        rel="noopener noreferrer"
        referrerPolicy="no-referrer"
        className="break-all font-medium text-blue-700 underline decoration-blue-300 underline-offset-2 transition-colors hover:text-blue-900 hover:decoration-blue-500 focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {segment.value}
      </a>
    ) : (
      segment.value
    ),
  );
}
