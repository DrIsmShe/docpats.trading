import crypto from "crypto";
import axios from "axios";
import Position from "../../models/Position.model.js";

const BASE_URL = "https://api.binance.com";

// ======================
// 🔐 ПОДПИСЬ
// ======================
const sign = (queryString) => {
  return crypto
    .createHmac("sha256", process.env.BINANCE_SECRET_KEY)
    .update(queryString)
    .digest("hex");
};

const privatePost = async (endpoint, params = {}) => {
  const timestamp = Date.now();
  const query = new URLSearchParams({ ...params, timestamp }).toString();
  const signature = sign(query);

  const res = await axios.post(
    `${BASE_URL}${endpoint}?${query}&signature=${signature}`,
    null,
    { headers: { "X-MBX-APIKEY": process.env.BINANCE_API_KEY } },
  );
  return res.data;
};

const privateGet = async (endpoint, params = {}) => {
  const timestamp = Date.now();
  const query = new URLSearchParams({ ...params, timestamp }).toString();
  const signature = sign(query);

  const res = await axios.get(
    `${BASE_URL}${endpoint}?${query}&signature=${signature}`,
    { headers: { "X-MBX-APIKEY": process.env.BINANCE_API_KEY } },
  );
  return res.data;
};

// ======================
// 📊 ТЕКУЩАЯ ЦЕНА
// ======================
export const getCurrentPrice = async (symbol) => {
  const res = await axios.get(`${BASE_URL}/api/v3/ticker/price`, {
    params: { symbol },
  });
  return parseFloat(res.data.price);
};

// ======================
// 📊 БАЛАНС USDT
// ======================
export const getUSDTBalance = async () => {
  const account = await privateGet("/api/v3/account");
  const usdt = account.balances.find((b) => b.asset === "USDT");
  return parseFloat(usdt?.free ?? "0");
};

// ======================
// 🔢 LOT SIZE (Binance требует точности)
// ======================
const getSymbolInfo = async (symbol) => {
  const res = await axios.get(`${BASE_URL}/api/v3/exchangeInfo`, {
    params: { symbol },
  });
  return res.data.symbols[0];
};

const roundToStepSize = (quantity, stepSize) => {
  const precision = Math.round(-Math.log10(parseFloat(stepSize)));
  return parseFloat(quantity.toFixed(precision));
};

// ======================
// 🚀 ОТКРЫТЬ ПОЗИЦИЮ
// ======================
export const openPosition = async ({
  symbol,
  side,
  usdtAmount,
  stopLoss,
  takeProfit,
}) => {
  try {
    // Проверяем нет ли уже открытой позиции
    const existing = await Position.findOne({ symbol, status: "OPEN" });
    if (existing) {
      console.log(`⚠️ Позиция уже открыта для ${symbol}`);
      return null;
    }

    const price = await getCurrentPrice(symbol);
    const symbolInfo = await getSymbolInfo(symbol);
    const lotFilter = symbolInfo.filters.find(
      (f) => f.filterType === "LOT_SIZE",
    );
    const stepSize = lotFilter?.stepSize ?? "0.001";
    const minNotionalFilter = symbolInfo.filters.find(
      (f) => f.filterType === "MIN_NOTIONAL",
    );
    const minNotional = parseFloat(minNotionalFilter?.minNotional ?? "5");

    const rawQty = usdtAmount / price;
    const quantity = roundToStepSize(rawQty, stepSize);
    const notional = quantity * price;

    if (notional < minNotional) {
      console.error(
        `❌ Notional too small: ${notional.toFixed(2)} < ${minNotional}`,
      );
      return null;
    }
    if (quantity <= 0) {
      console.error("❌ Количество слишком маленькое");
      return null;
    }

    console.log(`\n🚀 Открываем ${side} ${symbol}`);
    console.log(`   Цена: ${price} | Qty: ${quantity} | USDT: ${usdtAmount}`);
    console.log(
      `   SL: ${stopLoss?.toFixed(2)} | TP: ${takeProfit?.toFixed(2)}`,
    );

    // Основной ордер
    const order = await privatePost("/api/v3/order", {
      symbol,
      side, // BUY или SELL
      type: "MARKET",
      quantity,
    });

    const filledPrice = parseFloat(order.fills?.[0]?.price ?? price);
    const filledQty = parseFloat(order.executedQty);

    console.log(`✅ Ордер исполнен: ${filledPrice} x ${filledQty}`);

    // Сохраняем позицию в MongoDB
    const position = await Position.create({
      symbol,
      side,
      entryPrice: filledPrice,
      quantity: filledQty,
      usdtAmount,
      stopLoss,
      takeProfit,
      orderId: order.orderId,
      status: "OPEN",
      openedAt: new Date(),
    });

    console.log(`💾 Позиция сохранена: ${position._id}`);
    return position;
  } catch (err) {
    console.error(
      "❌ Ошибка открытия позиции:",
      err.response?.data || err.message,
    );
    return null;
  }
};

