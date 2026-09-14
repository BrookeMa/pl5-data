/** 本地跑：node test/parse.test.mjs —— 用真实上游快照 + 假的 cache/R2 把 worker 全跑一遍 */
import { readFileSync, existsSync } from "node:fs";
import assert from "node:assert/strict";

const FIXTURE = process.env.PL5_FIXTURE || new URL("./fixtures/pl5_asc.txt", import.meta.url).pathname;
const REFERENCE_CSV = process.env.PL5_REFERENCE || "";

// worker 里用 globalThis.caches，node 没有，先塞一个假的进去
class FakeCache {
  constructor() { this.store = new Map(); }
  async match(req) {
    const hit = this.store.get(req.url);
    return hit ? hit.clone() : undefined;
  }
  async put(req, res) { this.store.set(req.url, res.clone()); }
}
let fakeCache = new FakeCache();
globalThis.caches = { default: fakeCache };

class FakeR2 {
  constructor() { this.objects = new Map(); this.puts = 0; }
  async head(key) { return this.objects.get(key) ?? null; }
  async get(key) {
    const o = this.objects.get(key);
    return o ? { ...o, text: async () => o.body } : null;
  }
  async put(key, body, opts) {
    this.puts++;
    this.objects.set(key, { body, customMetadata: opts?.customMetadata ?? {} });
  }
}

const mod = { ...(await import("../../lib/pl5.mjs")), ...(await import("../src/index.js")) };
const worker = mod.default;

const RAW = readFileSync(FIXTURE, "utf8");
let upstream = { mode: "ok", body: RAW };
globalThis.fetch = async () => {
  if (upstream.mode === "throw") throw new Error("boom");
  if (upstream.mode === "500") return new Response("oops", { status: 500 });
  return new Response(upstream.body, { status: 200 });
};

const ctx = { waitUntil: (p) => p };
function freshEnv(withR2 = true) {
  fakeCache = new FakeCache();
  globalThis.caches = { default: fakeCache };
  return { CACHE_SECONDS: "300", FILENAME: "pl5.csv", ...(withR2 ? { ARCHIVE: new FakeR2() } : {}) };
}
const get = (path, init) => worker.fetch(new Request("https://x.dev" + path, init), env, ctx);

let env = freshEnv();
let passed = 0;
async function it(name, fn) {
  try { await fn(); passed++; console.log("  ✓", name); }
  catch (e) { console.error("  ✗", name, "\n   ", e.message); process.exitCode = 1; }
}

console.log("\nparse");
await it("解析真实快照：全部 5 位、期号递增、无重复", () => {
  const p = mod.parseUpstream(RAW);
  assert.equal(p.bad, 0);
  assert.equal(p.dupes, 0);
  assert.equal(p.outOfOrder, 0);
  assert.ok(p.rows.length > 7700, `rows=${p.rows.length}`);
  assert.ok(p.rows.every((r) => /^\d{5}$/.test(r.winningNumber)));
  assert.equal(mod.checkHealth(p).ok, true);
});
await it("坏数据被拦住：截断 / 错误页 / 重复期号", () => {
  assert.equal(mod.checkHealth(mod.parseUpstream(RAW.split("\n").slice(0, 100).join("\n"))).ok, false);
  assert.equal(mod.checkHealth(mod.parseUpstream("<html>502 Bad Gateway</html>")).ok, false);
  const lines = RAW.trim().split("\n");
  const dup = [...lines, lines[lines.length - 1]].join("\n");
  assert.equal(mod.checkHealth(mod.parseUpstream(dup)).ok, false);
});
await it("CSV 与本地 pl5_5digit.csv 逐字节一致", function () {
  if (!REFERENCE_CSV || !existsSync(REFERENCE_CSV)) { console.log("    (跳过：无参照文件)"); return; }
  const rows = mod.parseUpstream(RAW).rows;
  assert.equal(mod.toCsv(rows), readFileSync(REFERENCE_CSV, "utf8"));
});
await it("limit / order 选取正确", () => {
  const rows = mod.parseUpstream(RAW).rows;
  const last5 = mod.selectRows(rows, { limit: 5, order: "asc" });
  assert.deepEqual(last5, rows.slice(-5));
  const desc = mod.selectRows(rows, { limit: 3, order: "desc" });
  assert.deepEqual(desc.map((r) => r.period), rows.slice(-3).reverse().map((r) => r.period));
  assert.deepEqual(mod.selectRows(rows, { limit: 99999, order: "asc" }), rows);
});

