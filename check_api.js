// check_sources_queue_retry.js
const fs = require("fs");
const path = require("path");
const axios = require("axios");

// === 配置 ===
const CONFIG_PATH = path.join(__dirname, "LunaTV-config.json");
const REPORT_PATH = path.join(__dirname, "report.md");
const MAX_DAYS = 30;
const WARN_STREAK = 3;
const ENABLE_SEARCH_TEST = true;
const CHECK_QUARANTINED = /^(1|true|yes)$/i.test(process.env.CHECK_QUARANTINED || "");
const SEARCH_KEYWORD = process.argv[2] || "斗罗大陆";
const TIMEOUT_MS = 10000;
const CONCURRENT_LIMIT = 10; // 并发限制
const MAX_RETRY = 3;        // 请求最大重试次数
const RETRY_DELAY_MS = 500; // 重试间隔(ms)
const HTTP_OPTIONS = {
  timeout: TIMEOUT_MS,
  maxRedirects: 3,
  headers: { Accept: "application/json, text/plain;q=0.9, */*;q=0.8" },
};

// === 加载配置 ===
if (!fs.existsSync(CONFIG_PATH)) {
  console.error("❌ 配置文件不存在:", CONFIG_PATH);
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
const partitionSourceEntries = (apiSite) => {
  const allEntries = Object.values(apiSite).map((source) => ({
    name: source.name,
    api: source.api,
    detail: source.detail || "-",
    disabled: !!source.disabled,
    quarantined: !!source._comment,
    quarantineReason: source._comment || "-",
  }));
  return {
    allEntries,
    activeEntries: allEntries.filter((source) => !source.quarantined),
    quarantinedEntries: allEntries.filter((source) => source.quarantined),
  };
};
const { allEntries: apiEntries, activeEntries, quarantinedEntries } = partitionSourceEntries(config.api_site);
const checkedEntries = CHECK_QUARANTINED ? apiEntries : activeEntries;

// === 读取历史记录 ===
let history = [];
if (fs.existsSync(REPORT_PATH)) {
  const old = fs.readFileSync(REPORT_PATH, "utf-8");
  const match = old.match(/```json\n([\s\S]+?)\n```/);
  if (match) {
    try {
      history = JSON.parse(match[1]);
    } catch {}
  }
}

// === 当前 CST 时间 ===
const now = new Date(Date.now() + 8 * 60 * 60 * 1000)
  .toISOString()
  .replace("T", " ")
  .slice(0, 16) + " CST";

// === 工具函数（带重试） ===
const delay = ms => new Promise(r => setTimeout(r, ms));

const safeGet = async (url) => {
  for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
    try {
      const res = await axios.get(url, HTTP_OPTIONS);
      return res.status === 200;
    } catch {
      if (attempt < MAX_RETRY) await delay(RETRY_DELAY_MS);
      else return false;
    }
  }
};

const buildSearchUrl = (api, keyword) => {
  const separator = api.includes("?") ? "&" : "?";
  return `${api}${separator}ac=videolist&wd=${encodeURIComponent(keyword)}`;
};

const testSearch = async (api, keyword) => {
  for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
    try {
      const res = await axios.get(buildSearchUrl(api, keyword), HTTP_OPTIONS);
      let data = res.data;
      if (typeof data === "string") {
        try { data = JSON.parse(data); } catch { return "❌"; }
      }
      if (res.status !== 200 || !data || typeof data !== "object") return "❌";
      const list = Array.isArray(data.list) ? data.list : [];
      if (!list.length) return "无结果";
      return list.some(item => JSON.stringify(item).includes(keyword)) ? "✅" : "不匹配";
    } catch {
      if (attempt < MAX_RETRY) await delay(RETRY_DELAY_MS);
      else return "❌";
    }
  }
};

// === 队列并发执行函数 ===
const queueRun = (tasks, limit) => {
  let index = 0;
  let active = 0;
  const results = [];

  return new Promise(resolve => {
    const next = () => {
      while (active < limit && index < tasks.length) {
        const i = index++;
        active++;
        tasks[i]().then(res => results[i] = res)
                  .catch(err => results[i] = { error: err })
                  .finally(() => {
                    active--;
                    next();
                  });
      }

      if (index >= tasks.length && active === 0) resolve(results);
    };

    next();
  });
};

