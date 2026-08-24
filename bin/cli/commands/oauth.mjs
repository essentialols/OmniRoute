import { setTimeout as sleep } from "node:timers/promises";
import { apiFetch } from "../api.mjs";
import { emit } from "../output.mjs";
import { t } from "../i18n.mjs";

/**
 * OAuth command table, aligned with what this server actually implements.
 *
 * Server contract (verified against source, not docs):
 *
 *   GET  /api/oauth/<provider>/authorize             src/app/api/oauth/[provider]/[action]/route.ts:155
 *   GET  /api/oauth/<provider>/device-code           ...route.ts:184
 *   GET  /api/oauth/<provider>/start-callback-server ...route.ts:244
 *   GET  /api/oauth/<provider>/public-link-status    ...route.ts:248
 *   POST /api/oauth/<provider>/exchange              ...route.ts:445
 *   POST /api/oauth/<provider>/poll                  ...route.ts:530
 *   POST /api/oauth/<provider>/poll-callback         ...route.ts:628
 *   POST /api/oauth/<provider>/import-token          ...route.ts:753
 *   POST /api/oauth/<provider>/public-link           ...route.ts:822
 *   POST /api/oauth/<provider>/device-complete       ...route.ts:845
 *
 * Any other action falls through to `{ error: "Unknown action" }` with HTTP 400
 * (GET at route.ts:259, POST at route.ts:898). The previous version of this file
 * called `start`, `status`, `auto-import` and `social-authorize` on that dynamic
 * route, plus `/api/providers/<id>/auth/start|status|apply` for codex/copilot,
 * so every single `omniroute oauth start` invocation was a guaranteed 400/404.
 *
 * A few providers have dedicated concrete routes that shadow the dynamic one:
 *   POST /api/oauth/cursor/import        src/app/api/oauth/cursor/import/route.ts:25
 *   GET  /api/oauth/cursor/auto-import   src/app/api/oauth/cursor/auto-import/route.ts:332
 *   POST /api/oauth/kiro/import          src/app/api/oauth/kiro/import/route.ts
 *   GET  /api/oauth/kiro/auto-import     src/app/api/oauth/kiro/auto-import/route.ts:32
 *   POST /api/oauth/trae/import          src/app/api/oauth/trae/import/route.ts:30
 *
 * Provider ids and flow types come from the server registry, NOT from guesswork:
 *   catalog   src/shared/constants/providers/oauth.ts
 *   handlers  src/lib/oauth/providers/index.ts (+ per-provider flowType)
 *
 * Notably: the id is `claude` (oauth.ts:77, name "Claude Code"), never
 * `claude-code`; `claude` is `authorization_code_pkce` (claude.ts:81), never a
 * device flow; and GitHub Copilot is the `github` id (oauth.ts:104), never
 * `copilot`.
 */
const PROVIDERS_WITH_OAUTH = [
  // authorization_code_pkce: GET authorize -> paste code -> POST exchange (needs codeVerifier)
  { id: "claude", name: "Claude Code", flow: "authorization_code_pkce" },
  { id: "gitlab-duo", name: "GitLab Duo", flow: "authorization_code_pkce" },

  // authorization_code: GET authorize -> paste code -> POST exchange
  { id: "antigravity", name: "Antigravity", flow: "authorization_code" },
  { id: "agy", name: "Antigravity CLI", flow: "authorization_code" },
  { id: "qoder", name: "Qoder", flow: "authorization_code" },
  { id: "cline", name: "Cline", flow: "authorization_code" },
  { id: "clinepass", name: "ClinePass", flow: "authorization_code" },
  { id: "zed-hosted", name: "Zed Hosted Models", flow: "authorization_code" },

  // pkce_callback: GET start-callback-server -> POST poll-callback (loopback server)
  { id: "codex", name: "OpenAI Codex", flow: "pkce_callback" },

  // device_code: GET device-code -> POST poll
  { id: "github", name: "GitHub Copilot", flow: "device_code" },
  { id: "qwen", name: "Qwen Code", flow: "device_code" },
  { id: "kiro", name: "Kiro AI", flow: "device_code" },
  { id: "amazon-q", name: "Amazon Q", flow: "device_code" },
  { id: "kimi-coding", name: "Kimi Coding", flow: "device_code" },
  { id: "kilocode", name: "Kilo Code", flow: "device_code" },
  { id: "codebuddy-cn", name: "CodeBuddy CN", flow: "device_code" },

  // import_token: POST import-token with --token (route.ts:70 IMPORT_TOKEN_PROVIDERS)
  { id: "grok-cli", name: "Grok Build", flow: "import_token" },
  { id: "windsurf", name: "Windsurf (Devin CLI)", flow: "import_token" },
  { id: "devin-cli", name: "Devin CLI (Official)", flow: "import_token" },

  // dedicated import routes (not the generic import-token action)
  { id: "cursor", name: "Cursor IDE", flow: "import" },
  { id: "trae", name: "Trae", flow: "import" },

  // no OAuth flow at all: OS-keychain import only (keychainImportOnly.ts:15)
  { id: "zed", name: "Zed IDE", flow: "keychain_import" },
];

