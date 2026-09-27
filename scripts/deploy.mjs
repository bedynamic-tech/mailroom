import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";

const publicKeyName = "VAPID_PUBLIC_KEY";
const privateKeyName = "VAPID_PRIVATE_JWK";
const subjectName = "VAPID_SUBJECT";

function runWrangler(args, { inherit = false } = {}) {
  const require = createRequire(import.meta.url);
  const cli = join(dirname(require.resolve("wrangler/package.json")), "bin/wrangler.js");
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    stdio: inherit ? "inherit" : "pipe",
    env: { ...process.env, FORCE_COLOR: "0" },
  });
  if (result.error) throw result.error;
  return result;
}

function readJson(result, operation) {
  if (result.status !== 0) {
    throw new Error(`${operation} failed. ${result.stderr?.trim() || "Check Cloudflare credentials and connectivity."}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`${operation} returned invalid JSON; refusing to change notification keys.`);
  }
}

function generateKeys() {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = { alg: "ES256", ...privateKey.export({ format: "jwk" }) };
  const publicKey = Buffer.concat([
    Buffer.from([4]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url"),
  ]).toString("base64url");
  return { [publicKeyName]: publicKey, [privateKeyName]: JSON.stringify(jwk) };
}

function validateSubject(value) {
  try {
    const url = new URL(value);
    if (url.protocol === "mailto:" && /^[^\s@]+@[^\s@]+$/.test(url.pathname) && !url.search && !url.hash) return value;
    if (url.protocol === "https:" && !url.username && !url.password) return value;
  } catch { /* Report a configuration error without printing the value. */ }
  throw new Error("VAPID_SUBJECT must be a mailto: contact address or an HTTPS contact URL.");
}

/** Inspect names only: existing private keys never leave Cloudflare. */
export async function deployWithVapid({ config, run = runWrangler, env = process.env, log = console.log }) {
  if (!config.name || !config.configPath) throw new Error("A named Worker and a Wrangler config are required.");
  const configArgs = ["--config", config.configPath];
  const result = run(["secret", "list", ...configArgs, "--format", "json"]);
  // Wrangler 4.124.0 emits this specific diagnostic for a missing Worker.
  // Do not treat arbitrary 404s, auth errors, or failed queries as a new Worker.
  const missingWorker = `Worker "${config.name}" not found. If this is a new Worker, run \`wrangler deploy\` first to create it.`;
  const diagnostic = stripVTControlCharacters(result.stderr ?? "").replace(/\s+/g, " ");
  const notFound = result.status !== 0 && diagnostic.includes(missingWorker);
  const secrets = notFound ? [] : readJson(result, "Listing Worker secrets");
  if (!Array.isArray(secrets) || !secrets.every(secret => typeof secret?.name === "string")) {
    throw new Error("Unexpected secret list; refusing to change notification keys.");
  }
  const configured = new Set([...secrets.map(secret => secret.name), ...Object.keys(config.vars ?? {})]);
  const hasPublic = configured.has(publicKeyName);
  const hasPrivate = configured.has(privateKeyName);
  if (hasPublic !== hasPrivate) {
    throw new Error("Only one VAPID key is configured. Restore the matching VAPID_PUBLIC_KEY / VAPID_PRIVATE_JWK pair; refusing to rotate existing keys.");
  }

  const additions = {};
  if (!configured.has(subjectName)) {
    let subject = env.VAPID_SUBJECT;
    if (!subject) {
      const user = readJson(run(["whoami", ...configArgs, "--json"]), "Reading deployment contact");
      if (user?.loggedIn !== true || typeof user.email !== "string" || !/^[^\s@]+@[^\s@]+$/.test(user.email)) {
        throw new Error("Cannot determine a notification contact. Set VAPID_SUBJECT in the build environment to a mailto: address or HTTPS contact URL, or grant the build token User Details: Read.");
      }
      subject = `mailto:${user.email}`;
      log("Using the Cloudflare deployment user's email as the Web Push contact.");
    }
    additions[subjectName] = validateSubject(subject);
  }
  if (!hasPublic) Object.assign(additions, generateKeys());

  let temporaryDirectory;
  try {
    const args = ["deploy", ...configArgs];
    if (Object.keys(additions).length > 0) {
      temporaryDirectory = await mkdtemp(join(tmpdir(), "mailroom-vapid-"));
      const secretsPath = join(temporaryDirectory, "secrets.json");
      await writeFile(secretsPath, JSON.stringify(additions), { mode: 0o600 });
      args.push("--secrets-file", secretsPath);
    }
    log(hasPublic ? "Preserving existing VAPID keys." : "Initializing VAPID keys with this deployment.");
    const deployed = run(args, { inherit: true });
    if (deployed.status !== 0) throw new Error("Worker deployment failed.");
  } finally {
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length > 2) throw new Error("This deployment script does not accept extra arguments. Configure the build through Wrangler/Vite instead.");
    const { unstable_readConfig } = await import("wrangler");
    // Use the same generated Vite config for inspection and deployment.
    const config = unstable_readConfig({}, { useRedirectIfAvailable: true });
    await deployWithVapid({ config });
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Deployment failed.");
    process.exitCode = 1;
  }
}
