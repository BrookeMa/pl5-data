/**
 * pl5-csv —— 把 data.17500.cn 的排列5原始数据实时转成 CSV / JSON。
 *
 * 请求进来时现抓上游、现转换，所以链接永远是最新一期；
 * 边缘缓存 CACHE_SECONDS 秒防止打爆上游，R2 存一份原始档做兜底。
 *
 * 解析和序列化逻辑在 ../../lib/pl5.mjs，与 GitHub Actions 的构建脚本共用同一份。
 */

import {
  UPSTREAM_URL as DEFAULT_UPSTREAM,
  parseUpstream,
  checkHealth,
  toCsv,
  toJson,
  selectRows,
} from "../../lib/pl5.mjs";

export { parseUpstream, checkHealth, toCsv, toJson, selectRows };

const DEFAULT_CACHE_SECONDS = 300;
const DEFAULT_FILENAME = "pl5.csv";

const ARCHIVE_KEY = "pl5_asc.txt";
const UPSTREAM_TIMEOUT_MS = 10000;
const CACHE_KEY_URL = "https://pl5-csv.internal/upstream";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, HEAD, OPTIONS",
  "access-control-allow-headers": "if-none-match, cache-control",
  "access-control-expose-headers":
    "etag, x-data-source, x-data-rows, x-data-latest-period, x-data-latest-date, x-data-stale-reason",
};

/* ---------------------------------------------- 抓取 / 缓存 / R2 兜底 */

function config(env) {
  const cacheSeconds = Number(env.CACHE_SECONDS) || DEFAULT_CACHE_SECONDS;
  return {
    upstream: env.UPSTREAM || DEFAULT_UPSTREAM,
    filename: env.FILENAME || DEFAULT_FILENAME,
    cacheSeconds,
  };
}

function edgeCache() {
  return typeof caches !== "undefined" && caches.default ? caches.default : null;
}

async function fetchUpstream(url) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    headers: { "user-agent": "pl5-csv-worker (+https://workers.cloudflare.com)" },
    cf: { cacheTtl: 0, cacheEverything: false },
  });
  if (!res.ok) throw new Error(`upstream HTTP ${res.status}`);
  return await res.text();
}

async function archive(env, text, parsed) {
  if (!env.ARCHIVE) return;
  const latestPeriod = parsed.rows[parsed.rows.length - 1].period;
  const head = await env.ARCHIVE.head(ARCHIVE_KEY);
  if (head?.customMetadata?.latestPeriod === latestPeriod) return; // 没开新奖就不重复写
  await env.ARCHIVE.put(ARCHIVE_KEY, text, {
    httpMetadata: { contentType: "text/plain; charset=utf-8" },
    customMetadata: {
      latestPeriod,
      rows: String(parsed.rows.length),
      archivedAt: new Date().toISOString(),
    },
  });
}

/**
 * 返回 { rows, source, staleReason }
 * source: edge-cache | upstream | r2-archive
 */
export async function loadData(env, ctx, { bypassCache = false } = {}) {
  const { upstream, cacheSeconds } = config(env);
  const cache = edgeCache();
  const cacheKey = new Request(CACHE_KEY_URL, { method: "GET" });

  if (cache && !bypassCache) {
    const hit = await cache.match(cacheKey);
    if (hit) {
      const parsed = parseUpstream(await hit.text());
      if (checkHealth(parsed).ok) {
        return { rows: parsed.rows, source: "edge-cache", staleReason: "" };
      }
    }
  }

  let failure = "";
  try {
    const text = await fetchUpstream(upstream);
    const parsed = parseUpstream(text);
    const health = checkHealth(parsed);
    if (health.ok) {
      const store = (async () => {
        if (cache) {
          await cache.put(
            cacheKey,
            new Response(text, {
              headers: {
                "content-type": "text/plain; charset=utf-8",
                "cache-control": `public, max-age=${cacheSeconds}`,
              },
            }),
          );
        }
        await archive(env, text, parsed);
      })();
      if (ctx?.waitUntil) ctx.waitUntil(store);
      else await store;
      return { rows: parsed.rows, source: "upstream", staleReason: "" };
    }
    failure = `upstream data rejected: ${health.reason}`;
  } catch (err) {
    failure = `upstream fetch failed: ${err?.message || err}`;
  }

  if (env.ARCHIVE) {
    const obj = await env.ARCHIVE.get(ARCHIVE_KEY);
    if (obj) {
      const parsed = parseUpstream(await obj.text());
      if (parsed.rows.length > 0) {
        return { rows: parsed.rows, source: "r2-archive", staleReason: failure };
      }
    }
  }

  const err = new Error(failure || "no data available");
  err.noData = true;
  throw err;
}

