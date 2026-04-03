import "dotenv/config";
import {
  getMLClientPrediction,
  getMLServiceStatus,
} from "./services/ml/mlClient.service.js";
import { fetchAndStoreCandles } from "./services/market/market.service.js";
import Candle from "./models/Candle.js";
import { momentumStrategy } from "./services/strategies/momentum.strategy.js";
import { meanReversionStrategy } from "./services/strategies/meanReversion.strategy.js";
import { breakoutStrategy } from "./services/strategies/breakout.strategy.js";
import { backtest } from "./services/backtest/backtest.service.js";
import { detectMarketRegime } from "./services/market/marketRegime.js";
import { calculateATR } from "./services/indicators/indicators.service.js";
import Position from "./models/Position.model.js";
import {
  getHigherTimeframeTrend,
  isSignalAlignedWithHTF,
} from "./services/market/multiTimeframe.service.js";
import {
  openPosition,
  monitorPositions,
  getUSDTBalance,
  getCurrentPrice,
} from "./services/execution/execution.service.js";
import {
  notifyStart,
  notifySignal,
  notifyOpenPosition,
  notifyNoEdge,
  notifyError,
  notifyLowBalance,
} from "./services/telegram/telegram.service.js";

const SYMBOL = "BTCUSDT";
const INTERVAL = "1h";
const LIMIT = 2000;

const MIN_BALANCE = 10;
const RISK_PERCENT = 0.01;
const MIN_PROFIT_FACTOR = 1.3;
const MIN_WIN_RATE = 40;
const MIN_TRADES_REQUIRED = 12;
const MAX_DRAWDOWN_ALLOWED = 20;

// ─── Глобальное состояние для dashboard ───────────────────────────────────
export const botState = {
  regime: "—",
  htfTrend: "—",
  volatility: 0,
  bestStrategy: "—",
  lastRun: null,
  mlSignal: "—",
  mlConfidence: 0,
  mlAvailable: false,
  strategies: [],
};

const printResult = (title, r) => {
  const pf = Number.isFinite(r.profitFactor) ? r.profitFactor.toFixed(2) : "∞";
  console.log(`\n📈 ${title}`);
  console.log(`  Balance:      ${r.finalBalance.toFixed(2)}`);
  console.log(`  Trades:       ${r.totalTrades}`);
  console.log(`  WinRate:      ${r.winRate.toFixed(1)}%`);
  console.log(`  ProfitFactor: ${pf}`);
  console.log(`  MaxDrawdown:  ${r.maxDrawdown?.toFixed(1)}%`);
};

const getVolatility = (candles) => {
  const atr = calculateATR(candles);
  const lastATR = atr.at(-1);
  const price = candles.at(-1)?.close;
  return price && lastATR ? (lastATR / price) * 100 : 0;
};

const getVolumeRatio = (candles) => {
  const volumes = candles.slice(-20).map((c) => c.volume);
  const avgVolume =
    volumes.slice(0, -1).reduce((a, b) => a + b, 0) / (volumes.length - 1);
  const lastVol = candles.at(-1)?.volume ?? 0;
  return avgVolume > 0 ? lastVol / avgVolume : 0;
};

const buildSet = ({ momentumResult, meanResult, breakoutResult }) => [
  { name: "Momentum", fn: momentumStrategy, result: momentumResult },
  { name: "Mean Reversion", fn: meanReversionStrategy, result: meanResult },
  { name: "Breakout", fn: breakoutStrategy, result: breakoutResult },
];

const filterValid = (strategies, regime) =>
  strategies.filter((x) => {
    const r = x.result;
    if (!r) return false;

    const baseValid =
      r.totalTrades >= MIN_TRADES_REQUIRED &&
      r.profitFactor >= MIN_PROFIT_FACTOR &&
      r.winRate >= MIN_WIN_RATE &&
      (r.maxDrawdown ?? 100) <= MAX_DRAWDOWN_ALLOWED;

    if (!baseValid) return false;

    if (x.name === "Momentum")
      return regime === "UPTREND" || regime === "DOWNTREND";
    if (x.name === "Breakout")
      return regime === "UPTREND" || regime === "DOWNTREND";
    if (x.name === "Mean Reversion") return regime === "RANGE";

    return false;
  });

const getStrategyScore = (result) => {
  const pf = Number.isFinite(result.profitFactor) ? result.profitFactor : 3;
  const wr = result.winRate ?? 0;
  const dd = result.maxDrawdown ?? 100;
  const trades = result.totalTrades ?? 0;
  return pf * 40 + wr * 0.8 + trades * 1.5 - dd * 1.2;
};

const sortBest = (strategies) =>
  [...strategies].sort(
    (a, b) => getStrategyScore(b.result) - getStrategyScore(a.result),
  );