// === 主逻辑 ===
async function main() {
  console.log(
    `⏳ 正在检测 ${checkedEntries.length} 个来源（启用 ${activeEntries.length} / 隔离 ${quarantinedEntries.length}）...`
  );

  const tasks = checkedEntries.map(({ name, api, disabled, quarantined }) => async () => {
    if (disabled) return { name, api, disabled, success: false, searchStatus: "无法搜索" };

    const ok = await safeGet(api);
    const searchStatus = ENABLE_SEARCH_TEST ? await testSearch(api, SEARCH_KEYWORD) : "-";
    return { name, api, disabled, quarantined, success: ok, searchStatus };
  });

  const todayResults = await queueRun(tasks, CONCURRENT_LIMIT);

  const todayRecord = {
    date: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10),
    keyword: SEARCH_KEYWORD,
    checkedQuarantined: CHECK_QUARANTINED,
    results: todayResults,
  };

  history.push(todayRecord);
  if (history.length > MAX_DAYS) history = history.slice(-MAX_DAYS);

  // === 统计和生成报告 ===
  const stats = {};
  for (const { name, api, detail, disabled } of activeEntries) {
    stats[api] = { name, api, detail, disabled, ok: 0, fail: 0, fail_streak: 0, trend: "", searchStatus: "-", status: "❌" };

    for (const day of history) {
      const rec = day.results.find((x) => x.api === api);
      if (!rec) continue;
      if (rec.success) stats[api].ok++;
      else stats[api].fail++;
    }

    let streak = 0;
    for (let i = history.length - 1; i >= 0; i--) {
      const rec = history[i].results.find((x) => x.api === api);
      if (!rec) continue;
      if (rec.success) break;
      streak++;
    }
    const total = stats[api].ok + stats[api].fail;
    stats[api].successRate = total > 0 ? ((stats[api].ok / total) * 100).toFixed(1) + "%" : "-";

    const recent = history.slice(-7);
    stats[api].trend = recent.map(day => {
      const r = day.results.find(x => x.api === api);
      return r ? (r.success ? "✅" : "❌") : "-";
    }).join("");

    const latest = todayResults.find(x => x.api === api);
    if (latest) stats[api].searchStatus = latest.searchStatus;

    if (disabled) stats[api].status = "🚫";
    else if (streak >= WARN_STREAK) stats[api].status = "🚨";
    else if (latest?.success) stats[api].status = "✅";
  }

  // === 生成 Markdown 报告 ===
  let md = `# 源接口健康检测报告\n\n`;
  md += `最近更新时间：${now}\n\n`;
  md += `**启用来源:** ${activeEntries.length} | **隔离来源:** ${quarantinedEntries.length} | **本次检测:** ${checkedEntries.length} | **检测关键词:** ${SEARCH_KEYWORD}\n\n`;
  md += "| 状态 | 资源名称 | 地址 | API | 搜索功能 | 成功次数 | 失败次数 | 成功率 | 最近7天趋势 |\n";
  md += "|------|---------|-----|-----|---------|---------:|--------:|-------:|--------------|\n";

  const sorted = Object.values(stats).sort((a, b) => {
    const order = { "🚨": 1, "❌": 2, "✅": 3, "🚫": 4 };
    return order[a.status] - order[b.status];
  });

  for (const s of sorted) {
    const detailLink = s.detail.startsWith("http") ? `[Link](${s.detail})` : s.detail;
    const apiLink = `[Link](${s.api})`;
    md += `| ${s.status} | ${s.name} | ${detailLink} | ${apiLink} | ${s.searchStatus} | ${s.ok} | ${s.fail} | ${s.successRate} | ${s.trend} |\n`;
  }

  md += `\n## 隔离来源（${quarantinedEntries.length}）\n\n`;
  md += CHECK_QUARANTINED
    ? "> 本次已复查隔离来源；它们仍不会计入启用来源可用率。\n\n"
    : "> 日常检测会跳过隔离来源；每周排程或手动工作流程可重新检查。\n\n";
  md += "| 复查 | 资源名称 | API | 隔离原因 | 搜索功能 |\n";
  md += "|------|---------|-----|---------|---------|\n";

  for (const source of quarantinedEntries) {
    const latest = todayResults.find((result) => result.api === source.api);
    const reviewStatus = latest ? (latest.success ? "✅" : "❌") : "⏸️";
    const searchStatus = latest?.searchStatus || "未复查";
    const reason = String(source.quarantineReason).replace(/\|/g, "\\|");
    md += `| ${reviewStatus} | ${source.name} | [Link](${source.api}) | ${reason} | ${searchStatus} |\n`;
  }

  md += `\n<details>\n<summary>📜 点击展开查看历史检测数据 (JSON)</summary>\n\n`;
  md += "```json\n" + JSON.stringify(history, null, 2) + "\n```\n";
  md += `</details>\n`;


  fs.writeFileSync(REPORT_PATH, md, "utf-8");
  console.log("📄 报告已生成:", REPORT_PATH);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`❌ API 检查失败：${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { buildSearchUrl, partitionSourceEntries };
