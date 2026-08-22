/**
 * perplexityCookieRefresh.ts — opt-in, local-machine Perplexity session-token
 * auto-refresh from the Chromium/Brave cookie store.
 *
 * The `perplexity-web` executor authenticates with the
 * `__Secure-next-auth.session-token` cookie pasted by the operator. When that
 * cookie rotates, the executor answers a plain 401 ("Re-paste your session
 * token"). On a workstation where the operator is *already* logged into
 * Perplexity in Brave/Chrome, the fresh cookie is sitting in the local cookie
 * DB — this module reads and decrypts it so the proxy can self-heal.
 *
 * Ported from the reference relay script
 * `~/tools/perplexity-relay/refresh-token.py` (same decrypt path: PBKDF2-SHA1
 * over the macOS Keychain "… Safe Storage" password, AES-128-CBC, PKCS7, with
 * the newer Chrome sha256(host_key) prefix stripped).
 *
 * ── Guards ────────────────────────────────────────────────────────────────
 *   - Opt-in only: does nothing unless `OMNIROUTE_PERPLEXITY_AUTO_REFRESH=1`.
 *   - Local-machine only: macOS (`darwin`); the Keychain decrypt path is
 *     platform-specific, so on any other platform this returns null (a hosted
 *     OmniRoute install with no local browser simply keeps surfacing the 401).
 *
 * ── Integration (perplexity-web.ts, NOT modified here) ────────────────────
 * In `PerplexityWebExecutor.execute`, the 401/403 branch that currently builds
 * the "session cookie may be expired" error (around the `isCloudflareChallenge`
 * check) is the single integration point. Replace the non-Cloudflare 401 path
 * with a guarded refresh + one retry:
 *
 *   import {
 *     isPerplexityAutoRefreshEnabled,
 *     refreshPerplexitySessionToken,
 *   } from "../services/perplexityCookieRefresh.ts";
 *
 *   if ((status === 401 || status === 403) && !isCloudflareChallenge(response.text)) {
 *     if (isPerplexityAutoRefreshEnabled()) {
 *       const fresh = await refreshPerplexitySessionToken(log);
 *       if (fresh && fresh !== credentials.apiKey) {
 *         await onCredentialsRefreshed?.({ apiKey: fresh });   // persist new cookie
 *         headers["Cookie"] = `__Secure-next-auth.session-token=${fresh}`;
 *         // re-issue the tlsFetchPerplexity(...) call once with the new header,
 *         // then fall through to the normal success/stream handling.
 *       }
 *     }
 *     // If disabled, unavailable, or the refresh yielded the same/no token,
 *     // surface the original 401 unchanged.
 *   }
 */

