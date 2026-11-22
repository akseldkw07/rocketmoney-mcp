// Telling "the network is down" from "Rocket Money said no". A login that fails
// because the Mac's connection dropped or stalled (Wi-Fi blip, sleep, a reset)
// can't be fixed by another browser run, least of all a visible window, so the
// login path checks for these and waits instead. Anything that got an HTTP
// answer from Rocket Money is NOT a network error: that goes through the normal
// failure handling with its full error.
// Node / undici error codes for a request that never got an answer.
const NODE_CODES = new Set([
    "ECONNRESET",
    "ECONNREFUSED",
    "ECONNABORTED",
    "ETIMEDOUT",
    "ENOTFOUND",
    "EAI_AGAIN",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "ENETDOWN",
    "EPIPE",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_BODY_TIMEOUT",
    "UND_ERR_SOCKET",
    "UND_ERR_CLOSED",
]);
// Chrome's own codes for the same (page.goto messages: "net::ERR_X at <url>").
// Certificate and HTTP errors are deliberately absent: those got an answer.
const CHROME = /net::ERR_(INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|NAME_RESOLUTION_FAILED|NETWORK_CHANGED|ADDRESS_UNREACHABLE|NETWORK_IO_SUSPENDED|TIMED_OUT|EMPTY_RESPONSE|PROXY_CONNECTION_FAILED|SOCKS_CONNECTION_FAILED|CONNECTION_(RESET|CLOSED|TIMED_OUT|REFUSED|ABORTED|FAILED))\b/;
/** True when `err` (or anything in its cause chain) is a failure to reach the server at all. */
export function isNetworkError(err) {
    for (let e = err, depth = 0; e && depth < 5; e = e.cause, depth++) {
        if (typeof e !== "object")
            return false;
        const o = e;
        if (typeof o.code === "string" && NODE_CODES.has(o.code))
            return true;
        if (o.name === "TimeoutError" || o.name === "AbortError")
            return true;
        if (typeof o.message === "string" && (CHROME.test(o.message) || /^Navigation timeout of \d+ ms exceeded/.test(o.message)))
            return true;
    }
    return false;
}
/** "TypeError: fetch failed (ENOTFOUND: getaddrinfo ENOTFOUND app.rocketmoney.com)": the error with its causes. */
export function describeNetworkError(err) {
    const parts = [];
    for (let e = err, depth = 0; e && depth < 5; e = e.cause, depth++) {
        const o = e;
        parts.push(depth === 0 ? `${o.name ?? "Error"}: ${o.message ?? String(e)}` : `${o.code ? `${o.code}: ` : ""}${o.message ?? String(e)}`);
    }
    return parts.length > 1 ? `${parts[0]} (${parts.slice(1).join("; ")})` : (parts[0] ?? String(err));
}
/**
 * One cheap request to Rocket Money's web app. Any HTTP response, even an error
 * page, means it is reachable (a refusal is for the login to report, with its
 * error). No response at all means the network is down or stalled. A failure
 * that isn't a network error is thrown, so it can't pass for "offline".
 */
export async function rocketMoneyReachable(fetchImpl = fetch, timeoutMs = 8000) {
    try {
        const res = await fetchImpl("https://app.rocketmoney.com/", {
            method: "HEAD",
            redirect: "manual",
            signal: AbortSignal.timeout(timeoutMs),
        });
        return { ok: true, status: res.status };
    }
    catch (err) {
        if (isNetworkError(err))
            return { ok: false, error: describeNetworkError(err) };
        throw err;
    }
}
