import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractRmCode,
  appleNsFromMs,
  msFromAppleNs,
  rowCode,
  openMessagesReader,
  watchForCode,
} from "../src/rm/messages-otp.js";

test("extracts the 6-digit code from Rocket Money's text", () => {
  assert.equal(extractRmCode("Rocket Account: DO NOT share this one-time passcode. We'll NEVER ask you for it. Code: 123456"), "123456");
  assert.equal(extractRmCode("Your verification code is 654321"), "654321");
  assert.equal(extractRmCode("no code here 12345"), null);
});

test("converts between Apple's nanoseconds-since-2001 and epoch ms", () => {
  const ms = Date.parse("2026-11-23T10:47:30.515Z");
  assert.equal(msFromAppleNs(817123650515907968n), ms);
  assert.equal(msFromAppleNs(appleNsFromMs(ms)), ms);
});

test("reads the code from attributedBody when the text column is empty", () => {
  const body = new TextEncoder().encode("\u0004\u000bstreamtyped NSString Code: 777888 \u0086");
  assert.equal(rowCode({ text: null, attributedBody: body }), "777888");
  assert.equal(rowCode({ text: "Code: 111222", attributedBody: body }), "111222");
  assert.equal(rowCode({ text: null, attributedBody: null }), null);
});

/** A minimal chat.db with the columns the reader uses. */
function fakeChatDb(): string {
  const path = join(mkdtempSync(join(tmpdir(), "chatdb-")), "chat.db");
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
           CREATE TABLE message (ROWID INTEGER PRIMARY KEY, handle_id INTEGER, is_from_me INTEGER,
                                 date INTEGER, text TEXT, attributedBody BLOB);`);
  db.prepare("INSERT INTO handle VALUES (1, '22395'), (2, '+15551234567')").run();
  const ins = db.prepare("INSERT INTO message (handle_id, is_from_me, date, text) VALUES (?, ?, ?, ?)");
  const t = (iso: string) => appleNsFromMs(Date.parse(iso));
  ins.run(1, 0, t("2026-11-23T10:40:00Z"), "Code: 000001"); // before the login started
  ins.run(2, 0, t("2026-11-23T10:47:31Z"), "Code: 999999"); // another sender
  ins.run(1, 1, t("2026-11-23T10:47:31Z"), "Code: 888888"); // sent by me
  ins.run(1, 0, t("2026-11-23T10:47:30Z"), "Code: 594411"); // the one we want
  db.close();
  return path;
}

test("the reader returns only codes from the sender, received, after the start time", () => {
  const read = openMessagesReader(fakeChatDb(), "22395");
  assert.deepEqual(read(Date.parse("2026-11-23T10:47:00Z")), ["594411"]);
  assert.deepEqual(read(Date.parse("2026-11-23T10:48:00Z")), []);
});

test("opening a missing database throws the real sqlite error", () => {
  assert.throws(() => openMessagesReader("/nonexistent/dir/chat.db", "22395"), /unable to open database/);
});

function fakeClock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
}

test("the watcher hands over the first code that arrives, then stops", async () => {
  const clock = fakeClock();
  let calls = 0;
  const r = await watchForCode({
    read: () => (++calls < 3 ? [] : ["594411"]),
    pending: () => true,
    timeoutMs: 60_000,
    pollMs: 2000,
    ...clock,
  });
  assert.deepEqual(r, { code: "594411" });
  assert.equal(calls, 3);
});

test("the watcher stops when the login no longer waits for a code", async () => {
  const clock = fakeClock();
  let pending = true;
  const r = await watchForCode({
    read: () => {
      pending = false;
      return [];
    },
    pending: () => pending,
    timeoutMs: 60_000,
    pollMs: 2000,
    ...clock,
  });
  assert.deepEqual(r, { stopped: "login no longer waiting for a code" });
});

test("the watcher gives up at its timeout", async () => {
  const clock = fakeClock();
  const r = await watchForCode({ read: () => [], pending: () => true, timeoutMs: 10_000, pollMs: 2000, ...clock });
  assert.deepEqual(r, { stopped: "no code arrived in 10s" });
});

test("a read error ends the watch with the error itself, not a summary", async () => {
  const clock = fakeClock();
  const boom = Object.assign(new Error("authorization denied"), { code: "ERR_SQLITE_ERROR" });
  const r = await watchForCode({
    read: () => {
      throw boom;
    },
    pending: () => true,
    timeoutMs: 10_000,
    pollMs: 2000,
    ...clock,
  });
  assert.ok("error" in r);
  assert.equal(r.error, boom);
});
