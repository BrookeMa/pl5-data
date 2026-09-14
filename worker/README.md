# pl5-csv

把 `data.17500.cn/pl5_asc.txt`（排列5 开奖原始数据）实时转成 CSV / JSON 的 Cloudflare Worker。

请求进来才去抓上游、当场转换，所以链接拿到的永远是最新一期，不依赖任何定时任务。

## 部署

```bash
npm install
npx wrangler r2 bucket create pl5-archive   # 兜底存档桶，wrangler.toml 里已绑好
npx wrangler deploy
```

部署完拿到 `https://pl5-csv.<你的子域>.workers.dev`，直接就是下载链接。
绑自定义域名在 Cloudflare 控制台 Workers → Settings → Domains & Routes。

## 接口

| 路径 | 说明 |
| --- | --- |
| `/` `/pl5.csv` | CSV，带 `Content-Disposition: attachment`，点开即下载 |
| `/pl5.json` | 同样的数据，JSON 数组 |
| `/health` | 当前数据来源、期数、最新一期，排查用 |

参数（CSV / JSON 通用）：

- `?limit=N` —— 只要最近 N 期
- `?order=desc` —— 最新一期排最前（默认 `asc`，与上游一致）
- `?format=csv|json` —— 覆盖路径推断出的格式

CSV 输出：表头 `period,date,winningNumber`，CRLF 换行，号码 5 位含前导零，与仓库根目录的 `pl5_5digit.csv` 逐字节一致。

## 数据新鲜度与兜底

- 边缘缓存 `CACHE_SECONDS`（默认 300 秒）。上游每天 20:30 开奖后更新，5 分钟窗口足够。
  要强制穿透缓存：请求带 `Cache-Control: no-cache`。
- 每次成功抓到的原始数据会存进 R2（同一期不重复写）。
- 上游超时、返回非 200、或返回的数据不健康（行数骤减、出现重复期号、解析失败率超 1%）时，
  改发 R2 里最后一份好的数据，响应头 `x-data-source: r2-archive` + `x-data-stale-reason` 会说明原因，
  同时把缓存时间压到 60 秒以便尽快恢复。**坏数据不会写进存档。**
- 上游和存档同时没有时返回 502，不会发半截数据。
- cron 每天 21:00（北京时间）主动刷一次存档，保证兜底的那份是最近一期。删掉 `[triggers]` 不影响主链路。

响应头 `x-data-source` / `x-data-rows` / `x-data-latest-period` / `x-data-latest-date` 可直接用来监控。

## 本地

```bash
npm test              # 19 项：解析、健康校验、HTTP 行为、缓存、R2 回退、cron
npx wrangler dev      # 本地 workerd，含模拟的 Cache API 与 R2
```

`test/fixtures/pl5_asc.txt` 是上游快照（截至 2026246 期），测试不联网。
