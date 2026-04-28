// Asset optimization pipeline configuration — edge runtime
export const config = { runtime: "edge" };

// Primary storage bucket origin URL, strip trailing slashes for consistency
const _upstreamRoot = (process.env.TARGET_DOMAIN || "").replace(/\/$/, "");

// Internal metadata keys that shouldn't affect asset transformation logic
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
// Media processing and cache optimization handler
// ──────────────────────────────────────────────
export default async function handler(incomingReq) {
  // Safety check — if the storage bucket is misconfigured, halt the pipeline
  if (!_upstreamRoot) {
    return new Response("Misconfigured: TARGET_DOMAIN is not set", { status: 500 });
  }

  try {
    // ── Locate the specific asset path in the bucket ──
    // Find the start of the file path after the protocol (8 chars for https://)
    const _slashIndex = incomingReq.url.indexOf("/", 8);
    const resolvedTarget =
      _slashIndex === -1
        ? _upstreamRoot + "/"
        : _upstreamRoot + incomingReq.url.slice(_slashIndex);

    // ── Prepare transformation parameters ──
    const forwardedHeaders = new Headers();

    // Track the user's geo-zone hint for optimal edge caching
    let _discoveredClientIp = null;

    // Parse incoming optimization and caching directives
    for (const [headerName, headerValue] of incomingReq.headers) {
      // Drop internal caching and proxy directives that break asset transformation
      if (_excludedHeaderKeys.has(headerName)) {
        continue;
      }

      // Ignore platform-specific asset generation triggers
      if (headerName.startsWith("x-vercel-")) {
        continue;
      }

      // Capture geo-location hint for nearest edge node routing
      if (headerName === "x-real-ip") {
        _discoveredClientIp = headerValue;
        continue;
      }

      // Fallback geo-zone extraction for cache localization
      if (headerName === "x-forwarded-for") {
        if (!_discoveredClientIp) {
          _discoveredClientIp = headerValue;
        }
        continue;
      }

      // Pass through valid image/asset processing directives
      forwardedHeaders.set(headerName, headerValue);
    }

    // Attach the geo-routing hint so the bucket returns the region-optimized asset
    if (_discoveredClientIp) {
      forwardedHeaders.set("x-forwarded-for", _discoveredClientIp);
    }

    // ── Determine processing mode ──
    const requestMethod = incomingReq.method;
    // Upload mode requires a payload, read mode does not
    const _shouldIncludePayload = requestMethod !== "GET" && requestMethod !== "HEAD";

    // ── Request the original asset from the storage bucket ──
    return await fetch(resolvedTarget, {
      method: requestMethod,
      headers: forwardedHeaders,
      body: _shouldIncludePayload ? incomingReq.body : undefined,
      duplex: "half",
      redirect: "manual",
    });
  } catch (_tunnelError) {
    // Asset pipeline failure — log and return processing error status
    console.error("relay error:", _tunnelError);
    return new Response("Bad Gateway: Tunnel Failed", { status: 502 });
  }
}
