import assert from "node:assert/strict";
import test from "node:test";
import { inlineAttachmentIds } from "../src/web/inline-images.ts";

const attachment = (id, content_id) => ({ id, filename: `${id}.png`, content_type: "image/png", size: 1, content_id });

test("treats images the HTML shows through cid links as part of the message", () => {
  const attachments = [
    attachment("attachment_1", "<Logo123@Example.com>"),
    attachment("attachment_2", "unused@example.com"),
    attachment("attachment_3", null),
  ];
  const html = '<p>Thanks</p><img src="cid:logo123@example.com" alt="Logo">';
  assert.deepEqual([...inlineAttachmentIds(html, attachments)], ["attachment_1"]);
  assert.equal(inlineAttachmentIds("<p>No images</p>", attachments).size, 0);
});