console.log("\nhttp");
await it("GET / 返回可直接下载的 CSV", async () => {
  upstream = { mode: "ok", body: RAW };
  env = freshEnv();
  const res = await get("/");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/csv; charset=utf-8");
  assert.equal(res.headers.get("content-disposition"), 'attachment; filename="pl5.csv"');
  assert.equal(res.headers.get("x-data-source"), "upstream");
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  assert.match(res.headers.get("cache-control"), /max-age=300/);
  const body = await res.text();
  assert.ok(body.startsWith("period,date,winningNumber\r\n2004001,2004-11-14,92882\r\n"));
  assert.ok(body.endsWith("\r\n"));
});
await it("第二次请求走边缘缓存，不再打上游", async () => {
  upstream = { mode: "throw" };
  const res = await get("/pl5.csv");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-data-source"), "edge-cache");
});
await it("no-cache 头可以绕过缓存拿实时数据", async () => {
  upstream = { mode: "ok", body: RAW };
  const res = await get("/pl5.csv", { headers: { "cache-control": "no-cache" } });
  assert.equal(res.headers.get("x-data-source"), "upstream");
});
await it("JSON 路径与 ?format=json 一致", async () => {
  const a = await get("/pl5.json?limit=2");
  const b = await get("/?format=json&limit=2");
  assert.equal(a.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(a.headers.get("content-disposition"), null);
  const rows = JSON.parse(await a.text());
  assert.equal(rows.length, 2);
  assert.deepEqual(Object.keys(rows[0]), ["period", "date", "winningNumber"]);
  assert.equal(await b.text(), JSON.stringify(rows));
});
await it("limit + order=desc：最新一期排第一", async () => {
  const res = await get("/pl5.csv?limit=3&order=desc");
  const lines = (await res.text()).trim().split("\r\n");
  assert.equal(lines.length, 4);
  assert.equal(lines[1].split(",")[0], res.headers.get("x-data-latest-period"));
  assert.equal(res.headers.get("x-data-rows"), "3");
});
await it("ETag 命中返回 304 且无 body", async () => {
  const first = await get("/pl5.csv");
  const etag = first.headers.get("etag");
  assert.ok(etag);
  const second = await get("/pl5.csv", { headers: { "if-none-match": etag } });
  assert.equal(second.status, 304);
  assert.equal(await second.text(), "");
  const other = await get("/pl5.csv?limit=10", { headers: { "if-none-match": etag } });
  assert.equal(other.status, 200, "参数变了不能吃 304");
});
await it("HEAD 只给头不给体", async () => {
  const res = await get("/pl5.csv", { method: "HEAD" });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "");
  assert.equal(res.headers.get("content-disposition"), 'attachment; filename="pl5.csv"');
});
await it("/health 汇报数据来源和最新一期", async () => {
  const res = await get("/health");
  const j = JSON.parse(await res.text());
  assert.equal(j.ok, true);
  assert.equal(j.staleReason, null);
  assert.match(j.latestDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(j.rows > 7700);
});
await it("非法参数 400、未知路径 404、POST 405", async () => {
  assert.equal((await get("/pl5.csv?limit=abc")).status, 400);
  assert.equal((await get("/pl5.csv?limit=0")).status, 400);
  assert.equal((await get("/pl5.csv?order=up")).status, 400);
  assert.equal((await get("/pl5.csv?format=xml")).status, 400);
  assert.equal((await get("/nope")).status, 404);
  assert.equal((await get("/", { method: "POST" })).status, 405);
});

console.log("\nfallback");
await it("上游 500 → 回退 R2 存档，并标出原因", async () => {
  upstream = { mode: "ok", body: RAW };
  env = freshEnv();
  await get("/pl5.csv");                    // 先落一份存档
  assert.equal(env.ARCHIVE.puts, 1);
  upstream = { mode: "500" };
  const res = await get("/pl5.csv", { headers: { "cache-control": "no-cache" } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-data-source"), "r2-archive");
  assert.match(res.headers.get("x-data-stale-reason"), /HTTP 500/);
  assert.match(res.headers.get("cache-control"), /max-age=60/);
  assert.ok((await res.text()).includes("2004001,2004-11-14,92882"));
});
await it("上游返回半截文件 → 不污染存档，仍发旧数据", async () => {
  upstream = { mode: "ok", body: RAW.split("\n").slice(0, 50).join("\n") };
  const res = await get("/pl5.csv", { headers: { "cache-control": "no-cache" } });
  assert.equal(res.headers.get("x-data-source"), "r2-archive");
  assert.match(res.headers.get("x-data-stale-reason"), /rejected/);
  assert.equal(env.ARCHIVE.puts, 1, "坏数据不应该写进存档");
});
await it("同一期不重复写 R2", async () => {
  upstream = { mode: "ok", body: RAW };
  await get("/pl5.csv", { headers: { "cache-control": "no-cache" } });
  await get("/pl5.csv", { headers: { "cache-control": "no-cache" } });
  assert.equal(env.ARCHIVE.puts, 1);
});
await it("开出新一期 → 存档更新", async () => {
  upstream = { mode: "ok", body: RAW.trimEnd() + "\n2026247 2026-09-14 1 2 3 4 5 100 1 100000\n" };
  const res = await get("/pl5.csv", { headers: { "cache-control": "no-cache" } });
  assert.equal(env.ARCHIVE.puts, 2);
  assert.equal(res.headers.get("x-data-latest-period"), "2026247");
  assert.equal(res.headers.get("x-data-latest-date"), "2026-09-14");
});
await it("上游挂了且没有存档 → 502，不发假数据", async () => {
  env = freshEnv(false);
  upstream = { mode: "throw" };
  const res = await get("/pl5.csv");
  assert.equal(res.status, 502);
  assert.match(await res.text(), /上游不可用/);
});
await it("cron 触发时刷新存档", async () => {
  env = freshEnv();
  upstream = { mode: "ok", body: RAW };
  await worker.scheduled({ cron: "0 13 * * *" }, env, ctx);
  assert.equal(env.ARCHIVE.puts, 1);
});

console.log(`\n${passed} passed${process.exitCode ? ", 有失败" : ""}\n`);
