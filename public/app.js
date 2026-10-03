import {
  $,
  escape,
  toast,
  download,
  csv,
  init,
  run,
  busy,
  resultMeta,
  fileText,
} from "./ui.js";
import { num, pct, lines } from "./charts.js";
import { reportHTML } from "./reports.js";
let result = null,
  pending = false;
const headers = [
  "信号日",
  "成交日",
  "方向",
  "数量",
  "成交价",
  "费用",
  "剩余现金",
  "卖出实现盈亏",
];
function lock(on) {
  pending = on;
  document
    .querySelectorAll(
      "#sample,#csv,#file,#fast,#slow,#cash,#fee,#frequency,#analyze,#mode",
    )
    .forEach((el) => (el.disabled = on));
}
function sample() {
  let prev = 80;
  const rows = ["date,open,high,low,close"];
  for (let i = 0; i < 70; i++) {
    const date = new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10),
      close = 80 + i * 0.1 + 8 * Math.sin(i * 0.38),
      open = prev * (1 + 0.006 * Math.sin(i * 0.7)),
      high = Math.max(open, close) + 1,
      low = Math.min(open, close) - 1;
    rows.push(
      [date, open, high, low, close]
        .map((v, j) => (j ? v.toFixed(2) : v))
        .join(","),
    );
    prev = close;
  }
  $("#csv").value = rows.join("\n");
  $("#fast").value = "3";
  $("#slow").value = "7";
  $("#cash").value = "100000";
  $("#fee").value = "10";
  $("#frequency").value = "365";
}
function tradeRows(raw = false) {
  return result.trades.map((t) => [
    t.signalDate,
    t.date,
    t.side === "buy" ? "买入" : "卖出",
    t.quantity,
    ...[t.price, t.fee, t.cash, t.realizedPnl].map((v) =>
      raw ? v : num(v, 4),
    ),
  ]);
}
function table(headers, rows) {
  return (
    '<table class="data-table"><thead><tr>' +
    headers.map((h) => "<th>" + escape(h) + "</th>").join("") +
    "</tr></thead><tbody>" +
    rows
      .map(
        (row) =>
          "<tr>" +
          row.map((c) => "<td>" + escape(c) + "</td>").join("") +
          "</tr>",
      )
      .join("") +
    "</tbody></table>"
  );
}
function metricRows() {
  return [
    [
      "总收益",
      pct(result.metrics.totalReturn),
      pct(result.benchmark.metrics.totalReturn),
    ],
    [
      "年化复合收益",
      pct(result.metrics.annualReturn),
      pct(result.benchmark.metrics.annualReturn),
    ],
    [
      "年化波动",
      pct(result.metrics.annualVolatility),
      pct(result.benchmark.metrics.annualVolatility),
    ],
    [
      "最大回撤",
      pct(result.metrics.maxDrawdown),
      pct(result.benchmark.metrics.maxDrawdown),
    ],
  ];
}
function render(r) {
  result = { ...r.data, meta: r.meta };
  const m = result.metrics,
    s = result.summary,
    e = result.ending;
  $("#metrics").innerHTML = [
    ["策略总收益", pct(m.totalReturn)],
    ["最大回撤", pct(m.maxDrawdown)],
    ["已平仓交易胜率", pct(s.winRate)],
    ["实际成交笔数", num(s.tradeCount, 0)],
  ]
    .map(
      ([label, value]) =>
        `<div class="metric-card"><span>${label}</span><strong>${value}</strong></div>`,
    )
    .join("");
  $("#price-chart").innerHTML = lines(
    [
      { name: "收盘价", values: result.price.close, labels: result.dates },
      { name: "快均线", values: result.price.fast, labels: result.dates },
      { name: "慢均线", values: result.price.slow, labels: result.dates },
    ],
    { label: "价格与移动均线" },
  );
  $("#equity-chart").innerHTML = lines(
    [
      { name: "策略权益", values: result.equity, labels: result.chartDates },
      {
        name: "买入持有",
        values: result.benchmark.equity,
        labels: result.chartDates,
      },
    ],
    { label: "策略与买入持有的账户权益" },
  );
  $("#ending").innerHTML =
    `<p>期末现金 ${num(e.cash)} · 持仓 ${num(e.quantity, 0)} 股 · 持仓市值 ${num(e.marketValue)} · 总权益 ${num(e.equity)}</p><div class="table-wrap">${table(["历史指标", "策略", "买入持有"], metricRows())}</div>`;
  $("#drawdown-chart").innerHTML = lines(
    [{ name: "策略回撤", values: result.drawdown, labels: result.chartDates }],
    { label: "策略历史回撤", format: pct },
  );
  $("#trade-summary").textContent =
    `共 ${s.closedTrades} 笔已平仓交易，其中盈利 ${s.winningTrades} 笔；实际总手续费 ${num(s.totalFees, 4)}。未平仓部分不计入胜率。`;
  $("#trades").innerHTML = result.trades.length
    ? table(headers, tradeRows())
    : '<p class="muted">本组参数与数据没有成交。</p>';
  $("#warnings").textContent = result.warnings.join("\n");
  $("#meta").innerHTML = resultMeta(r.meta);
  $("#insight").textContent = result.insight;
  $("#exports").hidden = false;
}
$("#sample").onclick = sample;
$("#file").onchange = async (e) => {
  if (pending) return;
  lock(true);
  try {
    const f = e.target.files[0];
    if (!f) return;
    if (!/\.csv$/i.test(f.name)) throw Error("请选择 CSV 文件");
    const text = await fileText(f, 750000);
    if (text.length > 250000) throw Error("最多 250,000 字符");
    $("#csv").value = text;
  } catch (err) {
    toast(err.message, true);
  } finally {
    e.target.value = "";
    lock(false);
  }
};
$("#strategy-form").onsubmit = async (e) => {
  e.preventDefault();
  if (pending) return;
  lock(true);
  busy($("#analyze"), true, "逐期模拟中…");
  try {
    render(
      await run({
        csv: $("#csv").value,
        fastWindow: Number($("#fast").value),
        slowWindow: Number($("#slow").value),
        initialCash: Number($("#cash").value),
        commissionBps: Number($("#fee").value),
        periodsPerYear: Number($("#frequency").value),
      }),
    );
  } catch (err) {
    toast(err.message, true);
  } finally {
    busy($("#analyze"), false);
    lock(false);
  }
};
$("#export-json").onclick = () =>
  result &&
  download(
    "strategy-backtest.json",
    JSON.stringify(result, null, 2),
    "application/json",
  );
