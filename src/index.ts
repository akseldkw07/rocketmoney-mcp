import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildServer } from "./mcp.js";
import { renderAuthPage, submitAuth, triggerLogin, postOtp, smsWebhook } from "./auth-page.js";
import { refreshAuthToken } from "./rm/client.js";
import { sessionStatus } from "./rm/session.js";
import {
  attemptLogin,
  autoLoginConfigured,
  renewDue,
  renewSession,
  nextKeepaliveDelay,
  DEFAULT_RENEW_AFTER_MS,
  onSmsChallenge,
  otpPending,
  submitOtp,
} from "./rm/login.js";
import { isNetworkError } from "./rm/network.js";
import { DEFAULT_CHAT_DB, openMessagesReader, watchForCode } from "./rm/messages-otp.js";
import { newTransactions, budgetSnapshot, requireToken } from "./api.js";
import { installTimestamps } from "./log.js";

// Stamp every log line with the time (launchd's server.log has none of its own).
// ROCKETMONEY_LOG_TIMESTAMPS=0 turns it off, e.g. where the host stamps lines already.
if (!/^(0|false|no)$/i.test(process.env.ROCKETMONEY_LOG_TIMESTAMPS ?? "")) installTimestamps();

const PORT = Number(process.env.PORT ?? 8080);

const app = express();

