// Read Rocket Money's SMS login code from the Mac's Messages database.
//
// Why: once Auth0's 1h sign-in cookie lapses (e.g. the network was down longer
// than the renewal margin), the only way back in is a full login, and that ends
// at an SMS challenge. With iPhone Text Message Forwarding on, the SMS lands in
// ~/Library/Messages/chat.db within a second, so the server can read the code
// itself and finish the login with nobody at the keyboard.
//
// Scope, kept deliberately narrow: read-only open; only messages received (not
// sent) from ROCKETMONEY_OTP_SENDER (default 22395, Rocket Account's short code);
// only ones that arrived after the login submitted the password; only a 6-digit
// code is returned, and message text is never logged. Needs Full Disk Access for
// the `node` binary running the server; without it the open fails and the error
// is logged as sqlite gave it.
import { DatabaseSync } from "node:sqlite";
/** RM's code is 6 digits. Prefer digits next to a code-ish word, else the first standalone 6-digit run. */
export function extractRmCode(text) {
    const near = text.match(/(?:code|verification|passcode)\D{0,20}(\d{6})/i);
    const any = text.match(/\b(\d{6})\b/);
    return near?.[1] ?? any?.[1] ?? null;
}
// Messages stores `date` as nanoseconds since 2001-01-01 UTC.
const APPLE_EPOCH_MS = 978_307_200_000;
export const msFromAppleNs = (ns) => Number(BigInt(ns) / 1000000n) + APPLE_EPOCH_MS;
export const appleNsFromMs = (ms) => BigInt(ms - APPLE_EPOCH_MS) * 1000000n;
/**
 * The code in one message row. Newer macOS versions sometimes leave `text` empty
 * and keep the body only in the `attributedBody` archive, where the string still
 * appears as plain UTF-8.
 */
export function rowCode(row) {
    if (row.text)
        return extractRmCode(row.text);
    if (row.attributedBody)
        return extractRmCode(new TextDecoder("utf-8", { fatal: false }).decode(row.attributedBody));
    return null;
}
export const DEFAULT_CHAT_DB = `${process.env.HOME}/Library/Messages/chat.db`;
/**
 * Open chat.db read-only and return a reader: codes from `sender` received after
 * `sinceMs`, newest first. Throws sqlite's own error when the file can't be
 * opened (missing, or no Full Disk Access).
 */
export function openMessagesReader(path, sender) {
    const db = new DatabaseSync(path, { readOnly: true });
    const q = db.prepare(`SELECT m.text AS text, m.attributedBody AS attributedBody
       FROM message m JOIN handle h ON m.handle_id = h.ROWID
      WHERE h.id = ? AND m.is_from_me = 0 AND m.date > ?
      ORDER BY m.date DESC LIMIT 5`);
    q.setReadBigInts(true);
    return (sinceMs) => {
        const rows = q.all(sender, appleNsFromMs(sinceMs));
        return rows.map(rowCode).filter((c) => c !== null);
    };
}
/**
 * Poll `read` until it yields a code, the login stops waiting (`pending` false),
 * or `timeoutMs` passes. A read error ends the watch and is returned as is.
 */
export async function watchForCode(o) {
    const now = o.now ?? Date.now;
    const sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    const end = now() + o.timeoutMs;
    while (now() < end) {
        let codes;
        try {
            codes = o.read();
        }
        catch (error) {
            return { error };
        }
        if (codes.length)
            return { code: codes[0] };
        if (!o.pending())
            return { stopped: "login no longer waiting for a code" };
        await sleep(o.pollMs);
    }
    return { stopped: `no code arrived in ${Math.round(o.timeoutMs / 1000)}s` };
}