import { execFileSync } from "node:child_process";
import { createDecipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { join } from "node:path";

import type { ExecutorLog } from "../executors/base.ts";

const COOKIE_NAME = "__Secure-next-auth.session-token";
const HOST_KEYS = ["www.perplexity.ai", ".perplexity.ai"];
const CHROME_EPOCH_OFFSET_SECONDS = 11_644_473_600;

/** True when the operator has explicitly opted in to local cookie auto-refresh. */
export function isPerplexityAutoRefreshEnabled(): boolean {
  return process.env.OMNIROUTE_PERPLEXITY_AUTO_REFRESH === "1";
}

interface BrowserProfile {
  /** Relative dir under ~/Library/Application Support that holds profile dirs. */
  base: string;
  /** macOS Keychain generic-password service name for this browser's cookie key. */
  serviceName: string;
  browser: string;
}

const BROWSERS: BrowserProfile[] = [
  { base: "BraveSoftware/Brave-Browser", serviceName: "Brave Safe Storage", browser: "brave" },
  { base: "Google/Chrome", serviceName: "Chrome Safe Storage", browser: "chrome" },
  { base: "Chromium", serviceName: "Chromium Safe Storage", browser: "chromium" },
  { base: "Microsoft Edge", serviceName: "Microsoft Edge Safe Storage", browser: "edge" },
];

interface CookieDb {
  path: string;
  profile: string;
  serviceName: string;
  browser: string;
}

/** Enumerate candidate cookie DB files across installed Chromium-family browsers. */
function cookieDbPaths(): CookieDb[] {
  const override = process.env.PERPLEXITY_COOKIE_DB;
  if (override) {
    return [
      {
        path: override,
        profile: "override",
        serviceName: "Chrome Safe Storage",
        browser: "chrome",
      },
    ];
  }

  const support = join(homedir(), "Library", "Application Support");
  const out: CookieDb[] = [];
  for (const b of BROWSERS) {
    const root = join(support, b.base);
    let profiles: string[];
    try {
      profiles = readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      continue;
    }
    for (const profile of profiles) {
      for (const rel of [["Cookies"], ["Network", "Cookies"]]) {
        const path = join(root, profile, ...rel);
        if (existsSync(path)) {
          out.push({ path, profile, serviceName: b.serviceName, browser: b.browser });
        }
      }
    }
  }
  return out;
}

interface CookieRow {
  hostKey: string;
  value: string;
  encryptedValue: Buffer;
  expiresUtc: number;
  serviceName: string;
}

/**
 * Read the Perplexity session cookie rows from one DB. Copies the file to a
 * temp path first so a live browser holding the DB doesn't block the read.
 */
async function readCookieRows(db: CookieDb): Promise<CookieRow[]> {
  const { default: Database } = await import("better-sqlite3");
  const dir = mkdtempSync(join(tmpdir(), "pplx-cookies-"));
  const tmp = join(dir, "Cookies");
  try {
    copyFileSync(db.path, tmp);
    const conn = new Database(tmp, { readonly: true, fileMustExist: true });
    try {
      const rows = conn
        .prepare(
          `select host_key as hostKey, value, encrypted_value as encryptedValue, expires_utc as expiresUtc
           from cookies where name = ? and host_key in (?, ?)`
        )
        .all(COOKIE_NAME, HOST_KEYS[0], HOST_KEYS[1]) as Array<{
        hostKey: string;
        value: string | null;
        encryptedValue: Buffer | null;
        expiresUtc: number | null;
      }>;
      return rows.map((r) => ({
        hostKey: r.hostKey || "",
        value: r.value || "",
        encryptedValue: r.encryptedValue ?? Buffer.alloc(0),
        expiresUtc: r.expiresUtc || 0,
        serviceName: db.serviceName,
      }));
    } finally {
      conn.close();
    }
  } catch {
    return [];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Read the browser's cookie-encryption password from the macOS Keychain (targeted lookup). */
function keychainPassword(serviceName: string): Buffer {
  const out = execFileSync("security", ["find-generic-password", "-w", "-s", serviceName], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  const password = out.toString("utf8").replace(/\n$/, "");
  if (!password) throw new Error(`empty Keychain item ${serviceName}`);
  return Buffer.from(password, "utf8");
}

/** Decrypt one Chromium cookie row into its plaintext value. */
function decryptCookie(row: CookieRow): string {
  if (row.value) return row.value.trim();
  const enc = row.encryptedValue;
  if (!enc.length) throw new Error("cookie has no plaintext or encrypted value");

  const prefix = enc.subarray(0, 3).toString("latin1");
  const payload = prefix === "v10" || prefix === "v11" ? enc.subarray(3) : enc;

  const key = pbkdf2Sync(keychainPassword(row.serviceName), "saltysalt", 1003, 16, "sha1");
  const decipher = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
  decipher.setAutoPadding(false);
  let plain = Buffer.concat([decipher.update(payload), decipher.final()]);

  // Strip PKCS7 padding.
  const pad = plain[plain.length - 1];
  if (pad > 0 && pad <= 16) plain = plain.subarray(0, plain.length - pad);

  // Newer Chrome prepends sha256(host_key) to the plaintext; drop it when present.
  const hostDigest = createHash("sha256").update(row.hostKey).digest();
  if (
    plain.length >= hostDigest.length &&
    plain.subarray(0, hostDigest.length).equals(hostDigest)
  ) {
    plain = plain.subarray(hostDigest.length);
  }
  return plain.toString("utf8").trim();
}

/** Loose sanity check that a decrypted value looks like a NextAuth JWE session token. */
function tokenLooksValid(token: string): boolean {
  return token.length >= 100 && token.includes(".") && !token.includes("\n");
}

/**
 * Read + decrypt the freshest non-expired Perplexity session cookie from the
 * local browser cookie store. Returns the token value, or null when disabled,
 * unavailable, or nothing usable is found. Never throws; never logs the token.
 */
export async function refreshPerplexitySessionToken(
  log?: ExecutorLog | null
): Promise<string | null> {
  if (!isPerplexityAutoRefreshEnabled()) return null;
  if (platform() !== "darwin") {
    log?.warn?.("PPLX-COOKIE-REFRESH", "auto-refresh is macOS-only; skipping");
    return null;
  }

  const nowSeconds = Date.now() / 1000;
  const rows: CookieRow[] = [];
  for (const db of cookieDbPaths()) {
    rows.push(...(await readCookieRows(db)));
  }
  // Freshest expiry first.
  rows.sort((a, b) => b.expiresUtc - a.expiresUtc);

  for (const row of rows) {
    if (row.expiresUtc) {
      const expiresUnix = row.expiresUtc / 1_000_000 - CHROME_EPOCH_OFFSET_SECONDS;
      if (expiresUnix < nowSeconds) continue;
    }
    try {
      const token = decryptCookie(row);
      if (tokenLooksValid(token)) {
        log?.info?.("PPLX-COOKIE-REFRESH", `refreshed session token from ${row.hostKey}`);
        return token;
      }
    } catch (err) {
      log?.debug?.(
        "PPLX-COOKIE-REFRESH",
        `decrypt failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  log?.warn?.("PPLX-COOKIE-REFRESH", "no usable Perplexity session cookie found locally");
  return null;
}
