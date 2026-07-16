import { request } from "undici";
import { Readable } from "node:stream";
import { createGunzip, createBrotliDecompress, createInflate } from "node:zlib";

/**
 * fetch() replacement that preserves outgoing header casing on the wire.
 *
 * Node's global fetch (undici) normalises header names to lowercase via the
 * WHATWG Headers class. The Stainless SDK (used by native claude-cli) sends
 * PascalCase headers (Accept, User-Agent, X-Stainless-*) over HTTP/1.1.
 * undici.request() bypasses the Headers class and sends keys verbatim.
 */
export async function caseSensitiveFetch(url: string | URL, init: RequestInit): Promise<Response> {
  const headers = init.headers as Record<string, string>;

  const {
    statusCode,
    headers: resHeaders,
    body,
  } = await request(url, {
    method: (init.method as "GET" | "POST") || "GET",
    headers,
    body: init.body as string | undefined,
    signal: (init.signal as AbortSignal) ?? undefined,
  });

  const encoding = String(resHeaders["content-encoding"] || "");
  let stream: Readable = body;
  if (encoding.includes("gzip")) stream = body.pipe(createGunzip());
  else if (encoding.includes("br")) stream = body.pipe(createBrotliDecompress());
  else if (encoding.includes("deflate")) stream = body.pipe(createInflate());

  const responseHeaders = new Headers();
  for (const [key, value] of Object.entries(resHeaders)) {
    if (value === undefined) continue;
    const vals = Array.isArray(value) ? value : [String(value)];
    for (const v of vals) responseHeaders.append(key, v);
  }
  if (encoding) {
    responseHeaders.delete("content-encoding");
    responseHeaders.delete("content-length");
  }

  return new Response(Readable.toWeb(stream) as ReadableStream, {
    status: statusCode,
    headers: responseHeaders,
  });
}
