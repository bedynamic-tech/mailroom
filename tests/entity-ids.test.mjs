import test from "node:test";
import assert from "node:assert/strict";
import {
  decodeCursor,
  encodeCursor,
  entityId,
  parseEntityId,
} from "../src/shared/entity-ids.ts";

test("entity ids keep Inbox and Conversation identifiers distinct", () => {
  assert.equal(entityId("inbox", 12), "inbox_12");
  assert.equal(parseEntityId("inbox", "inbox_12"), 12);
  assert.equal(parseEntityId("conversation", "inbox_12"), null);
  assert.equal(parseEntityId("inbox", "inbox_-1"), null);
});

test("conversation cursors round-trip and reject malformed input", () => {
  const cursor = { lastMessageAt: "2026-08-30T10:00:00.000Z", id: 42 };
  assert.deepEqual(decodeCursor(encodeCursor(cursor)), cursor);
  assert.equal(decodeCursor("not-a-cursor"), null);
});
