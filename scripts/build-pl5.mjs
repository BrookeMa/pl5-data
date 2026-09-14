#!/usr/bin/env node
/**
 * 抓取 data.17500.cn 的排列5原始数据，转成 pl5_5digit.csv。
 * GitHub Actions 每天开奖后跑这个；也可以本地直接 node scripts/build-pl5.mjs。
 *
 * 用法：
 *   node scripts/build-pl5.mjs                 # 抓上游并写文件
 *   node scripts/build-pl5.mjs --from a.txt    # 用本地文件，不联网
 *   node scripts/build-pl5.mjs --out b.csv     # 写到别处
 *   node scripts/build-pl5.mjs --check         # 只校验不写
 *
 * 数据不健康或期数比现有文件少时以非 0 退出，绝不覆盖已有的好数据。
 */
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { UPSTREAM_URL, parseUpstream, checkHealth, toCsv } from "../lib/pl5.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TIMEOUT_MS = 20000;
const RETRIES = 3;

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1] ?? "";
}
const fromFile = arg("--from");
const outPath = resolve(ROOT, arg("--out") || "pl5_5digit.csv");
const checkOnly = process.argv.includes("--check");

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

async function fetchUpstream() {
  let lastErr;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const res = await fetch(UPSTREAM_URL, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { "user-agent": "pl5-csv build script" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      lastErr = err;
      console.error(`  第 ${attempt}/${RETRIES} 次抓取失败：${err.message}`);
      if (attempt < RETRIES) await new Promise((r) => setTimeout(r, attempt * 2000));
    }
  }
  fail(`上游抓不到：${lastErr?.message || lastErr}`);
}

const raw = fromFile ? readFileSync(resolve(process.cwd(), fromFile), "utf8") : await fetchUpstream();

const parsed = parseUpstream(raw);
const health = checkHealth(parsed);
if (!health.ok) fail(`上游数据不健康，拒绝写入：${health.reason}`);

const rows = parsed.rows;
const latest = rows[rows.length - 1];
const csv = toCsv(rows);

// 期数只允许增加：上游要是哪天缩水了，宁可让任务失败也不能覆盖好文件
const before = existsSync(outPath) ? readFileSync(outPath, "utf8") : "";
const beforeRows = before ? before.trim().split(/\r?\n/).length - 1 : 0;
if (beforeRows > rows.length) {
  fail(`期数倒退：现有 ${beforeRows} 期，抓到 ${rows.length} 期`);
}

const changed = before !== csv;
if (!checkOnly && changed) writeFileSync(outPath, csv);

console.log(`✓ ${rows.length} 期  ${rows[0].date} ~ ${latest.date}  最新 ${latest.period}=${latest.winningNumber}`);
console.log(changed ? `  ${checkOnly ? "有更新（--check 未写入）" : `已写入 ${outPath}（+${rows.length - beforeRows} 期）`}` : "  无变化");

// 给 workflow 用
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    [
      `changed=${changed}`,
      `rows=${rows.length}`,
      `added=${rows.length - beforeRows}`,
      `latest_period=${latest.period}`,
      `latest_date=${latest.date}`,
    ].join("\n") + "\n",
  );
}
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `### 排列5 数据\n\n` +
      `- 总期数：**${rows.length}**（本次 +${rows.length - beforeRows}）\n` +
      `- 最新：**${latest.period}** / ${latest.date} / \`${latest.winningNumber}\`\n` +
      `- 结果：${changed ? "已更新" : "无变化"}\n`,
  );
}
