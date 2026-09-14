# 排列5 开奖数据

每天自动更新的排列5（5 位数）历史开奖 CSV。数据源：`https://data.17500.cn/pl5_asc.txt`

## 下载链接

**点开就下载**（浏览器里用这个，响应头带 `content-disposition: attachment`）：

```
https://github.com/BrookeMa/pl5-data/releases/latest/download/pl5_5digit.csv
```

**程序里取数**（`curl` / `fetch` / `pandas.read_csv`，带 `access-control-allow-origin: *`，前端跨域可直接读）：

```
https://raw.githubusercontent.com/BrookeMa/pl5-data/main/pl5_5digit.csv
```

两个都永远指向最新一份。raw 那条缓存 300 秒；Release 那条是每次数据更新后由 Actions 重传的，
链接本身固定不变。raw 的 `content-type` 是 `text/plain`，浏览器里点会直接把内容铺在页面上。

## 文件

| 文件 | 说明 |
| --- | --- |
| `pl5_5digit.csv` | **5 位号码**，每天自动更新 |
| `pl5.csv` | 4 位号码的旧文件（只有前 4 位），不再更新 |

格式：表头 `period,date,winningNumber`，CRLF 换行，号码 5 位、含前导零。

```csv
period,date,winningNumber
2004001,2004-11-14,92882
2026246,2026-09-13,28665
```

## 更新机制

`.github/workflows/refresh-pl5.yml` 在北京时间 21:00 起每半小时跑一次（到次日 00:30）。
排列5 每天 20:30 开奖，GitHub 的定时任务常有 5~20 分钟延迟，所以多排了几次兜底。
数据没变就不提交，所以仓库历史里一天最多一条记录。

`scripts/build-pl5.mjs` 在这些情况下会直接失败、**不覆盖**已有文件，任务转为报错让你收到通知：

- 上游三次重试都抓不到
- 有效行数少于 7000（半截文件、错误页）
- 出现重复期号或期号倒序
- 解析失败的行超过 1%
- 抓到的期数比现有文件还少

本地手动跑：

```bash
node scripts/build-pl5.mjs          # 抓取并更新
node scripts/build-pl5.mjs --check  # 只校验，不写文件
```

## worker/

一个 Cloudflare Worker，请求时现抓上游现转换，输出同样格式的 CSV/JSON —— 不经过仓库，
所以没有 GitHub 定时任务那几分钟的延迟。带边缘缓存和 R2 兜底存档，部署说明见 [worker/README.md](worker/README.md)。
用不上的话整个目录删掉不影响上面的自动更新。

解析和序列化逻辑在 `lib/pl5.mjs`，构建脚本和 Worker 共用这一份。
