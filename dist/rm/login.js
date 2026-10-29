import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { addExtra } from "puppeteer-extra";
import Stealth from "puppeteer-extra-plugin-stealth";
import vanilla from "rebrowser-puppeteer-core";
import { seedSession, sessionStatus } from "./session.js";
import { probeSession } from "./client.js"; // circular; runtime-only use
// Auth0/Cloudflare bot-detection flags plain headless Chromium (the CDP
// Runtime.enable leak + navigator.webdriver + headless signals). rebrowser-
// puppeteer-core patches the CDP leak; the stealth plugin patches the fingerprint;
// and we launch HEADFUL (headless is itself the tell - verified: headless is
// blocked, headful reaches the SMS screen). On Fly the process runs under Xvfb so
// "headful" works without a real display.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const puppeteer = addExtra(vanilla);
puppeteer.use(Stealth());
// ── Headless auto-login (Fly-side) ─────────────────────────────────
//
// Rocket Money's web session is a short-lived rolling cookie with no offline
// refresh token (see session.ts). The normal way to keep it alive is the
// rotating cookie jar + RefreshAuthToken keepalive. This module is the FALLBACK
// for when the session has fully died: it drives Auth0's login form in a headless
// Chromium and seeds a fresh `tb.auth0.sid` back into the same jar.
//
// Hard-won constraints from reverse-engineering the flow:
//   * MFA (SMS) fires only on a COLD login from an UNRECOGNIZED device. We keep a
//     PERSISTENT Chromium profile on the Fly volume so, once seeded, Auth0
//     recognizes the device and silently renews (prompt=none) with no SMS.
//   * Auth0 Attack Protection blocks high-velocity auth from one IP. So this is
//     rate-limited with exponential backoff and only ever runs on a dead session.
//   * The persistent profile must be seeded from the SAME egress IP it will run
//     on (here: Fly), or Auth0 treats the IP change as suspicious. The one-time
//     SMS seed therefore happens on Fly, with the code fed in via /auth.
const EMAIL = () => process.env.ROCKETMONEY_EMAIL ?? "";
const PASSWORD = () => process.env.ROCKETMONEY_PASSWORD ?? "";
const CHROMIUM = () => process.env.CHROMIUM_PATH ?? "/usr/bin/chromium";
// Optional SOCKS5/HTTP proxy for Chromium's egress. Auth0 attack-protection
// hard-blocks datacenter IPs, so on Fly we route the login browser through a
// residential exit (a SOCKS5 proxy on the home Mac Mini, reached over Tailscale)
// e.g. ROCKETMONEY_LOGIN_PROXY=socks5://100.93.15.8:7333. Empty = direct.
const PROXY = () => process.env.ROCKETMONEY_LOGIN_PROXY ?? "";
// Whether the login browser runs headless. "0" (default) = always headful, which
// Fly needs: from its datacenter egress headless gets bot-flagged. "auto" = try
// headless first and only open a headful window if that run fails before MFA, so
// on a residential IP (the local Mac) no window pops up. "1" = headless only.
const HEADLESS = () => process.env.ROCKETMONEY_LOGIN_HEADLESS ?? "0";
const STATE_DIR = () => process.env.ROCKETMONEY_STATE_DIR ?? "/data/rocketmoney";
const PROFILE_DIR = () => join(STATE_DIR(), "chrome-profile");
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";
const APP_URL = "https://app.rocketmoney.com/";
/** Auto-login is only attempted when explicitly enabled AND creds are present. */
export function autoLoginConfigured() {
    return process.env.ROCKETMONEY_AUTO_LOGIN === "1" && !!EMAIL() && !!PASSWORD();
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pendingOtp = null;
// A code can arrive (via the SMS webhook) a moment BEFORE the run parks, or after.
// Buffer it briefly so ordering never loses a code: submitOtp resolves a waiter if
// one is parked, else stashes the code; waitForOtp consumes a fresh buffered code
// on arm. TTL keeps a stale code from satisfying a much-later run.
let bufferedCode = null;
const OTP_BUFFER_TTL = 120_000;
/** True while a login run is blocked waiting for the user to submit an SMS code. */
export function otpPending() {
    return pendingOtp !== null;
}
/**
 * Provide an SMS code (from the /auth box or the SMS webhook). Resolves a parked
 * waiter if there is one; otherwise buffers it (TTL) so a code that races ahead of
 * the park still gets used. Returns { consumed } = whether a waiter took it now.
 */
export function submitOtp(code) {
    const c = code.trim();
    if (!c)
        return { accepted: false, consumed: false };
    if (pendingOtp) {
        const w = pendingOtp;
        pendingOtp = null;
        w.resolve(c);
        return { accepted: true, consumed: true };
    }
    bufferedCode = { code: c, at: Date.now() };
    return { accepted: true, consumed: false };
}
/** Disarm an OTP waiter when the run ends, so it can't outlive the browser. */
function cancelOtp() {
    if (!pendingOtp)
        return;
    const w = pendingOtp;
    pendingOtp = null;
    w.resolve(null);
}
function waitForOtp(timeoutMs) {
    // A code that arrived just before we parked is waiting in the buffer - use it.
    if (bufferedCode && Date.now() - bufferedCode.at < OTP_BUFFER_TTL) {
        const c = bufferedCode.code;
        bufferedCode = null;
        return Promise.resolve(c);
    }
    bufferedCode = null; // drop anything stale
    return new Promise((resolve) => {
        pendingOtp = { resolve, since: Date.now() };
        setTimeout(() => {
            if (pendingOtp) {
                pendingOtp = null;
                resolve(null);
            }
        }, timeoutMs);
    });
}
let inFlight = null;
let lastAttempt = 0;
let failures = 0;
function recordResult(reason, r) {
    try {
        const dir = STATE_DIR();
        if (!existsSync(dir))
            mkdirSync(dir, { recursive: true });
        const row = { at: new Date().toISOString(), reason, ...r };
        writeFileSync(join(dir, "login-last.json"), JSON.stringify(row, null, 2));
    }
    catch {
        /* never let bookkeeping break a login */
    }
}
/** The last login run's outcome (survives restarts). Null if none recorded. */
export function lastLoginResult() {
    try {
        return JSON.parse(readFileSync(join(STATE_DIR(), "login-last.json"), "utf8"));
    }
    catch {
        return null;
    }
}
const MIN_INTERVAL_MS = 15 * 60 * 1000; // never re-login more than ~4x/hour
const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000; // cap backoff at 6h
function backoffMs() {
    // 15m, 30m, 60m, ... capped. Keeps us well under Auth0's attack-protection radar.
    return Math.min(MIN_INTERVAL_MS * 2 ** failures, MAX_BACKOFF_MS);
}
/** Human-readable reason the next attempt is (not) allowed yet. */
export function loginCooldownMs() {
    return Math.max(0, backoffMs() - (Date.now() - lastAttempt));
}
/**
 * Attempt a headless login. Deduped (concurrent callers share one run) and
 * rate-limited with exponential backoff on failure. `force` bypasses the
 * cooldown (used by the manual "Log in now" button on /auth).
 */
export function attemptLogin(reason, force = false) {
    if (inFlight)
        return inFlight;
    if (!autoLoginConfigured()) {
        return Promise.resolve({ ok: false, error: "auto-login not configured (set ROCKETMONEY_AUTO_LOGIN=1 + creds)" });
    }
    if (!force && loginCooldownMs() > 0) {
        return Promise.resolve({
            ok: false,
            error: `rate-limited; next attempt in ${Math.ceil(loginCooldownMs() / 60000)}m`,
        });
    }
    inFlight = runLogin(reason)
        .then((r) => {
        // An offline run never reached Auth0, so it doesn't grow the backoff:
        // otherwise hours offline would delay the login after the network returns.
        failures = r.ok ? 0 : r.offline ? failures : failures + 1;
        recordResult(reason, r);
        return r;
    })
        .catch((e) => {
        failures += 1;
        const r = { ok: false, error: String(e?.message ?? e) };
        recordResult(reason, r);
        return r;
    })
        .finally(() => {
        lastAttempt = Date.now();
        inFlight = null;
    });
    return inFlight;
}
/**
 * One login per the HEADLESS mode. A failed headless run is retried headless
 * once: on macOS the headless browser has disconnected right after a SUCCESSFUL
 * form login, leaving the profile signed in, so the retry is a quick warm renewal.
 * Only then does "auto" fall back to a headful window. No retry once a run has
 * reached MFA: a second run would text a second SMS code.
 */
async function runLogin(reason) {
    const mode = HEADLESS();
    if (mode !== "auto" && mode !== "1")
        return doLogin(reason, false);
    let r = await doLogin(reason, true);
    if (r.ok || r.reachedMfa || r.offline)
        return r;
    console.warn(`[auto-login] headless run failed (${r.error}); retrying headless`);
    r = await doLogin(reason, true);
    if (r.ok || r.reachedMfa || r.offline || mode === "1")
        return r;
    console.warn(`[auto-login] headless retry failed (${r.error}); retrying headful`);
    return doLogin(reason, false);
}
// ── DOM helpers ────────────────────────────────────────────────────
async function firstVisible(page, selectors, timeout = 12000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        for (const sel of selectors) {
            try {
                const el = await page.$(sel);
                if (el && (await el.boundingBox()))
                    return el;
            }
            catch {
                // "Execution context was destroyed" - page is mid-navigation. Skip this
                // tick; the element (if any) will be there once navigation settles.
            }
        }
        await sleep(250);
    }
    return null;
}
/** Read the app-domain cookies and return {sid, header}. Tolerant of a navigating page. */
async function readSession(page) {
    try {
        // page.cookies(url) is deprecated in favor of the CDP-backed browser context,
        // but remains the simplest per-URL read and is stable for our use.
        const cookies = await page.cookies(APP_URL);
        const sid = cookies.find((c) => c.name === "tb.auth0.sid")?.value ?? null;
        const header = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
        return { sid, header };
    }
    catch {
        return { sid: null, header: "" }; // navigating; try again next tick
    }
}
// How long a sid that failed its probe waits before it is probed again.
const REPROBE_MS = 10_000;
/**
 * Probe each candidate sid and seed the first live one. A sid that fails is
 * re-probed after REPROBE_MS rather than written off: the session cookie does not
 * rotate on every request (checked 2026-10-29), so the browser can hold one sid
 * value for minutes, and the same value can turn valid later - picked up before
 * the login finished, probed mid-callback, or failed on a network blip. Writing
 * it off for good left a finished login (dashboard on screen) unaccepted until
 * the 5-minute timeout, twice on 2026-10-29.
 */