/** Providers whose dedicated /auto-import route exists (GET). */
const AUTO_IMPORT_PROVIDERS = new Set(["cursor", "kiro"]);

/** Providers accepted by the generic POST import-token action (route.ts:70). */
const IMPORT_TOKEN_PROVIDERS = new Set(["windsurf", "devin-cli", "grok-cli"]);

/** Providers wired to the loopback callback server (route.ts:50). */
const PKCE_CALLBACK_PROVIDERS = new Set(["codex"]);

const oauthProviderSchema = [
  { key: "id", header: "Provider ID", width: 16 },
  { key: "name", header: "Name", width: 28 },
  { key: "flow", header: "Flow", width: 24 },
];

const connectionSchema = [
  { key: "id", header: "Connection ID", width: 22 },
  { key: "provider", header: "Provider", width: 16 },
  { key: "name", header: "Name", width: 24 },
  { key: "isActive", header: "Active", formatter: (v) => (v ? "✓" : "✗") },
  { key: "testStatus", header: "Status", width: 12 },
];

async function openBrowser(url) {
  if (!url) return;
  try {
    const { default: open } = await import("open");
    await open(url);
  } catch {
    // open package not available, ignore silently
  }
}

function fail(message, code = 1) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

async function readErrorText(res) {
  try {
    const data = await res.json();
    if (typeof data?.error === "string") return data.error;
    if (data?.error?.message) return String(data.error.message);
    if (data?.message) return String(data.message);
  } catch {
    // not JSON, fall through
  }
  return `HTTP ${res.status}`;
}

async function readLine(prompt) {
  process.stdout.write(prompt);
  return new Promise((resolve) => {
    process.stdin.setEncoding("utf8");
    process.stdin.once("data", (chunk) => resolve(String(chunk).trim()));
  });
}

/**
 * Accept either a bare authorization code or the full redirect URL the browser
 * landed on, because the loopback listener is not running for these flows and
 * the user can only copy the address bar.
 */
function extractCode(input) {
  if (!input) return { code: null, state: null };
  try {
    const url = new URL(input);
    return { code: url.searchParams.get("code"), state: url.searchParams.get("state") };
  } catch {
    return { code: input, state: null };
  }
}

function reportConnection(payload) {
  const conn = payload?.connection ?? {};
  const label = conn.email ?? conn.displayName ?? conn.id ?? "connected";
  process.stdout.write(`Authorized: ${label}\n`);
}

/**
 * authorization_code / authorization_code_pkce.
 * GET authorize (route.ts:155) then POST exchange (route.ts:445).
 * The exchange body is validated by oauthExchangeSchema
 * (src/shared/validation/schemas/auth.ts:121): { code, redirectUri, codeVerifier?, state? }.
 */
async function runAuthorizeCodeFlow(def, opts) {
  const redirectUri = opts.redirectUri ?? "http://localhost:8080/callback";
  const authRes = await apiFetch(
    `/api/oauth/${def.id}/authorize?redirect_uri=${encodeURIComponent(redirectUri)}`,
    { acceptNotOk: true }
  );
  if (!authRes.ok) fail(`Failed to start OAuth for ${def.id}: ${await readErrorText(authRes)}`, 1);

  const authData = await authRes.json();
  if (authData.supported === false || !authData.authUrl) {
    fail(authData.error ?? `Browser OAuth is not available for ${def.id}`, 2);
  }

  process.stdout.write(`\nOpen this URL to authorize:\n  ${authData.authUrl}\n\n`);
  if (opts.browser !== false) await openBrowser(authData.authUrl);

  let code = opts.code ?? null;
  let state = authData.state ?? null;
  if (!code) {
    const answer = await readLine(
      "Paste the authorization code (or the full redirect URL you landed on): "
    );
    const parsed = extractCode(answer);
    code = parsed.code;
    if (parsed.state) state = parsed.state;
  }
  if (!code) fail("No authorization code provided", 2);

  const body = {
    code,
    redirectUri: authData.redirectUri ?? redirectUri,
    state,
  };
  // route.ts:450 rejects a PKCE exchange without codeVerifier.
  if (authData.codeVerifier) body.codeVerifier = authData.codeVerifier;

  const exRes = await apiFetch(`/api/oauth/${def.id}/exchange`, {
    method: "POST",
    body,
    acceptNotOk: true,
  });
  if (!exRes.ok) fail(`OAuth exchange failed: ${await readErrorText(exRes)}`, exRes.exitCode ?? 1);
  const result = await exRes.json();
  if (result.success === false) fail(`OAuth exchange failed: ${result.error ?? "unknown"}`, 1);
  reportConnection(result);
}

