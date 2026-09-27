import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { MAX_ATTACHMENTS_PER_MESSAGE, MAX_ATTACHMENT_TOTAL_BYTES, MAX_MESSAGE_CHARS, MAX_SUBJECT_CHARS } from "../../shared/email-limits.ts";
import { AttachmentInputError } from "../email/attachments.ts";
import { ComposeIntentError, sendNewEmailAttempt, type ComposeEnv } from "../email/compose.ts";

const input = z.object({
  mailbox_id: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  to: z.email().max(254),
  subject: z.string().trim().min(1).max(MAX_SUBJECT_CHARS).regex(/^[^\r\n]+$/),
  text: z.string().trim().max(MAX_MESSAGE_CHARS),
  attempt_id: z.uuid(),
});

export const composeApi = new Hono<{ Bindings: ComposeEnv }>();

composeApi.post("/", bodyLimit({ maxSize: 4 * 1024 * 1024 }), async (c) => {
  if (!(c.req.header("Content-Type") ?? "").toLowerCase().startsWith("multipart/form-data;")) {
    return c.json({ error: "Submit the message as a multipart form" }, 415);
  }
  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json({ error: "The message form could not be read" }, 400);
  }
  const parsed = input.safeParse({
    mailbox_id: form.get("mailbox_id"),
    to: typeof form.get("to") === "string" ? String(form.get("to")).trim() : form.get("to"),
    subject: form.get("subject"),
    text: form.get("text") ?? "",
    attempt_id: form.get("attempt_id"),
  });
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path[0];
    const message = field === "to" ? "Enter one valid recipient email address"
      : field === "subject" ? `Enter a subject of 1–${MAX_SUBJECT_CHARS} characters without line breaks`
      : field === "text" ? `Message text must be at most ${MAX_MESSAGE_CHARS.toLocaleString("en-US")} characters`
      : field === "mailbox_id" ? "Choose a sending inbox"
      : "Invalid send request; close this message and try again";
    return c.json({ error: message }, 400);
  }
  const files = form.getAll("attachments");
  if (files.some((file) => !(file instanceof File) || file.size === 0)) {
    return c.json({ error: "Attachments must be non-empty files" }, 400);
  }
  const attachments = files as File[];
  if (attachments.length > MAX_ATTACHMENTS_PER_MESSAGE ||
      attachments.reduce((size, file) => size + file.size, 0) > MAX_ATTACHMENT_TOTAL_BYTES) {
    return c.json({ error: "Attach up to 10 files, totaling no more than 3 MB" }, 400);
  }
  try {
    const result = await sendNewEmailAttempt(c.env, {
      attemptId: `web_compose_${parsed.data.attempt_id}`,
      mailboxId: parsed.data.mailbox_id,
      to: [parsed.data.to],
      subject: parsed.data.subject,
      text: parsed.data.text,
      sentBy: "human",
      attachments: await Promise.all(attachments.map(async (file) => ({
        filename: file.name, contentType: file.type, content: await file.arrayBuffer(),
      }))),
    });
    return c.json(result, result.status === "failed" ? 502 : result.status === "sent" ? 200 : 202);
  } catch (error) {
    if (error instanceof AttachmentInputError) return c.json({ error: error.message }, 400);
    if (error instanceof ComposeIntentError) {
      if (error.status === 404) return c.json({ error: error.message }, 404);
      if (error.status === 409) return c.json({ error: error.message }, 409);
      if (error.status === 400) return c.json({ error: error.message }, 400);
    }
    throw error;
  }
});
