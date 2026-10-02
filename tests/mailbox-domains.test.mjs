import assert from "node:assert/strict";
import test from "node:test";
import {
  groupMailboxesByDomain,
  mailboxDomain,
  mailboxLocalPart,
} from "../src/shared/mailbox-domains.ts";

test("splits an Inbox address into local part and lowercase domain", () => {
  assert.equal(mailboxDomain("Support@Example.COM"), "example.com");
  assert.equal(mailboxLocalPart("Support@Example.COM"), "Support");
});

test("groups Inboxes by domain with combined unread counts", () => {
  const groups = groupMailboxesByDomain([
    { id: 1, address: "sales@b.test", unread_count: 2 },
    { id: 2, address: "support@a.test", unread_count: 0 },
    { id: 3, address: "billing@B.test", unread_count: 5 },
    { id: 4, address: "hello@a.test", unread_count: 1 },
  ]);
  assert.deepEqual(
    groups.map((group) => [group.domain, group.mailboxes.map((m) => m.id), group.unread_count]),
    [
      ["a.test", [4, 2], 1],
      ["b.test", [3, 1], 7],
    ],
  );
});
