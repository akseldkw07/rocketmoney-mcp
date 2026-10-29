// Re-sync src/rm/client.ts with the Rocket Money web app after a hash rotation.
//
//   npm run refresh-hashes -- <file.har> [more.har ...]
//     Rewrites PERSISTED from every operationName -> sha256Hash pair the HAR
//     recorded. Capture it with devtools open on the pages that use the broken
//     operations (the PersistedQueryNotFound error names the page).
//
//   npm run refresh-hashes -- --bundle
//     Regenerates src/rm/query-text.ts, the query text rmGraphQL falls back to
//     when a hash is stale, from the public web bundle. No login needed.
//
// Only operations already in PERSISTED are touched; anything else seen is
// listed so you can decide whether to add it.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLIENT_TS = join(ROOT, "src/rm/client.ts");
const QUERY_TEXT_TS = join(ROOT, "src/rm/query-text.ts");
const APP = "https://app.rocketmoney.com";

// ── HAR → hashes ───────────────────────────────────────────────────

interface HarEntry {
  request: { method: string; url: string; postData?: { text?: string } };
}

function hashOf(body: unknown): [string, string] | null {
  const b = body as { operationName?: unknown; extensions?: unknown } | null;
  let ext = b?.extensions as { persistedQuery?: { sha256Hash?: unknown } } | string | undefined;
  if (typeof ext === "string") {
    try {
      ext = JSON.parse(ext);
    } catch {
      return null;
    }
  }
  const hash = (ext as { persistedQuery?: { sha256Hash?: unknown } } | undefined)?.persistedQuery?.sha256Hash;
  if (typeof b?.operationName !== "string" || typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)) return null;
  return [b.operationName, hash];
}

/** Every operationName -> sha256Hash in a HAR (POST bodies, batched arrays, and APQ GETs). */
export function extractHashes(har: { log?: { entries?: HarEntry[] } }): Map<string, string> {
  const out = new Map<string, string>();
  for (const { request } of har.log?.entries ?? []) {
    if (!/\/graphql(\?|$)/.test(request.url)) continue;
    const bodies: unknown[] = [];
    if (request.postData?.text) {
      try {
        const parsed = JSON.parse(request.postData.text);
        bodies.push(...(Array.isArray(parsed) ? parsed : [parsed]));
      } catch {
        continue;
      }
    } else {
      const q = new URL(request.url).searchParams;
      bodies.push({ operationName: q.get("operationName"), extensions: q.get("extensions") ?? undefined });
    }
    for (const b of bodies) {
      const pair = hashOf(b);
      if (pair) out.set(pair[0], pair[1]); // later entries win: the newest capture is the live one
    }
  }
  return out;
}

export interface RewriteReport {
  source: string;
  updated: { op: string; from: string; to: string }[];
  unchanged: string[];
  notCaptured: string[];
  notInPersisted: string[];
}

/** Rewrite the PERSISTED block's hashes in client.ts source. */
export function rewritePersisted(source: string, hashes: Map<string, string>): RewriteReport {
  const block = /const PERSISTED = \{([\s\S]*?)\n\} as const;/.exec(source);
  if (!block) throw new Error("Couldn't find `const PERSISTED = { ... } as const;` in client.ts");
  const report: RewriteReport = { source, updated: [], unchanged: [], notCaptured: [], notInPersisted: [] };
  const known = new Set<string>();
  const body = block[1].replace(/^(\s+)(\w+):(\s*)"([0-9a-f]{64})"/gm, (line, indent, op, gap, old) => {
    known.add(op);
    const next = hashes.get(op);
    if (!next) report.notCaptured.push(op);
    else if (next === old) report.unchanged.push(op);
    else {
      report.updated.push({ op, from: old, to: next });
      return `${indent}${op}:${gap}"${next}"`;
    }
    return line;
  });
  report.notInPersisted = [...hashes.keys()].filter((op) => !known.has(op)).sort();
  report.source = source.slice(0, block.index) + `const PERSISTED = {${body}\n} as const;` + source.slice(block.index + block[0].length);
  return report;
}

/** The operation names PERSISTED declares. */
export function persistedOps(source: string): string[] {
  const block = /const PERSISTED = \{([\s\S]*?)\n\} as const;/.exec(source);
  return block ? [...block[1].matchAll(/^\s+(\w+):\s*"[0-9a-f]{64}"/gm)].map((m) => m[1]) : [];
}

// ── Bundle → query text ────────────────────────────────────────────

type AcornNode = { type: string; [k: string]: unknown };

/** An acorn literal subtree -> its JS value; throws on anything that isn't pure data. */
function literal(n: AcornNode): unknown {
  switch (n.type) {
    case "Literal":
      return n.value;
    case "UnaryExpression": {
      const arg = n.argument as AcornNode;
      if (n.operator === "!" && arg.type === "Literal") return !arg.value; // minified !0 / !1
      if (n.operator === "void") return undefined;
      if (n.operator === "-") return -(literal(arg) as number);
      break;
    }
    case "ArrayExpression":
      return (n.elements as AcornNode[]).map(literal);
    case "ObjectExpression": {
      const o: Record<string, unknown> = {};
      for (const p of n.properties as AcornNode[]) {
        if (p.type !== "Property") throw new Error("spread");
        const key = p.key as AcornNode;
        o[(key.name ?? key.value) as string] = literal(p.value as AcornNode);
      }
      return o;
    }
  }
  throw new Error(`not a literal: ${n.type}`);
}