// ======================
// 🔒 ЗАКРЫТЬ ПОЗИЦИЮ
// ======================
export const closePosition = async (positionId, reason = "MANUAL") => {
  try {
    const position = await Position.findById(positionId);
    if (!position || position.status !== "OPEN") {
      console.log("⚠️ Позиция не найдена или уже закрыта");
      return null;
    }

    const closeSide = position.side === "BUY" ? "SELL" : "BUY";
    const price = await getCurrentPrice(position.symbol);

    console.log(`\n🔒 Закрываем позицию ${position._id} (${reason})`);
    console.log(`   Цена входа: ${position.entryPrice} | Текущая: ${price}`);

    const order = await privatePost("/api/v3/order", {
      symbol: position.symbol,
      side: closeSide,
      type: "MARKET",
      quantity: position.quantity,
    });

    const exitPrice = parseFloat(order.fills?.[0]?.price ?? price);

    const pnlPercent =
      position.side === "BUY"
        ? (exitPrice - position.entryPrice) / position.entryPrice
        : (position.entryPrice - exitPrice) / position.entryPrice;

    const pnlUSDT = position.usdtAmount * pnlPercent;
    const feeUSDT = position.usdtAmount * 0.001 * 2; // вход + выход
    const netPnL = pnlUSDT - feeUSDT;

    // Обновляем в MongoDB
    position.status = "CLOSED";
    position.exitPrice = exitPrice;
    position.pnlPercent = pnlPercent * 100;
    position.pnlUSDT = netPnL;
    position.closeReason = reason;
    position.closedAt = new Date();
    await position.save();

    console.log(`✅ Позиция закрыта`);
    console.log(
      `   Выход: ${exitPrice} | PnL: ${netPnL.toFixed(4)} USDT (${(pnlPercent * 100).toFixed(2)}%)`,
    );

    return position;
  } catch (err) {
    console.error(
      "❌ Ошибка закрытия позиции:",
      err.response?.data || err.message,
    );
    return null;
  }
};

// ======================
// 👁️ МОНИТОР SL/TP
// ======================
export const monitorPositions = async () => {
  try {
    const openPositions = await Position.find({ status: "OPEN" });

    for (const pos of openPositions) {
      const price = await getCurrentPrice(pos.symbol);

      const pnlPercent =
        pos.side === "BUY"
          ? (price - pos.entryPrice) / pos.entryPrice
          : (pos.entryPrice - price) / pos.entryPrice;

      // SL hit
      if (pos.stopLoss) {
        const slHit =
          pos.side === "BUY" ? price <= pos.stopLoss : price >= pos.stopLoss;

        if (slHit) {
          console.log(`🛑 SL сработал для ${pos.symbol} @ ${price}`);
          await closePosition(pos._id, "SL");
          continue;
        }
      }

      // TP hit
      if (pos.takeProfit) {
        const tpHit =
          pos.side === "BUY"
            ? price >= pos.takeProfit
            : price <= pos.takeProfit;

        if (tpHit) {
          console.log(`🎯 TP сработал для ${pos.symbol} @ ${price}`);
          await closePosition(pos._id, "TP");
          continue;
        }
      }

      // Таймаут (48 часов)
      const hoursOpen = (Date.now() - pos.openedAt.getTime()) / 3600000;
      if (hoursOpen > 48) {
        console.log(
          `⏱️ Таймаут позиции ${pos.symbol} (${hoursOpen.toFixed(1)}h)`,
        );
        await closePosition(pos._id, "TIMEOUT");
      }
    }
  } catch (err) {
    console.error("❌ Ошибка монитора:", err.message);
  }
};
