import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildPushHTTPRequest } from "@pushforge/builder";
import { importJWK, jwtVerify } from "jose";
import { deployWithVapid } from "../scripts/deploy.mjs";

const config = { name: "mailroom-test", configPath: "/project/dist/worker/wrangler.json" };
const keyNames = ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_JWK"];
const allNames = [...keyNames, "VAPID_SUBJECT"];
const json = value => ({ status: 0, stdout: JSON.stringify(value), stderr: "" });

function fixture({ names = [], listed, user = { loggedIn: true, email: "owner@example.com" }, deployStatus = 0, deployError } = {}) {
  const calls = [];
  const messages = [];
  let uploaded;
  let file;
  const run = (args, options) => {
    calls.push(args);
    assert.deepEqual(args.slice(args.indexOf("--config"), args.indexOf("--config") + 2), ["--config", config.configPath]);
    if (args[0] === "secret") return listed ?? json(names.map(name => ({ name, type: "secret_text" })));
    if (args[0] === "whoami") return json(user);
    assert.equal(args[0], "deploy");
    assert.equal(options.inherit, true);
    const index = args.indexOf("--secrets-file");
    if (index !== -1) {
      file = args[index + 1];
      assert.equal(statSync(file).mode & 0o777, 0o600);
      uploaded = JSON.parse(readFileSync(file, "utf8"));
    }
    if (deployError) throw deployError;
    return { status: deployStatus };
  };
  return {
    calls, messages,
    get uploaded() { return uploaded; },
    get file() { return file; },
    deploy: (overrides = {}) => deployWithVapid({ config, run, env: {}, log: message => messages.push(message), ...overrides }),
  };
}

test("first deploy uploads matching keys usable by PushForge and cleans up the secret file", async () => {
  const f = fixture();
  await f.deploy();
  assert.deepEqual(Object.keys(f.uploaded).sort(), allNames.toSorted());
  assert.equal(f.uploaded.VAPID_SUBJECT, "mailto:owner@example.com");
  assert.equal(existsSync(f.file), false);
  const jwk = JSON.parse(f.uploaded.VAPID_PRIVATE_JWK);
  assert.equal(jwk.crv, "P-256");
  const raw = Buffer.from(f.uploaded.VAPID_PUBLIC_KEY, "base64url");
  assert.equal(raw.length, 65);
  assert.equal(raw[0], 4);
  assert.equal(raw.subarray(1, 33).toString("base64url"), jwk.x);
  assert.equal(raw.subarray(33).toString("base64url"), jwk.y);
  assert.ok(!f.messages.join(" ").includes(jwk.d));

  const subscriber = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({ format: "jwk" });
  const subscriberKey = Buffer.concat([Buffer.from([4]), Buffer.from(subscriber.x, "base64url"), Buffer.from(subscriber.y, "base64url")]).toString("base64url");
  const request = await buildPushHTTPRequest({
    privateJWK: f.uploaded.VAPID_PRIVATE_JWK,
    subscription: {
      endpoint: "https://push.example.com/subscription",
      keys: { p256dh: subscriberKey, auth: randomBytes(16).toString("base64url") },
    },
    message: { payload: { title: "Test" }, adminContact: f.uploaded.VAPID_SUBJECT },
  });
  const authorization = new Headers(request.headers).get("authorization");
  const token = authorization.match(/t=([^, ]+)/)[1];
  const publicJwk = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
  const { payload } = await jwtVerify(token, await importJWK(publicJwk, "ES256"), { audience: "https://push.example.com" });
  assert.equal(payload.sub, "mailto:owner@example.com");
});

test("a Worker that does not exist yet is initialized on its first code upload", async () => {
  const f = fixture({ listed: {
    status: 1, stdout: "", stderr: '\u001b[31m✘ [ERROR]\u001b[0m Worker "mailroom-test" not found.\n  \n  If this is a new Worker, run `wrangler deploy` first to create it.\n  Otherwise, check the Worker name.',
  } });
  await f.deploy();
  assert.ok(f.uploaded.VAPID_PRIVATE_JWK);
  assert.equal(f.calls.filter(call => call[0] === "deploy").length, 1);
});

