import test from "node:test";
import assert from "node:assert/strict";
import { run } from "../project.mjs";
import { ValidationError } from "../lib/validate.mjs";

const near = (actual, expected, tolerance = 1e-9) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${actual} ≈ ${expected}`,
  );
const sample = [
  [10, 10, 10, 10],
  [10, 10, 9, 9],
  [9, 9, 8, 8],
  [9, 10, 9, 10],
  [12, 12, 11, 11],
  [10, 10, 7, 7],
  [6, 6, 6, 6],
];
const csv = (bars = sample) =>
  "date,open,high,low,close\n" +
  bars
    .map(
      (bar, index) =>
        `2026-01-${String(index + 1).padStart(2, "0")},${bar.join(",")}`,
    )
    .join("\n");
const defaults = {
  csv: csv(),
  fastWindow: 2,
  slowWindow: 3,
  initialCash: 1000,
  commissionBps: 100,
  periodsPerYear: 7,
};
const demo = { generate: async (spec) => spec.demo() };

test("method C executes strict crossings at the next open and includes both commissions", async () => {
  const result = await run(defaults, demo);
  assert.deepEqual(
    result.trades.map(({ signalDate, date, side, quantity }) => ({
      signalDate,
      date,
      side,
      quantity,
    })),
    [
      {
        signalDate: "2026-01-05",
        date: "2026-01-06",
        side: "buy",
        quantity: 99,
      },
      {
        signalDate: "2026-01-06",
        date: "2026-01-07",
        side: "sell",
        quantity: 99,
      },
    ],
  );
  near(result.trades[0].fee, 9.9);
  near(result.trades[0].cash, 0.1);
  near(result.trades[1].fee, 5.94);
  near(result.trades[1].realizedPnl, -411.84);
  near(result.ending.equity, 588.16);
  near(result.metrics.totalReturn, -0.41184);
  near(result.summary.totalFees, 15.84);
  assert.equal(result.summary.tradeCount, 2);
  assert.equal(result.summary.closedTrades, 1);
  assert.equal(result.summary.winRate, 0);
});

test("six-row method C retains its open position without a fictional sale or win rate", async () => {
  const result = await run({ ...defaults, csv: csv(sample.slice(0, 6)) }, demo);
  near(result.ending.equity, 693.1);
  near(result.ending.cash, 0.1);
  assert.equal(result.ending.quantity, 99);
  assert.equal(result.ending.marketValue, 693);
  assert.equal(result.trades.length, 1);
  assert.equal(result.summary.closedTrades, 0);
  assert.equal(result.summary.winRate, null);
  near(result.summary.totalFees, 9.9);
  assert.ok(result.warnings.some((warning) => warning.includes("未执行")));
});

test("appending or changing future prices cannot change earlier transactions or equity", async () => {
  const prefix = await run({ ...defaults, csv: csv(sample.slice(0, 6)) }, demo);
  const future = await run(
    {
      ...defaults,
      csv: csv([...sample.slice(0, 6), [60, 65, 55, 62], [64, 66, 63, 65]]),
    },
    demo,
  );
  assert.deepEqual(future.equity.slice(0, 7), prefix.equity);
  assert.deepEqual(future.price.fast.slice(0, 6), prefix.price.fast);
  assert.deepEqual(
    future.trades.filter((trade) => trade.date <= "2026-01-06"),
    prefix.trades,
  );
});

test("benchmark buys whole shares at the first open and never charges an unexecuted sale", async () => {
  const result = await run(defaults, demo);
  near(result.benchmark.equity[1], 990.1);
  near(result.benchmark.equity.at(-1), 594.1);
  near(result.benchmark.metrics.totalReturn, -0.4059);
  assert.equal(result.equity.length, result.dates.length + 1);
  assert.equal(result.chartDates.length, result.equity.length);
  assert.equal(result.drawdown.length, result.equity.length);
  const decimal = await run(
    {
      ...defaults,
      initialCash: 4.3,
      commissionBps: 0,
      csv: csv([
        [0.1, 0.1, 0.1, 0.1],
        [0.1, 0.1, 0.1, 0.1],
        [0.1, 0.1, 0.1, 0.1],
        [0.1, 0.2, 0.1, 0.2],
      ]),
    },
    demo,
  );
  near(decimal.benchmark.equity.at(-1), 8.6);
  const strategy = await run(
    {
      ...defaults,
      initialCash: 4.3,
      commissionBps: 0,
      csv: csv(
        sample.slice(0, 6).map((bar) => bar.map((value) => value / 100)),
      ),
    },
    demo,
  );
  assert.equal(strategy.trades[0].quantity, 43);
  assert.equal(strategy.ending.cash, 0);
  assert.equal(strategy.ending.quantity, 43);
  near(strategy.ending.equity, 3.01);
});

test("insufficient cash skips a zero-share order and keeps nonnegative cash", async () => {
  const result = await run({ ...defaults, initialCash: 1 }, demo);
  assert.equal(result.trades.length, 0);
  assert.deepEqual(result.equity, Array(8).fill(1));
  assert.equal(result.ending.quantity, 0);
  assert.equal(result.summary.totalFees, 0);
  assert.ok(result.warnings.some((warning) => warning.includes("未成交")));
  assert.ok(
    result.warnings.some((warning) => warning.includes("基准全程持有现金")),
  );
});

test("equal or immature moving averages create no crossover trade", async () => {
  const result = await run({ ...defaults, csv: csv(sample.slice(0, 4)) }, demo);
  assert.deepEqual(result.price.fast, [null, 9.5, 8.5, 9]);
  assert.deepEqual(result.price.slow, [null, null, 9, 9]);
  assert.equal(result.trades.length, 0);
  const increasing = await run(
    {
      ...defaults,
      csv: csv([1, 2, 3, 4, 5].map((value) => [value, value, value, value])),
    },
    demo,
  );
  assert.equal(increasing.trades.length, 0);
});

test("settings, real dates, row count and OHLC bounds are validated", async () => {
  for (const invalid of [
    { fastWindow: 1 },
    { slowWindow: 2 },
    { slowWindow: 201 },
    { initialCash: 0 },
    { commissionBps: -1 },
    { commissionBps: 1001 },
    { periodsPerYear: 366 },
    { csv: csv(sample.slice(0, 3)) },
    { csv: csv().replace("2026-01-02", "2026-02-30") },
    { csv: csv().replace("2026-01-02", "2026-01-01") },
    { csv: csv().replace("2026-01-01,10,10,10,10", "2026-01-01,10,9,10,10") },
    { csv: csv().replace("2026-01-01,10,10,10,10", "2026-01-01,,10,10,10") },
  ]) {
    await assert.rejects(
      run({ ...defaults, ...invalid }, demo),
      ValidationError,
    );
  }
});

test("unsafe integer share counts and extreme loss rounding are rejected clearly", async () => {
  const tiny = csv(Array.from({ length: 4 }, () => [1e-6, 1e-6, 1e-6, 1e-6]));
  await assert.rejects(
    run({ ...defaults, csv: tiny, initialCash: 1e12, commissionBps: 0 }, demo),
    /安全整数/,
  );
  const extreme = csv([
    [1e12, 1e12, 1e-6, 1e-6],
    ...Array.from({ length: 3 }, () => [1e-6, 1e-6, 1e-6, 1e-6]),
  ]);
  await assert.rejects(
    run(
      { ...defaults, csv: extreme, initialCash: 1e12, commissionBps: 0 },
      demo,
    ),
    /精度不足/,
  );
});

test("model sees aggregate metrics and counts only, not OHLC or transaction records", async () => {
  let observed;
  const inputCsv = csv()
    .replace("date,open,high,low,close", "date,open,high,low,close,note")
    .split("\n")
    .map((line, index) => (index ? `${line},PRIVATE_LEDGER_${index}` : line))
    .join("\n");
  const result = await run(
    { ...defaults, csv: inputCsv },
    {
      generate: async (spec) => {
        observed = spec;
        return { text: "仅解读已计算的回测汇总。" };
      },
    },
  );
  const sent = JSON.parse(observed.input);
  assert.deepEqual(Object.keys(sent), [
    "settings",
    "summary",
    "ending",
    "metrics",
    "benchmarkMetrics",
  ]);
  assert.deepEqual(sent.ending, result.ending);
  assert.ok(!observed.input.includes("PRIVATE_LEDGER"));
  assert.equal(sent.trades, undefined);
  assert.equal(sent.equity, undefined);
  assert.equal(sent.price, undefined);
  assert.match(observed.instructions, /next open/);
  assert.equal(result.insight, "仅解读已计算的回测汇总。");
});

test("closed-trade win rate includes fees and remains distinct from daily positive periods", async () => {
  const profitable = await run(
    { ...defaults, csv: csv([...sample.slice(0, 6), [15, 15, 15, 15]]) },
    demo,
  );
  near(profitable.trades[1].realizedPnl, 470.25);
  assert.equal(profitable.summary.winningTrades, 1);
  assert.equal(profitable.summary.winRate, 1);
  assert.notEqual(
    profitable.metrics.positivePeriodRate,
    profitable.summary.winRate,
  );
  assert.match(profitable.insight, /本地规则回测/);
});
