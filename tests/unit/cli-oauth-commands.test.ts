import test from "node:test";
import assert from "node:assert/strict";

// Provider ids match the server registry (src/shared/constants/providers/oauth.ts):
// `claude` (not "claude-code") and `github` (not "copilot").
const CONNECTIONS = [
  {
    id: "conn1",
    provider: "claude",
    name: "My Claude Code",
    authType: "oauth",
    isActive: true,
    testStatus: "ok",
  },
  {
    id: "conn2",
    provider: "github",
    name: "GitHub Copilot",
    authType: "oauth2",
    isActive: true,
    testStatus: "ok",
  },
  {
    id: "conn3",
    provider: "openai",
    name: "OpenAI Key",
    authType: "api_key",
    isActive: true,
    testStatus: "ok",
  },
];

function makeResp(data: unknown, status = 200) {
  const obj = {
    ok: status < 400,
    status,
    exitCode: status < 400 ? 0 : 1,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
    headers: new Headers(),
  };
  obj.json = obj.json.bind(obj);
  obj.text = obj.text.bind(obj);
  return obj;
}

async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (c: string | Uint8Array) => {
    if (typeof c === "string") chunks.push(c);
    return true;
  };
  try {
    await fn();
  } finally {
    process.stdout.write = orig;
  }
  return chunks.join("");
}

function makeCmd(output = "json") {
  return { optsWithGlobals: () => ({ output, quiet: output !== "table" }) };
}

type OAuthProviderDef = { id: string; name: string; flow: string };
type FetchInit = { method?: string; body?: unknown };

test("runOAuthStatus filtra apenas conexões oauth/oauth2", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = ((url: string) => {
    assert.ok(url.includes("/api/providers"));
    return Promise.resolve(makeResp({ providers: CONNECTIONS }));
  }) as any;

  const { runOAuthStatus } = await import("../../bin/cli/commands/oauth.mjs");
  const out = await captureStdout(() => runOAuthStatus({}, makeCmd() as any));

  globalThis.fetch = origFetch;
  const parsed = JSON.parse(out);
  assert.ok(Array.isArray(parsed));
  assert.equal(parsed.length, 2);
  assert.ok(parsed.every((c: any) => c.authType === "oauth" || c.authType === "oauth2"));
});

test("runOAuthStatus filtra por provider", async () => {
  let capturedUrl = "";
  const origFetch = globalThis.fetch;
  globalThis.fetch = ((url: string) => {
    capturedUrl = url;
    return Promise.resolve(
      makeResp({ providers: CONNECTIONS.filter((c) => c.provider === "claude") })
    );
  }) as any;

  const { runOAuthStatus } = await import("../../bin/cli/commands/oauth.mjs");
  await captureStdout(() => runOAuthStatus({ provider: "claude" }, makeCmd() as any));

  globalThis.fetch = origFetch;
  assert.ok(capturedUrl.includes("provider=claude"));
});

// There is no /api/oauth/<provider>/revoke action on the server: the dynamic
// OAuth route answers "Unknown action" 400 for it
// (src/app/api/oauth/[provider]/[action]/route.ts:898). The only revocation
// primitive is DELETE /api/providers/<connectionId>
// (src/app/api/providers/[id]/route.ts:335), so a revoke without an explicit
// --connection-id must resolve the provider's OAuth connections first.
test("runOAuthRevoke com --yes resolve conexões e usa DELETE em /api/providers", async () => {
  const calls: Array<{ url: string; method: string }> = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = ((url: string, opts: any) => {
    calls.push({ url, method: opts?.method ?? "GET" });
    if (url.includes("/api/providers?")) {
      return Promise.resolve(makeResp({ providers: CONNECTIONS }));
    }
    return Promise.resolve(makeResp({}));
  }) as any;

  const out = await captureStdout(async () => {
    const { runOAuthRevoke } = await import("../../bin/cli/commands/oauth.mjs");
    await runOAuthRevoke({ provider: "claude", yes: true }, makeCmd() as any);
  });

  globalThis.fetch = origFetch;
  assert.ok(calls.some((c) => c.url.includes("/api/providers?") && c.method === "GET"));
  const del = calls.find((c) => c.method === "DELETE");
  assert.ok(del, "expected a DELETE call");
  assert.ok(del!.url.includes("/api/providers/conn1"));
  assert.ok(!calls.some((c) => c.url.includes("/revoke")));
  assert.ok(out.includes("Revoked"));
});

test("runOAuthRevoke com connectionId usa DELETE no provider", async () => {
  let capturedUrl = "";
  let capturedMethod = "";
  const origFetch = globalThis.fetch;
  globalThis.fetch = ((url: string, opts: any) => {
    capturedUrl = url;
    capturedMethod = opts?.method ?? "GET";
    return Promise.resolve(makeResp({}));
  }) as any;

  const out = await captureStdout(async () => {
    const { runOAuthRevoke } = await import("../../bin/cli/commands/oauth.mjs");
    await runOAuthRevoke(
      { provider: "claude", connectionId: "conn1", yes: true },
      makeCmd() as any
    );
  });

  globalThis.fetch = origFetch;
  assert.ok(capturedUrl.includes("/api/providers/conn1"));
  assert.equal(capturedMethod, "DELETE");
  assert.ok(out.includes("Revoked"));
});

