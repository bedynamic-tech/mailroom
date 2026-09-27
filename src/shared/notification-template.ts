/** Placeholders available in email notification templates, written as {{name}}. */
export const NOTIFICATION_PLACEHOLDERS = [
  { key: "sender_name", description: "Sender's display name, or their address when there is none" },
  { key: "sender_email", description: "Sender's email address" },
  { key: "subject", description: "Subject of the new email" },
  { key: "preview", description: "First 500 characters of the new email" },
  { key: "inbox", description: "Inbox that received the email" },
  { key: "link", description: "Link to the conversation in Mailroom" },
] as const;

export type NotificationPlaceholder = (typeof NOTIFICATION_PLACEHOLDERS)[number]["key"];
export type NotificationValues = Record<NotificationPlaceholder, string>;

export const DEFAULT_NOTIFICATION_FROM_NAME = "Mailroom";
export const DEFAULT_NOTIFICATION_SUBJECT = "New email from {{sender_name}}: {{subject}}";
export const DEFAULT_NOTIFICATION_BODY = [
  "{{inbox}} received a new email.",
  "",
  "From: {{sender_name}} <{{sender_email}}>",
  "Subject: {{subject}}",
  "",
  "{{preview}}",
  "",
  "Open conversation: {{link}}",
  "",
  "You are receiving this because email notifications are on in Mailroom settings.",
].join("\n");

export const NOTIFICATION_LIMITS = {
  fromName: 100,
  subject: 300,
  body: 5000,
} as const;

export interface NotificationTemplate {
  fromName: string;
  subject: string;
  body: string;
}

const PLACEHOLDER_PATTERN = /\{\{\s*([a-z_]+)\s*\}\}/g;

/** Replaces known placeholders; unknown ones are left as written so typos stay visible. */
export function renderTemplate(template: string, values: NotificationValues): string {
  return template.replace(PLACEHOLDER_PATTERN, (match, key: string) =>
    Object.hasOwn(values, key) ? values[key as NotificationPlaceholder] : match,
  );
}

export function renderNotification(
  template: NotificationTemplate,
  values: NotificationValues,
): NotificationTemplate {
  const oneLine = (value: string) => value.replace(/\s+/g, " ").trim();
  return {
    fromName: oneLine(renderTemplate(template.fromName, values)).slice(0, NOTIFICATION_LIMITS.fromName),
    subject: oneLine(renderTemplate(template.subject, values)).slice(0, 998) || "(no subject)",
    body: renderBody(template.body, values),
  };
}

/**
 * Renders the body line by line. A line whose placeholders all rendered empty
 * is dropped, so "Open conversation: {{link}}" disappears when there is no link.
 */
function renderBody(template: string, values: NotificationValues): string {
  const lines: string[] = [];
  for (const line of template.split("\n")) {
    const keys = [...line.matchAll(PLACEHOLDER_PATTERN)].map((match) => match[1]);
    const known = keys.filter((key) => Object.hasOwn(values, key));
    const allEmpty =
      known.length > 0 &&
      known.length === keys.length &&
      known.every((key) => !values[key as NotificationPlaceholder].trim());
    if (!allEmpty) lines.push(renderTemplate(line, values));
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Placeholder keys in a template that are not recognized. */
export function unknownPlaceholders(template: string): string[] {
  const known = new Set<string>(NOTIFICATION_PLACEHOLDERS.map((placeholder) => placeholder.key));
  const found = new Set<string>();
  for (const match of template.matchAll(PLACEHOLDER_PATTERN)) {
    if (!known.has(match[1])) found.add(match[1]);
  }
  return [...found];
}
