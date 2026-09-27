import test from "node:test";
import assert from "node:assert/strict";
import { deriveAgentDraftStatus } from "../src/shared/agent-status.ts";

const base = {
  pendingDraftCount: 0,
  runStatus: null,
  agentMode: "draft",
  latestInboundIsAutomated: false,
  lastMessageDirection: "inbound",
};

test("shows active Draft Run states for the latest inbound Message", () => {
  assert.equal(deriveAgentDraftStatus({ ...base, runStatus: "queued" }), "processing");
  assert.equal(deriveAgentDraftStatus({ ...base, runStatus: "generating" }), "processing");
  assert.equal(deriveAgentDraftStatus({ ...base, runStatus: "failed" }), "failed");
  assert.equal(deriveAgentDraftStatus({ ...base, runStatus: "superseded" }), "skipped");
});

test("a pending draft takes precedence over its completed Draft Run", () => {
  assert.equal(
    deriveAgentDraftStatus({ ...base, pendingDraftCount: 1, runStatus: "ready" }),
    "draft_ready",
  );
  assert.equal(deriveAgentDraftStatus({ ...base, runStatus: "ready" }), "processed");
});

test("distinguishes skipped, disabled, and never-processed Messages", () => {
  assert.equal(
    deriveAgentDraftStatus({ ...base, latestInboundIsAutomated: true }),
    "skipped",
  );
  assert.equal(deriveAgentDraftStatus({ ...base, agentMode: "off" }), "off");
  assert.equal(deriveAgentDraftStatus(base), "not_processed");
});

test("does not show an AI status after an outbound reply", () => {
  assert.equal(
    deriveAgentDraftStatus({ ...base, runStatus: "failed", lastMessageDirection: "outbound" }),
    "none",
  );
});
