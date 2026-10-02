// headers.mjs — what the proxy forwards upstream.
//
// Provider prompt caches key on more than the body: session-affinity headers
// (x-session-id, ...), user-agent, anthropic-beta / anthropic-version and
// OpenRouter's HTTP-Referer / X-Title can all steer routing, and routing decides
// which backend's cache is hit. So every header the harness sent is forwarded
// exactly as received (name casing, order, duplicates) except the few that must
// change for the hop to work:
//   host            -> the upstream host
//   content-length  -> the (possibly rewritten) body length
//   hop-by-hop      -> per RFC 9110 they describe one connection, not the request
//   credentials     -> the proxy is the credentialled party: harnesses carry a dummy
//                      key (so their own startup checks pass), which is not forwarded;
//                      the proxy authenticates the request itself

const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-connection", "transfer-encoding", "te",
  "trailer", "upgrade", "proxy-authenticate", "proxy-authorization",
]);
const CREDENTIALS = new Set(["authorization", "x-api-key"]);

/**
 * @param {string[]} rawHeaders  req.rawHeaders: [name, value, name, value, ...]
 * @returns {{list: string[], dropped: string[], replaced: string[]}}
 *   `list` is the flat [name, value, ...] array http.request accepts.
 */
export function forwardHeaders(rawHeaders, { host, apiKey, bodyLength }) {
  const list = [];
  const dropped = [];
  const replaced = [];
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const name = rawHeaders[i];
    const lower = name.toLowerCase();
    if (lower === "host" || lower === "content-length") {
      replaced.push(lower);
    } else if (HOP_BY_HOP.has(lower)) {
      dropped.push(lower);
    } else if (apiKey && CREDENTIALS.has(lower)) {
      replaced.push(lower);
    } else {
      list.push(name, rawHeaders[i + 1]);
    }
  }
  list.push("Host", host, "Content-Length", String(bodyLength));
  if (apiKey) list.push("Authorization", `Bearer ${apiKey}`);
  return { list, dropped, replaced };
}