/**
 * pkce_callback (codex only, route.ts:50).
 * GET start-callback-server (route.ts:244) spins a loopback listener server-side,
 * then POST poll-callback (route.ts:628) drains it. `pending: true` means keep polling.
 */
async function runPkceCallbackFlow(def, opts) {
  const startRes = await apiFetch(`/api/oauth/${def.id}/start-callback-server`, {
    acceptNotOk: true,
  });
  if (!startRes.ok) {
    fail(`Failed to start callback server for ${def.id}: ${await readErrorText(startRes)}`, 1);
  }
  const start = await startRes.json();
  if (!start.authUrl) fail(`No authorize URL returned for ${def.id}`, 1);

  process.stdout.write(`\nOpen this URL to authorize:\n  ${start.authUrl}\n\n`);
  if (opts.browser !== false) await openBrowser(start.authUrl);
  process.stderr.write("Waiting for the OAuth callback... (Ctrl+C to cancel)\n");

  const deadline = Date.now() + (opts.timeout ?? 300000);
  while (Date.now() < deadline) {
    await sleep(2000);
    const pollRes = await apiFetch(`/api/oauth/${def.id}/poll-callback`, {
      method: "POST",
      body: {},
      acceptNotOk: true,
    });
    if (!pollRes.ok) continue;
    const data = await pollRes.json();
    if (data.success) return reportConnection(data);
    if (data.pending) continue;
    fail(`OAuth failed: ${data.errorDescription ?? data.error ?? "unknown"}`, 1);
  }
  fail("Timeout waiting for OAuth callback", 124);
}

/**
 * device_code.
 * GET device-code (route.ts:184) then POST poll (route.ts:530). The poll body is
 * oauthPollSchema (auth.ts:128): { deviceCode, codeVerifier?, extraData? }.
 * kiro/amazon-q need `extraData` (clientId/clientSecret) echoed back (route.ts:548).
 */
async function runDeviceCodeFlow(def, opts) {
  const query = new URLSearchParams();
  if (opts.startUrl) query.set("startUrl", opts.startUrl);
  if (opts.region) query.set("region", opts.region);
  const suffix = query.toString() ? `?${query}` : "";

  const startRes = await apiFetch(`/api/oauth/${def.id}/device-code${suffix}`, {
    acceptNotOk: true,
  });
  if (!startRes.ok) {
    fail(`Failed to start device flow for ${def.id}: ${await readErrorText(startRes)}`, 1);
  }
  const start = await startRes.json();

  const userCode = start.userCode ?? start.user_code ?? "";
  const verificationUri =
    start.verificationUriComplete ??
    start.verification_uri_complete ??
    start.verificationUri ??
    start.verification_uri ??
    "";
  process.stdout.write(`\nDevice code: ${userCode}\nVisit: ${verificationUri}\n\n`);
  if (opts.browser !== false) await openBrowser(verificationUri);
  process.stderr.write("Waiting for device authorization... (Ctrl+C to cancel)\n");

  const deviceCode = start.deviceCode ?? start.device_code;
  if (!deviceCode) fail("Server did not return a device code", 1);

  const intervalMs = Math.max(1, Number(start.interval ?? start.intervalMs ?? 5)) * 1000;
  const deadline = Date.now() + (opts.timeout ?? 300000);
  while (Date.now() < deadline) {
    await sleep(intervalMs);
    const pollRes = await apiFetch(`/api/oauth/${def.id}/poll`, {
      method: "POST",
      body: {
        deviceCode,
        ...(start.codeVerifier ? { codeVerifier: start.codeVerifier } : {}),
        ...(start.extraData ? { extraData: start.extraData } : {}),
      },
      acceptNotOk: true,
    });
    if (!pollRes.ok) continue;
    const data = await pollRes.json();
    if (data.success) return reportConnection(data);
    if (data.pending) continue;
    fail(`Device auth failed: ${data.errorDescription ?? data.error ?? "unknown"}`, 1);
  }
  fail("Timeout waiting for device authorization", 124);
}