test("runOAuthStart flow=import chama POST /api/oauth/cursor/import", async () => {
  let capturedUrl = "";
  let capturedMethod = "";
  const origFetch = globalThis.fetch;
  globalThis.fetch = ((url: string, opts: any) => {
    capturedUrl = url;
    capturedMethod = opts?.method ?? "GET";
    return Promise.resolve(makeResp({ success: true, connection: { id: "c9", email: "a@b.c" } }));
  }) as any;

  const out = await captureStdout(async () => {
    const { runOAuthStart } = await import("../../bin/cli/commands/oauth.mjs");
    await runOAuthStart({ provider: "cursor", token: "tok" }, makeCmd() as any);
  });

  globalThis.fetch = origFetch;
  assert.ok(capturedUrl.includes("/api/oauth/cursor/import"));
  assert.equal(capturedMethod, "POST");
  assert.ok(out.includes("a@b.c"));
});

// /auto-import is a GET and only exists for cursor and kiro. Cursor's variant
// only DISCOVERS credentials (src/app/api/oauth/cursor/auto-import/route.ts:332),
// so the CLI must finish with the POST /import call.
test("runOAuthStart --import-from-system faz GET auto-import e depois POST import", async () => {
  const calls: Array<{ url: string; method: string }> = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = ((url: string, opts?: FetchInit) => {
    calls.push({ url, method: opts?.method ?? "GET" });
    if (url.includes("/auto-import")) {
      return Promise.resolve(makeResp({ found: true, accessToken: "tok", machineId: "m1" }));
    }
    return Promise.resolve(makeResp({ success: true, connection: { id: "c1", email: "x@y.z" } }));
  }) as unknown as typeof globalThis.fetch;

  const out = await captureStdout(async () => {
    const { runOAuthStart } = await import("../../bin/cli/commands/oauth.mjs");
    await runOAuthStart({ provider: "cursor", importFromSystem: true }, makeCmd() as any);
  });

  globalThis.fetch = origFetch;
  assert.equal(calls[0].url.includes("/api/oauth/cursor/auto-import"), true);
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[1].url.includes("/api/oauth/cursor/import"), true);
  assert.equal(calls[1].method, "POST");
  assert.ok(out.includes("x@y.z"));
});

// The server registry has no `claude-code` id, no `copilot` id and no `gemini`
// OAuth provider (src/shared/constants/providers/oauth.ts). The CLI table must
// not advertise ids the server would reject with "Unknown provider".
test("PROVIDERS_WITH_OAUTH usa apenas ids do registro do servidor", async () => {
  const mod = await import("../../bin/cli/commands/oauth.mjs");
  const providers = mod.PROVIDERS_WITH_OAUTH as OAuthProviderDef[];
  const ids = providers.map((p) => p.id);
  for (const stale of ["claude-code", "copilot", "gemini"]) {
    assert.ok(!ids.includes(stale), `stale provider id still present: ${stale}`);
  }
  assert.ok(ids.includes("claude"));
  assert.ok(ids.includes("github"));
  assert.ok(ids.includes("codex"));
  // Flow names must be the server's flowType vocabulary, not invented labels.
  const allowed = new Set([
    "authorization_code",
    "authorization_code_pkce",
    "pkce_callback",
    "device_code",
    "import_token",
    "import",
    "keychain_import",
  ]);
  for (const p of providers) {
    assert.ok(allowed.has(p.flow), `unexpected flow "${p.flow}" for ${p.id}`);
  }
  // claude is PKCE (src/lib/oauth/providers/claude.ts:81), never a device flow.
  assert.equal(providers.find((p) => p.id === "claude")?.flow, "authorization_code_pkce");
});

test("providers lista provedores OAuth conhecidos", async () => {
  const { PROVIDERS_WITH_OAUTH_TEST } = await import("../../bin/cli/commands/oauth.mjs").catch(
    () => ({ PROVIDERS_WITH_OAUTH_TEST: null })
  );
  // validate via runOAuthStart unknown provider exits
  const origExit = process.exit;
  let exitCode: number | undefined;
  process.exit = ((code: number) => {
    exitCode = code;
    throw new Error("exit");
  }) as any;

  try {
    const { runOAuthStart } = await import("../../bin/cli/commands/oauth.mjs");
    await runOAuthStart({ provider: "unknown_provider_xyz" }, makeCmd() as any).catch(() => {});
  } catch {
    // expected
  }

  process.exit = origExit;
  assert.equal(exitCode, 2);
});