/** Every named operation document compiled into a bundle file, printed with __typename added. */
export async function extractDocuments(js: string): Promise<Map<string, string>> {
  const acorn = await import("acorn");
  const { print } = await import("graphql");
  const { formatDocument } = await import("@urql/core");
  const out = new Map<string, string>();
  const ast = acorn.parse(js, { ecmaVersion: "latest", sourceType: "script" }) as unknown as AcornNode;
  const stack: AcornNode[] = [ast];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.type === "ObjectExpression") {
      const kind = (n.properties as AcornNode[]).find(
        (p) => p.type === "Property" && ((p.key as AcornNode).name ?? (p.key as AcornNode).value) === "kind",
      );
      if ((kind?.value as AcornNode | undefined)?.value === "Document") {
        try {
          const doc = literal(n) as { definitions: { kind: string; name?: { value: string } }[] };
          const op = doc.definitions.find((d) => d.kind === "OperationDefinition");
          if (op?.name) out.set(op.name.value, print(formatDocument(doc as any) as any));
        } catch {
          // a document built at runtime (fragment spread via code): skip it
        }
        continue;
      }
    }
    for (const v of Object.values(n)) {
      if (Array.isArray(v)) for (const c of v) c && typeof c.type === "string" && stack.push(c);
      else if (v && typeof (v as AcornNode).type === "string") stack.push(v as AcornNode);
    }
  }
  return out;
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 rocketmoney-mcp refresh-hashes" } });
  if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`);
  return res.text();
}

/** Every JS chunk the web app can load: the page's own scripts plus the build manifest's. */
async function bundleChunks(): Promise<string[]> {
  const html = await fetchText(`${APP}/`);
  const scripts = [...html.matchAll(/src="(\/_next\/[^"]+\.js)"/g)].map((m) => m[1]);
  const manifest = scripts.find((s) => s.endsWith("_buildManifest.js"));
  const chunks = new Set(scripts);
  if (manifest) {
    const js = await fetchText(APP + manifest);
    for (const m of js.matchAll(/"(static\/[^"]+\.js)"/g)) chunks.add(`/_next/${m[1]}`);
  }
  return [...chunks];
}

export function renderQueryText(docs: Map<string, string>, when: string): string {
  const entries = [...docs.entries()].sort(([a], [b]) => a.localeCompare(b));
  return [
    "// GENERATED by `npm run refresh-hashes -- --bundle` from the public web bundle",
    `// (${when}). Do not edit by hand. rmGraphQL resends a read with this text when`,
    "// RM answers its persisted hash with PersistedQueryNotFound.",
    "export const QUERY_TEXT: Partial<Record<string, string>> = {",
    ...entries.map(([op, text]) => `  ${op}: ${JSON.stringify(text)},`),
    "};",
    "",
  ].join("\n");
}

// ── CLI ────────────────────────────────────────────────────────────

async function main(args: string[]): Promise<void> {
  const source = readFileSync(CLIENT_TS, "utf8");
  if (args[0] === "--bundle") {
    const wanted = new Set(persistedOps(source));
    const docs = new Map<string, string>();
    for (const chunk of await bundleChunks()) {
      for (const [op, text] of await extractDocuments(await fetchText(APP + chunk))) {
        if (wanted.has(op)) docs.set(op, text);
      }
    }
    writeFileSync(QUERY_TEXT_TS, renderQueryText(docs, new Date().toISOString().slice(0, 10)));
    const missing = [...wanted].filter((op) => !docs.has(op));
    console.log(`Wrote ${docs.size} queries to src/rm/query-text.ts.`);
    if (missing.length) console.log(`Not found in the bundle (no fallback): ${missing.join(", ")}`);
    return;
  }

  if (!args.length) {
    console.error("usage: npm run refresh-hashes -- <file.har> [more.har ...]\n       npm run refresh-hashes -- --bundle");
    process.exit(2);
  }
  const hashes = new Map<string, string>();
  for (const file of args) {
    for (const [op, h] of extractHashes(JSON.parse(readFileSync(file, "utf8")))) hashes.set(op, h);
  }
  const r = rewritePersisted(source, hashes);
  if (r.updated.length) writeFileSync(CLIENT_TS, r.source);
  for (const u of r.updated) console.log(`updated   ${u.op}: ${u.from.slice(0, 12)}… -> ${u.to.slice(0, 12)}…`);
  if (r.unchanged.length) console.log(`unchanged ${r.unchanged.join(", ")}`);
  if (r.notCaptured.length) console.log(`not in HAR ${r.notCaptured.join(", ")}`);
  if (r.notInPersisted.length) console.log(`seen but not in PERSISTED: ${r.notInPersisted.join(", ")}`);
  console.log(r.updated.length ? "\nRun `npm run build` (and `npm run deploy` locally)." : "\nNothing to update.");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