test("the pinned Wrangler CLI's actual missing-Worker diagnostic is recognized", async () => {
  const logDirectory = await mkdtemp(join(tmpdir(), "mailroom-wrangler-test-"));
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ success: false, errors: [{ code: 10007, message: "Worker not found" }], result: null }));
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const listed = await new Promise(resolve => {
      execFile(process.execPath, [
        "node_modules/wrangler/bin/wrangler.js", "secret", "list", "--config", "wrangler.jsonc",
        "--name", config.name, "--format", "json",
      ], {
        timeout: 15000,
        env: {
          ...process.env,
          CLOUDFLARE_API_TOKEN: "test-token",
          CLOUDFLARE_ACCOUNT_ID: "0".repeat(32),
          CLOUDFLARE_API_BASE_URL: `http://127.0.0.1:${server.address().port}/client/v4`,
          HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "",
          http_proxy: "", https_proxy: "", all_proxy: "",
          WRANGLER_SEND_METRICS: "false",
          WRANGLER_LOG_PATH: join(logDirectory, "wrangler.log"),
        },
      }, (error, stdout, stderr) => resolve({ status: error?.code ?? 0, stdout, stderr }));
    });
    assert.equal(listed.status, 1);
    assert.ok(requests.some(path => path.endsWith(`/workers/scripts/${config.name}/secrets`)));
    const f = fixture({ listed });
    await f.deploy();
    assert.ok(f.uploaded.VAPID_PRIVATE_JWK);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(logDirectory, { recursive: true, force: true });
  }
});

test("subsequent deployments preserve secrets without reading identity or writing a file", async () => {
  const f = fixture({ names: allNames });
  await f.deploy();
  assert.equal(f.file, undefined);
  assert.deepEqual(f.calls.map(call => call[0]), ["secret", "deploy"]);
});

test("adding a missing subject leaves existing subscription keys untouched", async () => {
  const f = fixture({ names: keyNames });
  await f.deploy();
  assert.deepEqual(f.uploaded, { VAPID_SUBJECT: "mailto:owner@example.com" });
});

test("existing contact and configured public key are preserved", async () => {
  const f = fixture({ names: ["VAPID_PRIVATE_JWK"] });
  await f.deploy({ config: { ...config, vars: { VAPID_PUBLIC_KEY: "existing", VAPID_SUBJECT: "mailto:existing@example.com" } } });
  assert.equal(f.file, undefined);
  assert.deepEqual(f.calls.map(call => call[0]), ["secret", "deploy"]);
});

test("an existing contact with no keys initializes just the key pair", async () => {
  const f = fixture({ names: ["VAPID_SUBJECT"] });
  await f.deploy();
  assert.deepEqual(Object.keys(f.uploaded).sort(), keyNames.toSorted());
  assert.ok(!f.calls.some(call => call[0] === "whoami"));
});

test("custom build contact supports restricted tokens without a user lookup", async () => {
  const f = fixture();
  await f.deploy({ env: { VAPID_SUBJECT: "https://example.com/contact" } });
  assert.equal(f.uploaded.VAPID_SUBJECT, "https://example.com/contact");
  assert.ok(!f.calls.some(call => call[0] === "whoami"));
});

test("partial key pairs stop before generating replacements or deploying", async () => {
  for (const name of keyNames) {
    const f = fixture({ names: [name] });
    await assert.rejects(f.deploy(), /refusing to rotate/);
    assert.deepEqual(f.calls.map(call => call[0]), ["secret"]);
  }
});

test("authentication errors, generic 404s and malformed responses never initialize keys", async () => {
  for (const listed of [
    { status: 1, stderr: "Authentication error [code: 10000]" },
    { status: 1, stderr: "Network request failed" },
    { status: 1, stderr: "404 Not Found" },
    { status: 0, stdout: "not JSON" },
    json({ errors: [] }),
    json([{}]),
  ]) {
    const f = fixture({ listed });
    await assert.rejects(f.deploy());
    assert.deepEqual(f.calls.map(call => call[0]), ["secret"]);
    assert.equal(f.file, undefined);
  }
});

test("a missing identity or invalid contact stops before deployment", async () => {
  const f = fixture({ user: { loggedIn: true } });
  await assert.rejects(f.deploy(), /Set VAPID_SUBJECT/);
  assert.ok(!f.calls.some(call => call[0] === "deploy"));
  for (const subject of ["owner@example.com", "http://example.com", "mailto:", "mailto:bad email@example.com"]) {
    const invalid = fixture();
    await assert.rejects(invalid.deploy({ env: { VAPID_SUBJECT: subject } }), /must be/);
    assert.equal(invalid.file, undefined);
  }
});

test("failed uploads and command errors also remove their private-key files", async () => {
  for (const options of [{ deployStatus: 1 }, { deployError: new Error("spawn failed") }]) {
    const f = fixture(options);
    await assert.rejects(f.deploy());
    assert.ok(f.file);
    assert.equal(existsSync(f.file), false);
  }
});