export function makeSessionAcceptor(probe, seed, now = Date.now) {
    const failedAt = new Map();
    return async (s) => {
        if (!s.sid)
            return false;
        const last = failedAt.get(s.sid);
        if (last !== undefined && now() - last < REPROBE_MS)
            return false;
        const live = await probe(s.header);
        if (!live) {
            if (last === undefined)
                console.log(`[auto-login] sid ${s.sid.slice(0, 8)}… not authenticated yet; re-checking every ${REPROBE_MS / 1000}s`);
            failedAt.set(s.sid, now());
            return false;
        }
        seed(live);
        return true;
    };
}
// ── The login run ──────────────────────────────────────────────────
async function doLogin(reason, headless) {
    const profile = PROFILE_DIR();
    if (!existsSync(profile))
        mkdirSync(profile, { recursive: true });
    // Clear a stale singleton lock from a crashed prior run so launch doesn't hang.
    for (const lock of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
        try {
            rmSync(join(profile, lock), { force: true });
        }
        catch {
            /* best effort */
        }
    }
    const proxy = PROXY();
    console.log(`[auto-login] starting ${headless ? "headless" : "headful"} (${reason})${proxy ? ` via proxy ${proxy}` : ""}`);
    let browser = null;
    try {
        const args = [
            // Container-only flags; on macOS, Chrome keeps its sandbox.
            ...(process.platform === "darwin" ? [] : ["--no-sandbox", "--disable-dev-shm-usage"]),
            "--disable-gpu",
            "--no-first-run",
            "--no-default-browser-check",
            "--window-size=1280,900",
        ];
        // Route all of Chromium's traffic (incl. remote DNS) through the proxy so
        // Auth0 sees the residential exit IP, not Fly's. --proxy-bypass-list=<-loopback>
        // keeps the SOCKS handshake itself direct while sending every real host out.
        if (proxy) {
            args.push(`--proxy-server=${proxy}`, "--proxy-bypass-list=<-loopback>");
        }
        browser = (await puppeteer.launch({
            executablePath: CHROMIUM(),
            // Headful by default (under Xvfb on Fly): headless is what gets bot-flagged
            // there. See HEADLESS for when headless is used instead.
            headless,
            userDataDir: profile,
            args,
            defaultViewport: { width: 1280, height: 900 },
            protocolTimeout: 120000,
        }));
        const page = (await browser.pages())[0] ?? (await browser.newPage());
        await page.setUserAgent(USER_AGENT);
        // Detect a browser/tab death so the poll loop fails fast instead of spinning
        // against a dead page for the full timeout (a headful Chrome can get OOM-killed
        // mid-run). The loop checks this flag every tick.
        let browserDead = false;
        browser.on("disconnected", () => {
            browserDead = true;
        });
        page.on("error", (e) => {
            browserDead = true;
            console.warn(`[auto-login] page crashed: ${e.message}`);
        });
        // domcontentloaded, NOT networkidle2: the app fires a constant stream of
        // analytics/tracker requests (__ps_*, Segment, Datadog, Stripe, Intercom), so
        // over the proxied residential link the network never goes quiet and
        // networkidle2 burns its full timeout and throws.
        //
        // And the goto is non-fatal: over the home SOCKS link the app->Auth0 redirect
        // chain intermittently exceeds the nav budget, but the page usually loaded
        // fine anyway. Catching it lets firstVisible() below poll for the form rather
        // than the whole run dying on a slow (but successful) navigation.
        let navError = "";
        try {
            await page.goto(APP_URL, { waitUntil: "domcontentloaded", timeout: 90000 });
        }
        catch (e) {
            navError = e.message;
            console.warn(`[auto-login] initial nav slow (${e.message}); polling for the form anyway`);
        }
        await sleep(3000);
        // A tb.auth0.sid in the jar is NOT proof of a session: the profile keeps the
        // last one it saw, long after it went stale. Accepting it seeded a dead cookie,
        // which 401'd within minutes and set off another login. So every candidate is
        // checked against the API, and only a working cookie is seeded.
        const acceptSession = makeSessionAcceptor(probeSession, seedSession);
        // Path 1: trusted profile silently renewed -> already have a session.
        if (await acceptSession(await readSession(page))) {
            console.log("[auto-login] warm renewal succeeded (no login form, no MFA)");
            return { ok: true };
        }
        // Path 2: a login form is present -> fill identifier-first Auth0 flow.
        // Generous: every hop here is proxied through the home SOCKS exit, so Auth0's
        // JS can take far longer to render its inputs than on a direct link. A 12s
        // wait raced the render and reported "no login form" while the page was still
        // painting (the failure screenshot showed a fully-rendered form).
        const emailEl = await firstVisible(page, ["input[name='username']", "input[type='email']", "input#username", "input[autocomplete='username']"], 45000);
        if (!emailEl) {
            await snapshot(page, "noform");
            // No network at all (laptop offline / asleep): retrying, least of all in a
            // headful window, can't help, so say so and let the next tick try again.
            if (/net::ERR_(INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|NETWORK_CHANGED|ADDRESS_UNREACHABLE)/.test(navError)) {
                return { ok: false, offline: true, error: `offline (${navError})` };
            }
            return { ok: false, error: "no session and no login form (possible attack-protection block; see noform.png)" };
        }
        await emailEl.click({ count: 3 });
        await emailEl.type(EMAIL(), { delay: 30 });
        let pwEl = await firstVisible(page, ["input[type='password']", "input#password"], 4000);
        if (!pwEl) {
            const cont = await firstVisible(page, ["button[type='submit']", "button[name='action']"]);
            if (cont)
                await cont.click();
            else
                await emailEl.press("Enter");
            await sleep(2500);
            pwEl = await firstVisible(page, ["input[type='password']", "input#password"], 30000);
        }
        if (!pwEl) {
            await snapshot(page, "nopassword");
            return { ok: false, error: "password field never appeared" };
        }
        await pwEl.click({ count: 3 });
        await pwEl.type(PASSWORD(), { delay: 30 });
        const submit = await firstVisible(page, ["button[type='submit']", "button[name='action']", "input[type='submit']"]);
        if (!submit)
            return { ok: false, error: "no submit button after password" };
        await submit.click();
        console.log("[auto-login] credentials submitted");
        // Path 3: watch for either success, or an SMS challenge we must satisfy.
        //
        // The OTP wait is ARMED but never awaited inline: the loop must keep polling
        // the page the whole time. A session can appear while an OTP is outstanding -
        // MFA satisfied out-of-band (someone types the code into the window, a push
        // approval lands, or Auth0 declines to challenge). Awaiting the OTP inline
        // blinded this loop, so a completed login sat unnoticed until timeout.
        const overall = Date.now() + 5 * 60 * 1000; // generous: covers one OTP round-trip
        let otpArmed = false;
        let otpSubmitted = false;
        let inboundCode = null;
        while (Date.now() < overall) {
            await sleep(1500);
            // Bail immediately if the browser/tab died - don't spin on a dead page.
            if (browserDead || page.isClosed()) {
                const why = browserDead ? "browser crashed/disconnected" : "login tab closed";
                return { ok: false, error: `${why} mid-login (check VM memory)` };
            }
            // The whole body is best-effort: the page redirects underneath us (email->
            // password, submit->MFA, MFA->callback), and any call landing mid-navigation
            // throws "Execution context was destroyed". Since this is a poll loop, we
            // just skip the offending tick and try again once navigation settles.
            try {
                // Always check for a session FIRST, on every tick, whatever else is pending.
                if (await acceptSession(await readSession(page))) {
                    console.log(`[auto-login] success${otpArmed ? " (MFA satisfied)" : ""}`);
                    return { ok: true };
                }
                // Arm the OTP waiter once, without blocking this loop.
                if (/mfa-sms-challenge|mfa/.test(page.url()) && !otpArmed) {
                    otpArmed = true;
                    console.log("[auto-login] SMS challenge - waiting for code via /auth or SMS webhook");
                    void waitForOtp(4 * 60 * 1000).then((c) => {
                        inboundCode = c;
                    });
                }
                // A code arrived (via /auth/otp or the SMS webhook) -> type it once.
                if (inboundCode && !otpSubmitted) {
                    const code = inboundCode;
                    inboundCode = null;
                    const codeEl = await firstVisible(page, [
                        "input[name='code']",
                        "input#code",
                        "input[autocomplete='one-time-code']",
                        "input[inputmode='numeric']",
                        "input[type='text']",
                    ]);
                    if (codeEl) {
                        await codeEl.click({ count: 3 });
                        await codeEl.type(code, { delay: 40 });
                        const verify = await firstVisible(page, ["button[type='submit']", "button[name='action']"]);
                        if (verify)
                            await verify.click();
                        otpSubmitted = true;
                        console.log("[auto-login] SMS code submitted");
                    }
                    else {
                        // Page already moved on (e.g. MFA completed another way) - keep polling
                        // for the session rather than failing outright.
                        console.warn("[auto-login] code supplied but no code field; still watching for a session");
                    }
                }
            }
            catch (e) {
                console.warn(`[auto-login] transient (navigating): ${e.message}`);
            }
        }
        await snapshot(page, otpArmed ? "mfa-timeout" : "timeout");
        return {
            ok: false,
            needsOtp: otpArmed && !otpSubmitted,
            reachedMfa: otpArmed,
            error: otpArmed
                ? "reached the SMS challenge but no session appeared (code not supplied in time?)"
                : "timed out without a session cookie",
        };
    }
    finally {
        // Disarm any outstanding OTP waiter: the browser is going away, so a code
        // submitted after this point has nowhere to go (and would leave /auth
        // claiming an OTP is pending forever).
        cancelOtp();
        await browser?.close().catch(() => { });
    }
}
/** Save a debug screenshot to the volume (best effort). */
async function snapshot(page, tag) {
    try {
        await page.screenshot({ path: join(STATE_DIR(), `login-${tag}.png`), fullPage: true });
        console.warn(`[auto-login] saved debug shot login-${tag}.png`);
    }
    catch {
        /* ignore */
    }
}
/** Small status object for the /auth page and MCP session_status. */
export function loginState() {
    return {
        configured: autoLoginConfigured(),
        inFlight: inFlight !== null,
        otpPending: otpPending(),
        cooldownMs: loginCooldownMs(),
        failures,
        sessionStatus: sessionStatus().status,
        lastResult: lastLoginResult(),
    };
}
