import { assert } from "./lib/validate.mjs";
import { parseCSV, numeric } from "./lib/data.mjs";
import { validDate, computePerformance } from "./lib/finance.mjs";

function finite(value) {
  assert(
    Number.isFinite(value),
    "回测计算超出有限数值范围，请缩小价格或资金规模。",
  );
  return value;
}

function purchase(cash, price, commission) {
  let quantity = Math.floor(finite(cash / finite(price * (1 + commission))));
  assert(
    Number.isSafeInteger(quantity) && quantity >= 0,
    "可买股数超出安全整数范围，请减小资金或提高价格。",
  );
  const costFor = (shares) => {
    const gross = finite(shares * price);
    const fee = finite(gross * commission);
    return { fee, cost: finite(gross + fee) };
  };
  // Division can put an affordable integer just below its boundary (4.3 / .1).
  if (Number.isSafeInteger(quantity + 1) && costFor(quantity + 1).cost <= cash)
    quantity++;
  if (costFor(quantity).cost > cash && quantity > 0) quantity--;
  const { fee, cost } = costFor(quantity);
  const remainder = finite(cash - cost);
  assert(remainder >= 0, "买入成本超过可用现金，无法可靠计算成交数量。");
  return { quantity, fee, cost, cash: remainder };
}

function meanAt(values, index, window) {
  if (index + 1 < window) return null;
  let sum = 0;
  for (let i = index + 1 - window; i <= index; i++)
    sum = finite(sum + values[i]);
  return finite(sum / window);
}

function performance(equity, periodsPerYear) {
  const returns = equity.slice(1).map((value, index) => {
    assert(
      value > 0 && equity[index] > 0,
      "权益必须保持正值，无法计算收益率。",
    );
    const ratio = finite(value / equity[index]);
    const result = finite(ratio - 1);
    assert(
      ratio > 0 && result > -1,
      "权益变化幅度过大，收益率被舍入为 -100%；数值精度不足。",
    );
    return result;
  });
  return computePerformance(returns, periodsPerYear, 0);
}

