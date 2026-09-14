/**
 * 排列5 原始数据的解析与序列化。
 * 纯函数，无运行时依赖 —— Cloudflare Worker 和 GitHub Actions 的构建脚本共用这一份。
 */

export const UPSTREAM_URL = "https://data.17500.cn/pl5_asc.txt";
export const CSV_COLUMNS = ["period", "date", "winningNumber"];

/** 上游数据的健康门槛：低于这些就不信这批数据 */
export const MIN_ROWS = 7000;
export const MAX_BAD_LINE_RATIO = 0.01;

/**
 * 上游每行：期号 日期 d1 d2 d3 d4 d5 销售额 中奖注数 单注奖金
 * 只取前 7 段，后面的字段将来变了也不影响。
 */
export function parseUpstream(text) {
  const rows = [];
  const seen = new Set();
  let total = 0;
  let bad = 0;
  let dupes = 0;
  let outOfOrder = 0;
  let prevPeriod = "";

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    total++;

    const parts = line.split(/\s+/);
    if (parts.length < 7) {
      bad++;
      continue;
    }
    const period = parts[0];
    const date = parts[1];
    const winningNumber = parts.slice(2, 7).join("");

    if (
      !/^\d{7}$/.test(period) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !/^\d{5}$/.test(winningNumber)
    ) {
      bad++;
      continue;
    }
    if (seen.has(period)) {
      dupes++;
      continue;
    }
    if (prevPeriod && period <= prevPeriod) outOfOrder++;

    seen.add(period);
    prevPeriod = period;
    rows.push({ period, date, winningNumber });
  }

  return { rows, total, bad, dupes, outOfOrder };
}

/** 上游偶尔返回半截文件或错误页，宁可用上一份好数据也别用坏的 */
export function checkHealth(parsed) {
  const { rows, total, bad, dupes, outOfOrder } = parsed;
  if (rows.length < MIN_ROWS) {
    return { ok: false, reason: `only ${rows.length} valid rows (< ${MIN_ROWS})` };
  }
  if (total > 0 && bad / total > MAX_BAD_LINE_RATIO) {
    return { ok: false, reason: `${bad}/${total} unparsable lines` };
  }
  if (dupes > 0) return { ok: false, reason: `${dupes} duplicate periods` };
  if (outOfOrder > 0) return { ok: false, reason: `${outOfOrder} out-of-order periods` };
  return { ok: true, reason: "" };
}

/** CRLF + 表头，跟 pl5.csv 的格式对齐 */
export function toCsv(rows) {
  const out = [CSV_COLUMNS.join(",")];
  for (const r of rows) out.push(`${r.period},${r.date},${r.winningNumber}`);
  return out.join("\r\n") + "\r\n";
}

export function toJson(rows) {
  return JSON.stringify(rows);
}

export function selectRows(rows, { limit, order }) {
  let out = rows;
  if (limit != null && limit < out.length) out = out.slice(out.length - limit);
  if (order === "desc") out = out.slice().reverse();
  return out;
}