$("#export-csv").onclick = () =>
  result &&
  download(
    "strategy-trades.csv",
    csv([headers, ...tradeRows(true)]),
    "text/csv;charset=utf-8",
  );
$("#export-html").onclick = () => {
  if (!result) return;
  const s = result.settings;
  download(
    "strategy-report.html",
    reportHTML({
      title: "均线交叉历史回测",
      subtitle: "Strategy Trail · 仅做多 / 下一期开盘成交",
      metrics: [
        { label: "总收益", value: pct(result.metrics.totalReturn) },
        { label: "最大回撤", value: pct(result.metrics.maxDrawdown) },
        { label: "已平仓交易", value: result.summary.closedTrades },
        { label: "期末权益", value: num(result.ending.equity) },
      ],
      sections: [
        {
          title: "策略与基准",
          headers: ["历史指标", "策略", "买入持有"],
          rows: metricRows(),
        },
        { title: "实际成交记录", headers, rows: tradeRows() },
        {
          title: "期末持仓",
          text: `现金 ${num(result.ending.cash)}；数量 ${result.ending.quantity}；市值 ${num(result.ending.marketValue)}。未强制平仓。`,
        },
        { title: "解读", text: result.insight },
      ],
      notes: [
        `日期 ${result.dates[0]} 至 ${result.dates.at(-1)}；快/慢窗口 ${s.fastWindow}/${s.slowWindow}；初始现金 ${num(s.initialCash)}；单边手续费 ${s.commissionBps} 基点；每年 ${s.periodsPerYear} 期。`,
        "均线均成熟后严格交叉才产生信号；下一期开盘成交。整股、无杠杆、无滑点；历史模拟不是未来预测。",
        ...result.warnings,
      ],
    }),
    "text/html;charset=utf-8",
  );
};
await init();