/* -------------------------------------------------------------- HTTP 层 */

function plain(status, message, extra = {}) {
  return new Response(message + "\n", {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...CORS, ...extra },
  });
}

function parseParams(url) {
  const format = (url.searchParams.get("format") || "").toLowerCase();
  if (format && format !== "csv" && format !== "json") {
    return { error: "format 只能是 csv 或 json" };
  }

  const order = (url.searchParams.get("order") || "asc").toLowerCase();
  if (order !== "asc" && order !== "desc") {
    return { error: "order 只能是 asc 或 desc" };
  }

  const rawLimit = url.searchParams.get("limit");
  let limit = null;
  if (rawLimit != null) {
    if (!/^\d+$/.test(rawLimit) || Number(rawLimit) < 1) {
      return { error: "limit 必须是正整数" };
    }
    limit = Number(rawLimit);
  }

  return { format, order, limit };
}

function routeFormat(pathname, formatParam) {
  if (formatParam) return formatParam;
  if (/\.json$/i.test(pathname)) return "json";
  return "csv";
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (request.method !== "GET" && request.method !== "HEAD") {
      return plain(405, "只支持 GET / HEAD", { allow: "GET, HEAD, OPTIONS" });
    }

    const path = url.pathname.replace(/\/+$/, "") || "/";
    const known = ["/", "/pl5.csv", "/pl5.json", "/csv", "/json", "/health"];
    if (!known.includes(path)) {
      return plain(404, "可用路径：/pl5.csv  /pl5.json  /health");
    }

    const params = parseParams(url);
    if (params.error) return plain(400, params.error);

    const bypassCache = /no-cache/i.test(request.headers.get("cache-control") || "");
    const { cacheSeconds, filename } = config(env);

    let data;
    try {
      data = await loadData(env, ctx, { bypassCache });
    } catch (err) {
      return plain(502, `上游不可用且无存档可回退：${err?.message || err}`);
    }

    const { rows, source, staleReason } = data;
    const latest = rows[rows.length - 1];

    if (path === "/health") {
      const body = JSON.stringify(
        {
          ok: source !== "r2-archive",
          source,
          rows: rows.length,
          latestPeriod: latest.period,
          latestDate: latest.date,
          staleReason: staleReason || null,
          checkedAt: new Date().toISOString(),
        },
        null,
        2,
      );
      return new Response(request.method === "HEAD" ? null : body + "\n", {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...CORS },
      });
    }

    const format = routeFormat(path, params.format);
    const selected = selectRows(rows, params);
    const body = format === "json" ? toJson(selected) : toCsv(selected);

    // 数据没变 + 参数没变 => 同一个 ETag，客户端可以走 304
    const etag = `W/"${rows.length}-${latest.period}-${format}-${params.order}-${params.limit ?? "all"}"`;
    const headers = {
      "content-type":
        format === "json" ? "application/json; charset=utf-8" : "text/csv; charset=utf-8",
      "cache-control": `public, max-age=${source === "r2-archive" ? 60 : cacheSeconds}`,
      etag,
      "x-data-source": source,
      "x-data-rows": String(selected.length),
      "x-data-latest-period": latest.period,
      "x-data-latest-date": latest.date,
      ...CORS,
    };
    if (staleReason) headers["x-data-stale-reason"] = staleReason;
    if (format === "csv") {
      // 点链接就直接下文件，而不是在浏览器里铺一屏文本
      headers["content-disposition"] = `attachment; filename="${filename}"`;
    }

    if ((request.headers.get("if-none-match") || "").includes(etag)) {
      return new Response(null, { status: 304, headers });
    }

    return new Response(request.method === "HEAD" ? null : body, { status: 200, headers });
  },

  /** 定时把存档刷新一遍，保证上游真挂掉时兜底的是最近一期 */
  async scheduled(event, env, ctx) {
    await loadData(env, ctx, { bypassCache: true });
  },
};