/**
 * import_token (route.ts:753). Only windsurf, devin-cli and grok-cli are accepted
 * by IMPORT_TOKEN_PROVIDERS (route.ts:70); everything else gets an explicit 400.
 */
async function runImportTokenFlow(def, opts) {
  const token = opts.token ?? process.env.OMNIROUTE_OAUTH_TOKEN ?? null;
  if (!token) {
    fail(`--token <value> is required for ${def.id} (paste the token from the vendor IDE/CLI)`, 2);
  }
  const res = await apiFetch(`/api/oauth/${def.id}/import-token`, {
    method: "POST",
    body: { token, ...(opts.connectionId ? { connectionId: opts.connectionId } : {}) },
    acceptNotOk: true,
  });
  if (!res.ok) fail(`Token import failed: ${await readErrorText(res)}`, res.exitCode ?? 1);
  const data = await res.json();
  if (data.success === false) fail(`Token import failed: ${data.error ?? "unknown"}`, 1);
  reportConnection(data);
}

/**
 * Dedicated per-provider import routes.
 * --import-from-system uses GET /auto-import, which only exists for cursor
 * (cursor/auto-import/route.ts:332) and kiro (kiro/auto-import/route.ts:32).
 * Cursor's auto-import only DISCOVERS credentials, so they are then POSTed to
 * /api/oauth/cursor/import (cursor/import/route.ts:25); kiro's auto-import
 * performs the whole import itself.
 */
async function runDedicatedImportFlow(def, opts) {
  if (opts.importFromSystem) {
    if (!AUTO_IMPORT_PROVIDERS.has(def.id)) {
      fail(
        `--import-from-system is not supported for ${def.id}. Supported: ${[...AUTO_IMPORT_PROVIDERS].join(", ")}`,
        2
      );
    }
    const res = await apiFetch(`/api/oauth/${def.id}/auto-import`, { acceptNotOk: true });
    if (!res.ok) fail(`Auto-import failed: ${await readErrorText(res)}`, res.exitCode ?? 1);
    const data = await res.json();
    if (data.found === false) {
      fail(data.error ?? `No local ${def.name} credentials found`, 2);
    }
    // kiro auto-import persists the connection itself.
    if (data.success || data.connection) return reportConnection(data);
    // cursor auto-import only discovers; finish with the import POST.
    const importRes = await apiFetch(`/api/oauth/${def.id}/import`, {
      method: "POST",
      body: {
        accessToken: data.accessToken,
        ...(data.machineId ? { machineId: data.machineId } : {}),
      },
      acceptNotOk: true,
    });
    if (!importRes.ok) fail(`Import failed: ${await readErrorText(importRes)}`, 1);
    return reportConnection(await importRes.json());
  }

  const token = opts.token ?? process.env.OMNIROUTE_OAUTH_TOKEN ?? null;
  if (!token) {
    fail(
      `--token <value> is required for ${def.id}, or pass --import-from-system to read local credentials`,
      2
    );
  }
  const res = await apiFetch(`/api/oauth/${def.id}/import`, {
    method: "POST",
    body: {
      accessToken: token,
      ...(opts.machineId ? { machineId: opts.machineId } : {}),
    },
    acceptNotOk: true,
  });
  if (!res.ok) fail(`Import failed: ${await readErrorText(res)}`, res.exitCode ?? 1);
  reportConnection(await res.json());
}

/** zed has no OAuth flow at all (keychainImportOnly.ts:15). */
function runKeychainImportFlow(def) {
  fail(
    `${def.name} has no OAuth flow. Its LLM credentials live in the OS keychain: ` +
      `use the Import button on the ${def.id} provider card in the dashboard.`,
    2
  );
}

export async function runOAuthStart(opts, cmd) {
  const def = PROVIDERS_WITH_OAUTH.find((p) => p.id === opts.provider);
  if (!def) {
    process.stderr.write(
      `Unknown OAuth provider: ${opts.provider}\nRun: omniroute oauth providers\n`
    );
    process.exit(2);
    return;
  }
  switch (def.flow) {
    case "authorization_code":
    case "authorization_code_pkce":
      return runAuthorizeCodeFlow(def, opts);
    case "pkce_callback":
      return runPkceCallbackFlow(def, opts);
    case "device_code":
      return runDeviceCodeFlow(def, opts);
    case "import_token":
      return runImportTokenFlow(def, opts);
    case "import":
      return runDedicatedImportFlow(def, opts);
    case "keychain_import":
      return runKeychainImportFlow(def);
    default:
      return fail(`Unsupported flow "${def.flow}" for ${def.id}`, 2);
  }
}