// ── Local-only guard ───────────────────────────────────────────────
// This build has no front door (upstream assumes Cloudflare Access), so it
// listens on loopback only and rejects requests a web page could forge: a Host
// other than this machine (DNS rebinding) or a cross-site Origin (CSRF).
const LOCAL_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
app.use((req, res, next) => {
  const origin = req.header("origin");
  const host = req.header("host") ?? "";
  if (!LOCAL_HOSTS.has(host) || (origin && !LOCAL_HOSTS.has(origin.replace(/^http:\/\//, "")))) {
    return void res.status(403).json({ ok: false, error: "local requests only" });
  }
  next();
});
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
// Some SMS-forwarder apps POST the raw message as text/plain - capture it as a string.
app.use(express.text({ type: ["text/plain"], limit: "64kb" }));

// ── Health ─────────────────────────────────────────────────────────
app.get("/healthz", (_req, res) => res.status(200).send("ok"));

// ── Browser auth page ─────────────────────────────────────────────
app.get("/", renderAuthPage);
app.get("/auth", renderAuthPage);
app.post("/auth/submit", submitAuth);
app.post("/auth/login", triggerLogin); // trigger headless auto-login
app.post("/auth/otp", postOtp); // feed an SMS code to a parked login run
app.post("/auth/sms", smsWebhook); // phone SMS-forwarder posts the RM code here (shared-secret guarded)

// No browser-extension endpoints: upstream's /auth/ingest and /auth/status were
// open to any website (CORS *). The session is pasted at /auth or comes from
// auto-login; the extension itself was removed 2026-11-22.

// ── Token-guarded JSON API (last N days of transactions) ───────────
// Auth is the ROCKETMONEY_API_TOKEN bearer/?token= check inside the handler,
// NOT Cloudflare Access - this is meant for unattended script callers.
// Stateless snapshot: every read returns the same lookback window. Slugs still
// name independent feeds (they set the `feed` label) but carry no cursor state,
// so there is nothing to advance and no reset route. The bare route is declared
// first; the slug route follows so a bare hit is not read as an empty slug.
app.get("/api/transactions", requireToken, newTransactions);
app.get("/api/transactions/:slug", requireToken, newTransactions);
// Budgets, recurring merchants, upcoming bills and spending in one read, for
// the card gate on lockbox deciding whether a new Essentials charge fits.
app.get("/api/budget", requireToken, budgetSnapshot);

// ── MCP endpoint ──────────────────────────────────────────────────
// Stateless streamable HTTP: a fresh server+transport per request, torn down on
// socket close, so the process holds no per-connection state and Fly can recycle
// it freely. The rotating RM cookie lives on the volume, not in the transport.
app.post("/mcp", async (req, res) => {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("[mcp] request error:", err);
    if (!res.headersSent) res.status(500).json({ error: "internal error" });
  }
});

const methodNotAllowed = (_req: express.Request, res: express.Response) =>
  res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
app.get("/mcp", methodNotAllowed);
app.delete("/mcp", methodNotAllowed);

// ── Keepalive ──────────────────────────────────────────────────────
// There's no offline refresh token, so ping RefreshAuthToken to keep a live
// session from idling out. The idle limit looks like ~30 minutes: with a
// 30-minute keepalive, overnight sessions went re-login -> keepalive ok (+30m) ->
// 401 (+60m), every hour, while a session in active use lasted 4h15m
// (2026-10-29). So ping well inside it. Harmless when there's no session.
const KEEPALIVE_MS = Number(process.env.ROCKETMONEY_KEEPALIVE_MS ?? 10 * 60 * 1000); // 10m
// The keepalive above doesn't stop the session dying, and once Auth0's own 1h
// sign-in cookie has lapsed a re-login needs the form and an SMS code. So a live
// session older than this is renewed silently, headless, while Auth0's sign-in
// is still valid (see renewSession and DEFAULT_RENEW_AFTER_MS in login.ts).
// Checked on each keepalive tick. 0 turns it off.
const RENEW_AFTER_MS = Number(process.env.ROCKETMONEY_RENEW_AFTER_MS ?? DEFAULT_RENEW_AFTER_MS);
/** One keepalive tick. Returns true when Rocket Money was unreachable. */
async function keepalive(): Promise<boolean> {
  // Dead/missing session: fall back to a headless re-login (rate-limited + backed
  // off inside attemptLogin, so this can safely run every keepalive tick). A cold
  // login may park on the SMS challenge; the Messages watcher below or /auth
  // supplies the code.
  if (sessionStatus().status !== "live") {
    if (autoLoginConfigured()) {
      const r = await attemptLogin("keepalive: session not live");
      if (!r.ok && !r.error?.startsWith("rate-limited")) console.warn("[keepalive] auto-login:", r.error);
      return !!r.offline;
    }
    return false;
  }
  try {
    await refreshAuthToken();
    console.log("[keepalive] ok");
  } catch (err) {
    console.warn("[keepalive] failed:", err);
    // A refresh that fails on auth means the session just died; let auto-login
    // (rate-limited) take over on the next tick rather than spinning here.
    return isNetworkError(err);
  }
  if (autoLoginConfigured() && renewDue(sessionStatus(), Date.now(), RENEW_AFTER_MS)) {
    const r = await renewSession("proactive renewal");
    if (r.ok) console.log("[renewal] ok: fresh session, Auth0 sign-in extended");
    else if (!r.error?.startsWith("renewal rate-limited")) console.warn("[renewal] failed:", r.error);
    return !!r.offline;
  }
  return false;
}
// Self-scheduling rather than setInterval: while offline, tick every 2 minutes
// so renewal/login runs as soon as the network is back (nextKeepaliveDelay).
function scheduleKeepalive(delayMs: number): void {
  setTimeout(() => {
    keepalive()
      .catch((err) => {
        console.error("[keepalive] unexpected error:", err);
        return false;
      })
      .then((offline) => scheduleKeepalive(nextKeepaliveDelay(offline, KEEPALIVE_MS)));
  }, delayMs).unref();
}
scheduleKeepalive(KEEPALIVE_MS);

// ── SMS code from Messages ─────────────────────────────────────────
// When a login parks on the SMS challenge, read the code from this Mac's
// Messages database (see messages-otp.ts) and hand it to the login. macOS only;
// ROCKETMONEY_OTP_FROM_MESSAGES=0 turns it off, and /auth keeps working either way.
const OTP_SENDER = process.env.ROCKETMONEY_OTP_SENDER ?? "22395";
const CHAT_DB = process.env.ROCKETMONEY_CHAT_DB ?? DEFAULT_CHAT_DB;
if (process.platform === "darwin" && process.env.ROCKETMONEY_OTP_FROM_MESSAGES !== "0") {
  // Check access once at startup, so a missing Full Disk Access shows up in the
  // log now rather than during an overnight login.
  try {
    openMessagesReader(CHAT_DB, OTP_SENDER);
    console.log(`[otp-messages] on: can read ${CHAT_DB}`);
  } catch (err) {
    console.warn(`[otp-messages] can't read ${CHAT_DB} (grant Full Disk Access to ${process.execPath}):`, err);
  }
  onSmsChallenge((submittedAt) => {
    void (async () => {
      let read: (sinceMs: number) => string[];
      try {
        read = openMessagesReader(CHAT_DB, OTP_SENDER);
      } catch (err) {
        console.warn(`[otp-messages] can't read ${CHAT_DB}; enter the code at /auth:`, err);
        return;
      }
      const since = submittedAt - 5000; // small allowance for clock rounding
      const r = await watchForCode({ read: () => read(since), pending: otpPending, timeoutMs: 4 * 60 * 1000, pollMs: 2000 });
      if ("code" in r) {
        const s = submitOtp(r.code);
        console.log(`[otp-messages] code found in Messages; consumed-by-parked-login=${s.consumed}`);
      } else if ("error" in r) {
        console.warn("[otp-messages] reading Messages failed; enter the code at /auth:", r.error);
      } else {
        console.log(`[otp-messages] stopped: ${r.stopped}`);
      }
    })();
  });
}

app.listen(PORT, "127.0.0.1", () => {
  console.log(`[rocketmoney-mcp] listening on 127.0.0.1:${PORT}  (POST /mcp, GET /auth)`);
});