export async function run(payload, { generate }) {
  const { fastWindow, slowWindow, initialCash, commissionBps, periodsPerYear } =
    payload;
  assert(
    Number.isInteger(fastWindow) && fastWindow >= 2 && fastWindow <= 100,
    "短均线窗口必须是 2–100 的整数。",
  );
  assert(
    Number.isInteger(slowWindow) &&
      slowWindow >= 3 &&
      slowWindow <= 200 &&
      slowWindow > fastWindow,
    "长均线窗口必须是 3–200 的整数且大于短窗口。",
  );
  assert(
    typeof initialCash === "number" &&
      Number.isFinite(initialCash) &&
      initialCash >= 1 &&
      initialCash <= 1e12,
    "初始现金必须在 1 至 1e12 之间。",
  );
  assert(
    typeof commissionBps === "number" &&
      Number.isFinite(commissionBps) &&
      commissionBps >= 0 &&
      commissionBps <= 1000,
    "单边佣金必须在 0–1000 个基点之间。",
  );
  assert(
    Number.isInteger(periodsPerYear) &&
      periodsPerYear >= 1 &&
      periodsPerYear <= 365,
    "每年期数必须是 1–365 的整数。",
  );
  const { columns, rows } = parseCSV(payload.csv);
  const required = ["date", "open", "high", "low", "close"];
  assert(
    required.every((name) => columns.includes(name)),
    "CSV 必须包含 date、open、high、low、close 五列。",
  );
  assert(
    rows.length >= slowWindow + 1,
    `至少需要 ${slowWindow + 1} 行，才能比较两期成熟均线。`,
  );
  const indexes = Object.fromEntries(
    required.map((name) => [name, columns.indexOf(name)]),
  );
  const bars = [];
  rows.forEach((row, index) => {
    const date = row[indexes.date];
    assert(
      validDate(date),
      `第 ${index + 2} 行日期不是有效的 YYYY-MM-DD 日期。`,
    );
    assert(
      index === 0 || date > bars[index - 1].date,
      "日期必须严格升序且不能重复。",
    );
    const bar = { date };
    for (const field of ["open", "high", "low", "close"]) {
      const value = numeric(row[indexes[field]]);
      assert(
        value !== null && value >= 1e-6 && value <= 1e12,
        `第 ${index + 2} 行 ${field} 必须是 1e-6 至 1e12 的有限正价格。`,
      );
      bar[field] = value;
    }
    assert(
      bar.low <= bar.open &&
        bar.open <= bar.high &&
        bar.low <= bar.close &&
        bar.close <= bar.high,
      `第 ${index + 2} 行 OHLC 不满足 low ≤ open/close ≤ high。`,
    );
    bars.push(bar);
  });
  const settings = {
    fastWindow,
    slowWindow,
    initialCash,
    commissionBps,
    periodsPerYear,
  };
  const commission = commissionBps / 10000;
  const warnings = [];
  if (columns.length > required.length)
    warnings.push(`已忽略 ${columns.length - required.length} 个额外列。`);
  const dates = bars.map((bar) => bar.date);
  const close = bars.map((bar) => bar.close);
  const fast = [];
  const slow = [];
  const trades = [];
  const equity = [initialCash];
  let cash = initialCash;
  let quantity = 0;
  let entryCost = 0;
  let pending = null;
  let totalFees = 0;
  let closedTrades = 0;
  let winningTrades = 0;
  for (let index = 0; index < bars.length; index++) {
    const bar = bars[index];
    if (pending) {
      if (pending.side === "buy" && quantity === 0) {
        const order = purchase(cash, bar.open, commission);
        if (order.quantity === 0)
          warnings.push(
            `${bar.date} 买入信号未成交：现金不足以支付一股及佣金。`,
          );
        else {
          cash = order.cash;
          quantity = order.quantity;
          entryCost = order.cost;
          totalFees = finite(totalFees + order.fee);
          trades.push({
            signalDate: pending.signalDate,
            date: bar.date,
            side: "buy",
            quantity,
            price: bar.open,
            fee: order.fee,
            cash,
            realizedPnl: null,
          });
        }
      } else if (pending.side === "sell" && quantity > 0) {
        const gross = finite(quantity * bar.open);
        const fee = finite(gross * commission);
        const proceeds = finite(gross - fee);
        cash = finite(cash + proceeds);
        assert(cash >= 0, "卖出后现金出现负值，无法继续回测。");
        const realizedPnl = finite(proceeds - entryCost);
        totalFees = finite(totalFees + fee);
        closedTrades++;
        if (realizedPnl > 0) winningTrades++;
        trades.push({
          signalDate: pending.signalDate,
          date: bar.date,
          side: "sell",
          quantity,
          price: bar.open,
          fee,
          cash,
          realizedPnl,
        });
        quantity = 0;
        entryCost = 0;
      }
      pending = null;
    }
    equity.push(finite(cash + finite(quantity * bar.close)));
    fast.push(meanAt(close, index, fastWindow));
    slow.push(meanAt(close, index, slowWindow));
    // Both the current and previous windows must be mature before a crossing.
    if (index >= slowWindow) {
      if (
        quantity === 0 &&
        fast[index] > slow[index] &&
        fast[index - 1] <= slow[index - 1]
      )
        pending = { side: "buy", signalDate: bar.date };
      else if (
        quantity > 0 &&
        fast[index] < slow[index] &&
        fast[index - 1] >= slow[index - 1]
      )
        pending = { side: "sell", signalDate: bar.date };
    }
  }
  if (pending)
    warnings.push(
      `末日 ${pending.signalDate} 的${pending.side === "buy" ? "买入" : "卖出"}信号没有下一期开盘，未执行。`,
    );
  const calculated = performance(equity, periodsPerYear);
  const benchmarkOrder = purchase(initialCash, bars[0].open, commission);
  if (benchmarkOrder.quantity === 0)
    warnings.push("买入持有基准现金不足一股及佣金，基准全程持有现金。");
  const benchmarkEquity = [
    initialCash,
    ...bars.map((bar) =>
      finite(benchmarkOrder.cash + finite(benchmarkOrder.quantity * bar.close)),
    ),
  ];
  const benchmarkCalculated = performance(benchmarkEquity, periodsPerYear);
  warnings.push(
    ...calculated.warnings,
    ...benchmarkCalculated.warnings.map((warning) => `基准：${warning}`),
  );
  warnings.push(
    "只做多整股；收盘严格交叉的信号仅在下一期开盘成交。末尾按收盘估值，不强制平仓、不扣假设的卖出费。",
  );
  warnings.push(
    "佣金在买卖两端分别扣除；不含滑点、税费、分红和拆股调整，请使用同一复权口径的 OHLC。",
  );
  warnings.push(
    "年化按观测行数与每年期数计算，不按自然日；历史回测不能预测未来表现。已平仓胜率与正收益期占比含义不同。",
  );
  const marketValue = finite(quantity * bars.at(-1).close);
  const ending = { cash, quantity, marketValue, equity: equity.at(-1) };
  const summary = {
    tradeCount: trades.length,
    closedTrades,
    winningTrades,
    winRate: closedTrades ? winningTrades / closedTrades : null,
    totalFees,
  };
  const generated = await generate({
    instructions:
      "Explain this deterministic historical long-only integer-share SMA backtest in Chinese. Only settings, summary counts, ending account aggregates and computed metrics are provided. Do not invent prices, dates of trades or a trade ledger; raw OHLC and individual transactions are absent. Signals use strict mature-window crossings at the close and execute at the next open. Actual buy and sell commissions are included. Open positions remain marked at the last close, without a forced sale. Closed-trade win rate is not positive-period rate; null means undefined. Annualization uses observed periods, not calendar days. This is not a forecast or an investment recommendation. Never claim that a historical strategy will remain profitable.",
    input: JSON.stringify({
      settings,
      summary,
      ending,
      metrics: calculated.metrics,
      benchmarkMetrics: benchmarkCalculated.metrics,
    }),
    demo: () => ({
      text: `本地规则回测（未调用模型）：共 ${bars.length} 期、${trades.length} 次实际成交、${closedTrades} 笔已平仓交易。信号由当期收盘确认，在下一期开盘成交；费用已计入现金和已实现盈亏。期末${quantity > 0 ? "仍有持仓，按最后收盘价估值" : "持有现金"}。这份历史模拟不能预测未来收益。`,
      annotations: [],
      usage: null,
    }),
  });
  assert(
    generated && typeof generated.text === "string" && generated.text.trim(),
    "未能生成可用的回测解读，请重试。",
  );
  return {
    settings,
    dates,
    chartDates: ["初始", ...dates],
    equity,
    drawdown: calculated.drawdown,
    metrics: calculated.metrics,
    benchmark: {
      equity: benchmarkEquity,
      metrics: benchmarkCalculated.metrics,
    },
    price: { close, fast, slow },
    trades,
    ending,
    summary,
    warnings,
    insight: generated.text,
  };
}
