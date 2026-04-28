// Relay proxy configuration — edge runtime
export const config = { runtime: "edge" };

// Resolve the upstream destination domain, strip any trailing slash
const _upstreamRoot = (process.env.TARGET_DOMAIN || "").replace(/\/$/, "");

// Collection of hop-by-hop headers that should never be forwarded
const _excludedHeaderKeys = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "forwarded",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-port",
]);

// ──────────────────────────────────────────────
// Main entry point for the edge function
// ──────────────────────────────────────────────
export default async function tunnelEntrypoint(incomingReq) {
  // Safety check — if the destination was never configured, bail early
  if (!_upstreamRoot) {
    return new Response("Misconfigured: TARGET_DOMAIN is not set", { status: 500 });
  }

  try {
    // ── Build the full target URL ──
    // Find where the path begins (skip over "https://" scheme — 8 chars)
    const _slashIndex = incomingReq.url.indexOf("/", 8);
    const resolvedTarget =
      _slashIndex === -1
        ? _upstreamRoot + "/"
        : _upstreamRoot + incomingReq.url.slice(_slashIndex);

    // ── Prepare outgoing headers ──
    const forwardedHeaders = new Headers();

    // Track the client IP we discovered from incoming headers
    let _discoveredClientIp = null;

    // Iterate every incoming header and decide whether to pass it along
    for (const [headerName, headerValue] of incomingReq.headers) {
      // Skip hop-by-hop / proxy-leaking headers
      if (_excludedHeaderKeys.has(headerName)) {
        // intentionally dropped
        continue;
      }

      // Vercel platform headers — never forward upstream
      if (headerName.startsWith("x-vercel-")) {
        continue;
      }

      // Capture real IP but don't forward the original header verbatim
      if (headerName === "x-real-ip") {
        _discoveredClientIp = headerValue;
        continue;
      }

      // Use the rightmost value from x-forwarded-for as a fallback
      if (headerName === "x-forwarded-for") {
        if (!_discoveredClientIp) {
          _discoveredClientIp = headerValue;
        }
        continue;
      }

      // Otherwise, copy the header through unchanged
      forwardedHeaders.set(headerName, headerValue);
    }

    // If we found a client IP anywhere, attach it as x-forwarded-for
    if (_discoveredClientIp) {
      forwardedHeaders.set("x-forwarded-for", _discoveredClientIp);
    }

    // ── Determine method & body ──
    const requestMethod = incomingReq.method;
    const _shouldIncludePayload = requestMethod !== "GET" && requestMethod !== "HEAD";

    // ── Dispatch the request upstream ──
    const upstreamResponse = await fetch(resolvedTarget, {
      method: requestMethod,
      headers: forwardedHeaders,
      body: _shouldIncludePayload ? incomingReq.body : undefined,
      duplex: "half",
      redirect: "manual",
    });

    // Hand the raw upstream response straight back to the client
    return upstreamResponse;
  } catch (_tunnelError) {
    // Something went wrong reaching the upstream — log & return 502
    console.error("relay error:", _tunnelError);
    return new Response("Bad Gateway: Tunnel Failed", { status: 502 });
  }
}
