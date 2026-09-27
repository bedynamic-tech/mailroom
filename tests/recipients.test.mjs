import assert from "node:assert/strict";
import test from "node:test";
import { dedupeRecipients, replyAllRecipients } from "../src/shared/recipients.ts";

test("Reply all copies the other To and Cc recipients, excluding our Inboxes and the reply target", () => {
  assert.deepEqual(
    replyAllRecipients({
      to: ["Support@YourDomain.com", "colleague@Customer.COM", "help@otherdomain.com"],
      cc: ["manager@customer.com", "colleague@customer.com", "customer@example.com", "undisclosed-recipients:;"],
      replyTargets: ["customer@example.com"],
      ownAddresses: ["support@yourdomain.com", "help@otherdomain.com"],
    }),
    ["colleague@customer.com", "manager@customer.com"],
  );
});

test("Reply all has nothing to add when the email was only sent to us", () => {
  assert.deepEqual(
    replyAllRecipients({
      to: ["support@yourdomain.com"],
      cc: [],
      replyTargets: ["customer@example.com"],
      ownAddresses: ["support@yourdomain.com"],
    }),
    [],
  );
});

test("recipients are deduplicated across fields, keeping the most visible one", () => {
  assert.deepEqual(
    dedupeRecipients({ to: ["a@example.com"], cc: ["A@example.com", "b@example.com"], bcc: ["b@example.com", "c@example.com"] }),
    { to: ["a@example.com"], cc: ["b@example.com"], bcc: ["c@example.com"] },
  );
});
