// The child side of the capability boundary.
//
// A principal (or any nested runtime) is a child process. It does not hold the
// memory store, it cannot reach it — its `opencode.jsonc` denies
// `external_directory`, and the store lives outside its project directory — and
// it does not get to decide whether a privileged operation happens. All it can
// do is *ask*: it POSTs a capability request to a loopback endpoint its host
// injected into the environment, and the host raises the approval card, decides,
// and runs the trusted in-process handler itself.
//
// Two properties this file exists to guarantee:
//
// 1. **Fail closed.** With no endpoint or no token, there is no fallback path.
//    A request throws `CapabilityUnavailableError` and nothing is read or
//    written. A child that cannot ask must not act.
// 2. **Loopback only.** The endpoint is checked to address this machine before
//    anything is sent. The request body carries memory content, so a poisoned
//    environment variable must not be able to turn "ask my host" into "post the
//    user's memory to a remote host".
//
// The token is issued per turn and dies with it, so a leaked one cannot be
// replayed against a later turn.

export const CAPABILITY_URL_ENV = "MIND_CAPABILITY_URL";
export const CAPABILITY_TOKEN_ENV = "MIND_CAPABILITY_TOKEN";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

// No host endpoint, or one that refused the token: the operation is unavailable
// and the caller must proceed without it rather than reaching for the store.
export class CapabilityUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = "CapabilityUnavailableError";
  }
}

// The host was reached but the request could not be served — a malformed
// request, an ungranted capability, or a handler that threw.
export class CapabilityRequestError extends Error {
  constructor(message, { status = null } = {}) {
    super(message);
    this.name = "CapabilityRequestError";
    this.status = status;
  }
}

// A grant belongs to the turn it was issued for, and to nothing that turn
// spawns. An Alter is a stateless single-use sandbox by design — often one
// chewing on untrusted input — so inheriting a live token would let it ask for
// the user's persistent memory under its parent's name, on a card the user would
// read as the principal's own request. Strip the grant on the way down; each
// level copies from an already stripped environment, so it cannot reappear
// deeper.
export const withoutCapabilityGrant = (env = process.env) => {
  const { [CAPABILITY_URL_ENV]: url, [CAPABILITY_TOKEN_ENV]: token, ...rest } = env;
  return rest;
};

export const resolveCapabilityEndpoint = (env = process.env) => {
  const rawUrl = env[CAPABILITY_URL_ENV];
  const token = env[CAPABILITY_TOKEN_ENV];
  if (!rawUrl || !token) {
    throw new CapabilityUnavailableError(
      `no capability endpoint in this environment (${CAPABILITY_URL_ENV} and ${CAPABILITY_TOKEN_ENV} must both be set)`,
    );
  }
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new CapabilityUnavailableError(`${CAPABILITY_URL_ENV} is not a valid URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new CapabilityUnavailableError(`${CAPABILITY_URL_ENV} must be an http or https URL`);
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new CapabilityUnavailableError(
      `${CAPABILITY_URL_ENV} must address the loopback interface, not ${url.hostname}`,
    );
  }
  return { url: url.toString(), token };
};

// Resolves to `{ decision, value }`. `decision: "deny"` is a real answer, not a
// failure: the user was asked and said no, and the caller must carry on without
// whatever it wanted. Only an unreachable host or an unserviceable request
// throws.
//
// There is deliberately no client-side timeout. On the other end of this request
// is a human reading an approval card, and the run's own timeout already bounds
// the whole turn; a shorter deadline here would only turn slow approvals into
// spurious failures.
export const requestCapability = async (capabilityId, {
  input = undefined,
  reason = null,
  env = process.env,
  signal,
  fetchImpl = globalThis.fetch,
} = {}) => {
  if (typeof capabilityId !== "string" || !capabilityId) throw new CapabilityRequestError("capability id is required");
  if (typeof fetchImpl !== "function") throw new CapabilityUnavailableError("this runtime has no fetch implementation");
  const { url, token } = resolveCapabilityEndpoint(env);
  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ capabilityId, input, reason: reason || undefined }),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new CapabilityUnavailableError(
      `the capability host at ${url} could not be reached: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  const message = payload && typeof payload.error === "string" ? payload.error : `capability host returned ${response.status}`;
  if (response.status === 401) throw new CapabilityUnavailableError(`the capability host rejected this turn's token: ${message}`);
  if (!response.ok) throw new CapabilityRequestError(message, { status: response.status });
  if (!payload || typeof payload !== "object") throw new CapabilityRequestError("capability host returned a malformed response");
  if (payload.ok === false) return { decision: payload.decision || "deny", value: null, error: payload.error || null };
  return { decision: payload.decision || "allow", value: payload.value ?? null, error: null };
};