export async function runOAuthStatus(opts, cmd) {
  const globalOpts = cmd.optsWithGlobals();
  const params = new URLSearchParams();
  if (opts.provider) params.set("provider", opts.provider);
  const res = await apiFetch(`/api/providers?${params}`);
  if (!res.ok) {
    process.stderr.write(`Error: ${res.status}\n`);
    process.exit(1);
  }
  const data = await res.json();
  const connections = (data.providers ?? data.items ?? data).filter(
    (c) => c.authType === "oauth" || c.authType === "oauth2"
  );
  emit(connections, globalOpts, connectionSchema);
}

/**
 * Revoke by DELETEing the connection row.
 *
 * There is no `/api/oauth/<provider>/revoke` action on this server: it would hit
 * the dynamic route's `Unknown action` 400 (route.ts:898). The only revocation
 * primitive is DELETE /api/providers/<connectionId>
 * (src/app/api/providers/[id]/route.ts:335), so without an explicit
 * --connection-id we resolve the provider's OAuth connections first.
 */
export async function runOAuthRevoke(opts, cmd) {
  let ids = opts.connectionId ? [opts.connectionId] : [];

  if (ids.length === 0) {
    const params = new URLSearchParams();
    if (opts.provider) params.set("provider", opts.provider);
    const listRes = await apiFetch(`/api/providers?${params}`, { acceptNotOk: true });
    if (!listRes.ok) fail(`Error: ${await readErrorText(listRes)}`, listRes.exitCode ?? 1);
    const data = await listRes.json();
    const rows = data.providers ?? data.items ?? data;
    ids = (Array.isArray(rows) ? rows : [])
      .filter(
        (c) =>
          c.provider === opts.provider && (c.authType === "oauth" || c.authType === "oauth2")
      )
      .map((c) => c.id)
      .filter(Boolean);
    if (ids.length === 0) fail(`No OAuth connections found for ${opts.provider}`, 2);
  }

  if (!opts.yes) {
    const answer = await readLine(
      `Revoke ${ids.length} OAuth connection(s) for ${opts.provider}? (yes/no) `
    );
    if (!answer.toLowerCase().startsWith("y")) process.exit(0);
  }

  for (const id of ids) {
    const res = await apiFetch(`/api/providers/${id}`, { method: "DELETE", acceptNotOk: true });
    if (!res.ok) fail(`Error revoking ${id}: ${await readErrorText(res)}`, res.exitCode ?? 1);
  }
  process.stdout.write(`Revoked ${ids.length} connection(s)\n`);
}

export function registerOAuth(program) {
  const oauth = program.command("oauth").description(t("oauth.description"));

  oauth
    .command("providers")
    .description(t("oauth.providers.description"))
    .action(async (opts, cmd) => {
      emit(PROVIDERS_WITH_OAUTH, cmd.optsWithGlobals(), oauthProviderSchema);
    });

  oauth
    .command("start")
    .description(t("oauth.start.description"))
    .requiredOption("--provider <id>", t("oauth.start.provider"))
    .option("--no-browser", t("oauth.start.no_browser"))
    .option("--import-from-system", t("oauth.start.import_system"))
    .option("--token <value>", t("oauth.start.token"))
    .option("--code <value>", t("oauth.start.code"))
    .option("--redirect-uri <url>", t("oauth.start.redirect_uri"))
    .option("--connection-id <id>", t("oauth.start.connection_id"))
    .option("--machine-id <id>", t("oauth.start.machine_id"))
    .option("--start-url <url>", t("oauth.start.start_url"))
    .option("--region <region>", t("oauth.start.region"))
    .option("--timeout <ms>", t("oauth.start.timeout"), parseInt, 300000)
    .action(runOAuthStart);

  oauth
    .command("status")
    .description(t("oauth.status.description"))
    .option("--provider <id>", t("oauth.status.provider"))
    .action(runOAuthStatus);

  oauth
    .command("revoke")
    .description(t("oauth.revoke.description"))
    .requiredOption("--provider <id>", t("oauth.revoke.provider"))
    .option("--connection-id <id>", t("oauth.revoke.connection_id"))
    .option("--yes", t("oauth.revoke.yes"))
    .action(runOAuthRevoke);
}

export { PROVIDERS_WITH_OAUTH, IMPORT_TOKEN_PROVIDERS, PKCE_CALLBACK_PROVIDERS };