const getRiskProfile = (strategyName) => {
  if (strategyName === "Momentum") return { sl: 1.5, tp: 3.0 };
  if (strategyName === "Breakout") return { sl: 1.2, tp: 3.5 };
  if (strategyName === "Mean Reversion") return { sl: 1.0, tp: 2.0 };
  return { sl: 1.2, tp: 2.5 };
};

const calcSLTP = (side, price, atr, strategyName) => {
  const profile = getRiskProfile(strategyName);
  return side === "BUY"
    ? {
        stopLoss: price - atr * profile.sl,
        takeProfit: price + atr * profile.tp,
      }
    : {
        stopLoss: price + atr * profile.sl,
        takeProfit: price - atr * profile.tp,
      };
};

// ─── Проверка согласованности ML сигнала со стратегией ───────────────────
// ML говорит BUY а стратегия SELL — не торгуем
const isMLAligned = (strategySignal, mlSignal) => {
  if (!mlSignal || mlSignal === "HOLD") return true; // ML не уверен — доверяем стратегии
  if (strategySignal === "BUY" && mlSignal === "SELL") return false;
  if (strategySignal === "SELL" && mlSignal === "BUY") return false;
  return true;
};

export const start = async () => {
  try {
    console.log(
      `\n🚀 [${new Date().toLocaleTimeString()}] Trading system...\n`,
    );

    await monitorPositions();

    // Обновляем 1h свечи
    await fetchAndStoreCandles(SYMBOL, INTERVAL);
    // Обновляем 4h и 1d для ML
    await fetchAndStoreCandles(SYMBOL, "4h");
    await fetchAndStoreCandles(SYMBOL, "1d");

    const balance = await getUSDTBalance();
    console.log("💰 USDT Balance:", balance.toFixed(2));

    if (balance < MIN_BALANCE) {
      await notifyLowBalance({ balance, required: MIN_BALANCE });
      return;
    }

    const candles = await Candle.find({ symbol: SYMBOL, interval: INTERVAL })
      .sort({ openTime: 1 })
      .limit(LIMIT);

    if (!candles || candles.length < 300) {
      console.log("❌ Недостаточно свечей");
      return;
    }

    const splitIndex = Math.floor(candles.length * 0.8);
    const backtestCandles = candles.slice(0, splitIndex);
    const liveCandles = candles.slice(0);

    // ── Бэктест стратегий ────────────────────────────
    const momentumResult = backtest(backtestCandles, momentumStrategy);
    const meanResult = backtest(backtestCandles, meanReversionStrategy);
    const breakoutResult = backtest(backtestCandles, breakoutStrategy);

    // ── Рыночный контекст ────────────────────────────
    const regime = detectMarketRegime(candles);
    const volatility = getVolatility(candles);
    const htfTrend = await getHigherTimeframeTrend(SYMBOL);
    const volRatio = getVolumeRatio(candles);

    console.log(`🧠 1h Regime: ${regime}  |  4h Trend: ${htfTrend}`);
    console.log(`📊 Volatility (ATR): ${volatility.toFixed(2)}%`);
    console.log(`📊 Volume ratio: ${volRatio.toFixed(2)}x`);

    printResult("Momentum", momentumResult);
    printResult("Mean Reversion", meanResult);
    printResult("Breakout", breakoutResult);

    const allStrategies = buildSet({
      momentumResult,
      meanResult,
      breakoutResult,
    });
    const valid = filterValid(allStrategies, regime);

    Object.assign(botState, {
      regime,
      htfTrend,
      volatility,
      bestStrategy: valid.length ? sortBest(valid)[0].name : "None",
      lastRun: new Date().toISOString(),
      strategies: [
        { name: "Momentum", ...momentumResult },
        { name: "Mean Reversion", ...meanResult },
        { name: "Breakout", ...breakoutResult },
      ],
    });

    await notifyStart({
      symbol: SYMBOL,
      interval: INTERVAL,
      balance,
      regime,
      volatility,
    });

    if (volatility < 0.18) {
      console.log("🧊 Flat / low volatility → skip");
      return;
    }

    if (!valid.length) {
      console.log("\n⚠️  Нет edge → пропускаем");
      await notifyNoEdge({ symbol: SYMBOL, regime });
      return;
    }

    const best = sortBest(valid)[0];
    const liveSignal = best.fn(liveCandles);

    console.log(`\n🏆 Strategy: ${best.name}`);
    console.log(`📡 Signal: ${liveSignal.signal} — ${liveSignal.reason}`);
    console.log(`🔍 4h Filter: ${htfTrend} | Volume: ${volRatio.toFixed(2)}x`);

    // ── Объёмные фильтры ─────────────────────────────
    if (best.name === "Breakout" && volRatio < 1.3) {
      console.log("⛔ Breakout rejected: weak volume");
      await notifyNoEdge({ symbol: SYMBOL, regime });
      return;
    }

    if (best.name === "Momentum" && volRatio < 0.9) {
      console.log("⛔ Momentum rejected: weak volume");
      await notifyNoEdge({ symbol: SYMBOL, regime });
      return;
    }

    // ── HTF фильтр ───────────────────────────────────
    if (!isSignalAlignedWithHTF(liveSignal.signal, htfTrend)) {
      console.log(`⛔ Отклонён — против 4h (${htfTrend})`);
      await notifyNoEdge({ symbol: SYMBOL, regime });
      return;
    }

    if (liveSignal.signal === "HOLD") {
      console.log("⏸️  HOLD → не входим");
      return;
    }

    // ── ML фильтр — только ML-2 (LSTM, 45 признаков) ─
    let mlConfidence = 0.5;
    let mlSignal = "HOLD";
    let mlAvailable = false;

    try {
      const mlResult = await getMLClientPrediction(liveCandles);

      mlConfidence = mlResult.confidence;
      mlSignal = mlResult.signal;
      mlAvailable = mlResult.available;

      Object.assign(botState, { mlSignal, mlConfidence, mlAvailable });

      if (mlAvailable) {
        // Проверяем что ML согласен с направлением стратегии
        if (!isMLAligned(liveSignal.signal, mlSignal)) {
          console.log(
            `🧠 ML-2 против стратегии: стратегия=${liveSignal.signal}, ML=${mlSignal} → отклоняем`,
          );
          await notifyNoEdge({ symbol: SYMBOL, regime });
          return;
        }

        if (mlResult.skip) {
          console.log(
            `🧠 ML-2 неуверен: confidence=${(mlConfidence * 100).toFixed(1)}% < 50% → отклоняем`,
          );
          await notifyNoEdge({ symbol: SYMBOL, regime });
          return;
        }

        console.log(
          `🧠 ML-2 подтвердил: ${mlSignal} (${(mlConfidence * 100).toFixed(1)}%)`,
        );
      } else {
        console.log("⚠️  ML-2 недоступен — торгуем без ML фильтра");
      }
    } catch (mlErr) {
      console.log(`⚠️  ML ошибка: ${mlErr.message} — продолжаем без ML`);
    }

    // ── Размер позиции на основе confidence ──────────
    // Если ML недоступен — используем базовый риск
    const confidence = mlAvailable ? mlConfidence : 0.5;
    liveSignal.confidence = confidence;

    console.log(`📊 ML confidence: ${(confidence * 100).toFixed(1)}%`);

    await notifySignal({
      strategy: best.name,
      signal: liveSignal.signal,
      reason: liveSignal.reason,
      symbol: SYMBOL,
    });

    const currentPrice = await getCurrentPrice(SYMBOL);
    const lastATR = calculateATR(candles).at(-1);
    if (!lastATR) return;

    const side = liveSignal.signal === "BUY" ? "BUY" : "SELL";
    const { stopLoss, takeProfit } = calcSLTP(
      side,
      currentPrice,
      lastATR,
      best.name,
    );

    // Динамический риск на основе ML confidence
    let riskPercent = RISK_PERCENT;
    if (confidence >= 0.75)
      riskPercent = 0.015; // уверен → больше
    else if (confidence >= 0.6)
      riskPercent = 0.01; // норма
    else if (confidence >= 0.5)
      riskPercent = 0.0075; // не очень уверен
    else riskPercent = 0.005; // слабый сигнал

    const usdtAmount = Math.max(balance * riskPercent, 6);

    console.log(
      `\n💸 ${side} | ${usdtAmount.toFixed(2)} USDT | ` +
        `SL: ${stopLoss.toFixed(2)} | TP: ${takeProfit.toFixed(2)} | ` +
        `ML: ${(confidence * 100).toFixed(1)}%`,
    );

    // ── Cooldown 60 минут ─────────────────────────────
    const lastClosed = await Position.findOne({
      symbol: SYMBOL,
      status: "CLOSED",
    }).sort({ closedAt: -1 });

    if (lastClosed?.closedAt) {
      const minutesSinceClose =
        (Date.now() - new Date(lastClosed.closedAt).getTime()) / 60000;
      if (minutesSinceClose < 60) {
        console.log(`⏳ Cooldown: ${minutesSinceClose.toFixed(1)} мин`);
        return;
      }
    }

    // ── Открываем позицию ─────────────────────────────
    const position = await openPosition({
      symbol: SYMBOL,
      side,
      usdtAmount,
      stopLoss,
      takeProfit,
    });

    if (position) {
      await notifyOpenPosition({
        symbol: SYMBOL,
        side,
        entryPrice: position.entryPrice,
        quantity: position.quantity,
        stopLoss,
        takeProfit,
        usdtAmount,
      });
      console.log("✅ Позиция открыта!");
    }
  } catch (err) {
    console.error("❌ ERROR:", err.message);
    await notifyError(err.message);
  }
};
