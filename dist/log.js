// Timestamps on every log line (TODO F10). launchd writes the server's stdout
// and stderr straight to server.log / server.err with no time of its own, so
// without this the keepalive and re-login checks can't tell when anything
// happened. Times are UTC ISO-8601, unambiguous whichever zone the Mac is in.
const STAMPED = Symbol.for("rocketmoney-mcp.log-timestamps");
/**
 * Wrap console.log/info/warn/error so each line starts with the time. A string
 * first argument gets the stamp prepended (so `%s` format strings keep
 * working); anything else gets it as its own first argument. Safe to call more
 * than once.
 */
export function installTimestamps(c = console, now = () => new Date()) {
    const tagged = c;
    if (tagged[STAMPED])
        return;
    for (const method of ["log", "info", "warn", "error"]) {
        const original = c[method];
        if (!original)
            continue;
        c[method] = (...args) => {
            const ts = now().toISOString();
            if (typeof args[0] === "string")
                original.call(c, `${ts} ${args[0]}`, ...args.slice(1));
            else
                original.call(c, ts, ...args);
        };
    }
    tagged[STAMPED] = true;
}
