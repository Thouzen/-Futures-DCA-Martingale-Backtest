/* ==========================================================================
   FUTURES DCA / MARTINGALE BACKTEST & SIMULATION TERMINAL
   Zero-dependency Vanilla JS (ES2022) + TradingView Lightweight Charts v4
   ========================================================================== */

(() => {
  'use strict';

  /* ==================== SABİTLER & YARDIMCILAR ==================== */
  const TIMEFRAME_MS = {
    '5m': 5 * 60 * 1000,
    '15m': 15 * 60 * 1000,
    '30m': 30 * 60 * 1000,
    '1h': 60 * 60 * 1000,
    '4h': 4 * 60 * 60 * 1000,
  };

  const BYBIT_INTERVAL = {
    '5m': '5',
    '15m': '15',
    '30m': '30',
    '1h': '60',
    '4h': '240',
  };

  const SETTINGS_STORAGE_KEY = 'futures_dca_terminal_settings_v1';

  const fmtPrice = (val) => {
    if (val === null || val === undefined || Number.isNaN(val)) return '—';
    const abs = Math.abs(val);
    let decimals = 2;
    if (abs < 0.01) decimals = 6;
    else if (abs < 1) decimals = 5;
    else if (abs < 10) decimals = 4;
    else if (abs < 100) decimals = 3;
    else decimals = 2;
    return Number(val).toLocaleString('en-US', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
  };

  const fmtUsd = (val, decimals = 2) => {
    if (val === null || val === undefined || Number.isNaN(val)) return '$0.00';
    return '$' + Number(val).toLocaleString('en-US', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
  };

  const fmtSignedUsd = (val, decimals = 2) => {
    if (val === null || val === undefined || Number.isNaN(val)) return '$0.00';
    const sign = val > 0 ? '+' : val < 0 ? '-' : '';
    return `${sign}$${Math.abs(val).toLocaleString('en-US', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    })}`;
  };

  const fmtSignedPct = (val, decimals = 2) => {
    if (val === null || val === undefined || Number.isNaN(val)) return '0.00%';
    const sign = val > 0 ? '+' : '';
    return `${sign}${val.toFixed(decimals)}%`;
  };

  const fmtDateTime = (unixSec) => {
    if (!unixSec) return '—';
    const d = new Date(unixSec * 1000);
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  const toDateInputValue = (date) => {
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ==================== TOAST BİLDİRİM SİSTEMİ ==================== */
  function showToast(message, type = 'info', duration = 3800) {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.textContent = message;
    container.appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transform = 'translateY(6px)';
      el.style.transition = 'opacity 0.2s ease, transform 0.2s ease';
      setTimeout(() => el.remove(), 220);
    }, duration);
  }

  /* ==================== INDEXEDDB ÇEVRİMDIŞI ÖNBELLEK ==================== */
  const CacheDB = {
    dbName: 'FuturesDCABacktestDB',
    storeName: 'klines',
    db: null,

    async open() {
      if (this.db) return this.db;
      if (!('indexedDB' in window)) return null;
      return new Promise((resolve) => {
        const req = indexedDB.open(this.dbName, 1);
        req.onupgradeneeded = (e) => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains(this.storeName)) {
            db.createObjectStore(this.storeName, { keyPath: 'key' });
          }
        };
        req.onsuccess = (e) => {
          this.db = e.target.result;
          resolve(this.db);
        };
        req.onerror = () => resolve(null);
      });
    },

    async get(key) {
      const db = await this.open();
      if (!db) return null;
      return new Promise((resolve) => {
        const tx = db.transaction(this.storeName, 'readonly');
        const req = tx.objectStore(this.storeName).get(key);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      });
    },

    async put(record) {
      const db = await this.open();
      if (!db) return false;
      return new Promise((resolve) => {
        const tx = db.transaction(this.storeName, 'readwrite');
        tx.objectStore(this.storeName).put(record);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      });
    },

    async count() {
      const db = await this.open();
      if (!db) return 0;
      return new Promise((resolve) => {
        const tx = db.transaction(this.storeName, 'readonly');
        const req = tx.objectStore(this.storeName).count();
        req.onsuccess = () => resolve(req.result || 0);
        req.onerror = () => resolve(0);
      });
    },

    async clear() {
      const db = await this.open();
      if (!db) return false;
      return new Promise((resolve) => {
        const tx = db.transaction(this.storeName, 'readwrite');
        tx.objectStore(this.storeName).clear();
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      });
    },

    mergeCandles(existing, incoming) {
      const map = new Map();
      for (const c of existing || []) map.set(c.time, c);
      for (const c of incoming || []) map.set(c.time, c);
      return Array.from(map.values()).sort((a, b) => a.time - b.time);
    },
  };

  /* ==================== VERİ MOTORU (BYBIT + BINANCE + OFFLINE) ==================== */
  const DataEngine = {
    async fetchWithTimeout(url, timeoutMs = 12000) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
      } finally {
        clearTimeout(timer);
      }
    },

    async fetchBybitKlines(symbol, timeframe, startMs, endMs, onProgress) {
      const interval = BYBIT_INTERVAL[timeframe];
      const tfMs = TIMEFRAME_MS[timeframe];
      const expectedTotal = Math.max(1, Math.ceil((endMs - startMs) / tfMs));
      const allMap = new Map();
      let cursorEnd = endMs;
      const maxPages = 60;

      for (let page = 0; page < maxPages; page++) {
        const url = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${encodeURIComponent(symbol)}&interval=${interval}&start=${startMs}&end=${cursorEnd}&limit=1000`;
        const json = await this.fetchWithTimeout(url);

        if (json.retCode !== 0 || !json.result || !Array.isArray(json.result.list)) {
          throw new Error(json.retMsg || 'Bybit API geçersiz yanıt');
        }

        const list = json.result.list;
        if (list.length === 0) break;

        let oldestMs = Infinity;
        for (const row of list) {
          const tsMs = Number(row[0]);
          if (tsMs < oldestMs) oldestMs = tsMs;
          if (tsMs >= startMs && tsMs <= endMs) {
            const tSec = Math.floor(tsMs / 1000);
            allMap.set(tSec, {
              time: tSec,
              open: parseFloat(row[1]),
              high: parseFloat(row[2]),
              low: parseFloat(row[3]),
              close: parseFloat(row[4]),
              volume: parseFloat(row[5] || 0),
            });
          }
        }

        const pct = Math.min(99, Math.round((allMap.size / expectedTotal) * 100));
        if (onProgress) onProgress(`Bybit V5: ${allMap.size.toLocaleString('tr-TR')} / ~${expectedTotal.toLocaleString('tr-TR')} mum`, pct);

        if (oldestMs <= startMs || list.length < 1000) break;
        const nextEnd = oldestMs - 1;
        if (nextEnd >= cursorEnd) break;
        cursorEnd = nextEnd;

        if (page > 2) await sleep(80);
      }

      const candles = Array.from(allMap.values()).sort((a, b) => a.time - b.time);
      if (candles.length === 0) throw new Error('Bybit boş veri döndürdü');
      return candles;
    },

    async fetchBinanceKlines(symbol, timeframe, startMs, endMs, onProgress) {
      const tfMs = TIMEFRAME_MS[timeframe];
      const expectedTotal = Math.max(1, Math.ceil((endMs - startMs) / tfMs));
      const allMap = new Map();
      let cursorStart = startMs;
      const maxPages = 60;

      for (let page = 0; page < maxPages; page++) {
        const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=${timeframe}&startTime=${cursorStart}&endTime=${endMs}&limit=1500`;
        const list = await this.fetchWithTimeout(url);

        if (!Array.isArray(list)) {
          throw new Error('Binance API geçersiz yanıt');
        }
        if (list.length === 0) break;

        let newestMs = 0;
        for (const row of list) {
          const tsMs = Number(row[0]);
          if (tsMs > newestMs) newestMs = tsMs;
          const tSec = Math.floor(tsMs / 1000);
          allMap.set(tSec, {
            time: tSec,
            open: parseFloat(row[1]),
            high: parseFloat(row[2]),
            low: parseFloat(row[3]),
            close: parseFloat(row[4]),
            volume: parseFloat(row[5] || 0),
          });
        }

        const pct = Math.min(99, Math.round((allMap.size / expectedTotal) * 100));
        if (onProgress) onProgress(`Binance Futures: ${allMap.size.toLocaleString('tr-TR')} / ~${expectedTotal.toLocaleString('tr-TR')} mum`, pct);

        if (list.length < 1500 || newestMs + tfMs >= endMs) break;
        cursorStart = newestMs + tfMs;

        if (page > 2) await sleep(80);
      }

      const candles = Array.from(allMap.values()).sort((a, b) => a.time - b.time);
      if (candles.length === 0) throw new Error('Binance boş veri döndürdü');
      return candles;
    },

    generateSyntheticCandles(symbol, timeframe, startMs, endMs) {
      const tfMs = TIMEFRAME_MS[timeframe] || 900000;
      const startPrices = {
        BTCUSDT: 68500,
        ETHUSDT: 3450,
        SOLUSDT: 168,
        BNBUSDT: 590,
      };
      let price = startPrices[symbol] || 100;
      // Deterministic PRNG seeded by symbol
      let seed = 1337;
      for (let i = 0; i < symbol.length; i++) seed = (seed * 31 + symbol.charCodeAt(i)) >>> 0;
      const rand = () => {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        return seed / 4294967296;
      };

      const candles = [];
      const alignedStart = Math.floor(startMs / tfMs) * tfMs;
      let regime = 0;
      const volScale = Math.sqrt(tfMs / 900000) * 0.0065;

      for (let ts = alignedStart; ts <= endMs; ts += tfMs) {
        if (rand() < 0.035) {
          regime = (rand() - 0.52) * 0.0035;
        }
        const z = (rand() + rand() + rand() - 1.5) * 1.15;
        const shock = rand() < 0.018 ? (rand() < 0.6 ? -0.022 : 0.02) : 0;
        const ret = regime + z * volScale + shock;

        const open = price;
        const close = Math.max(open * 0.5, open * (1 + ret));
        const highExtra = Math.abs(rand() * volScale * 1.15);
        const lowExtra = Math.abs(rand() * volScale * 1.25);
        const high = Math.max(open, close) * (1 + highExtra);
        const low = Math.max(0.0001, Math.min(open, close) * (1 - lowExtra));
        const volume = 50 + rand() * 450;

        candles.push({
          time: Math.floor(ts / 1000),
          open: Number(open.toFixed(4)),
          high: Number(high.toFixed(4)),
          low: Number(low.toFixed(4)),
          close: Number(close.toFixed(4)),
          volume: Number(volume.toFixed(2)),
        });
        price = close;
      }
      return candles;
    },

    async loadCandles({ symbol, timeframe, startMs, endMs, forceRefresh, onProgress }) {
      const cacheKey = `${symbol}_${timeframe}`;
      const tfSec = Math.floor(TIMEFRAME_MS[timeframe] / 1000);
      const startSec = Math.floor(startMs / 1000);
      const endSec = Math.floor(endMs / 1000);

      const cached = await CacheDB.get(cacheKey);
      if (!forceRefresh && cached && Array.isArray(cached.candles) && cached.candles.length > 0) {
        const tol = tfSec * 4;
        if (cached.startTime <= startSec + tol && cached.endTime >= endSec - tol) {
          const sliced = cached.candles.filter((c) => c.time >= startSec && c.time <= endSec);
          if (sliced.length >= 20) {
            return { candles: sliced, source: `Önbellek (${cached.source || 'Offline'})` };
          }
        }
      }

      // 1) Try Bybit V5 Public Linear Kline API
      let fetched = null;
      let source = '';
      try {
        if (onProgress) onProgress('Bybit V5 API bağlantısı kuruluyor...', 5);
        fetched = await this.fetchBybitKlines(symbol, timeframe, startMs, endMs, onProgress);
        source = 'Bybit V5 Canlı';
      } catch (bybitErr) {
        // 2) Fallback to Binance Futures Public API
        try {
          if (onProgress) onProgress('Bybit erişilemedi, Binance Futures deneniyor...', 10);
          fetched = await this.fetchBinanceKlines(symbol, timeframe, startMs, endMs, onProgress);
          source = 'Binance Futures Yedek';
        } catch (binanceErr) {
          // 3) Fallback to any existing IndexedDB cache
          if (cached && Array.isArray(cached.candles) && cached.candles.length >= 20) {
            showToast('Ağ erişimi yok: IndexedDB çevrimdışı önbellek yüklendi.', 'warning');
            return { candles: cached.candles, source: 'IndexedDB Çevrimdışı' };
          }
          // 4) Offline synthetic market data fallback so app always works offline
          const synthetic = this.generateSyntheticCandles(symbol, timeframe, startMs, endMs);
          showToast('API erişilemedi: Çevrimdışı sentetik piyasa verisi üretildi.', 'warning', 5000);
          return { candles: synthetic, source: 'Çevrimdışı Demo Veri' };
        }
      }

      // Save & merge into IndexedDB
      const merged = CacheDB.mergeCandles(cached ? cached.candles : [], fetched);
      await CacheDB.put({
        key: cacheKey,
        symbol,
        timeframe,
        source,
        updatedAt: Date.now(),
        startTime: merged[0].time,
        endTime: merged[merged.length - 1].time,
        candles: merged,
      });

      return { candles: fetched, source };
    },

    parseTimestamp(raw) {
      if (typeof raw === 'number') {
        return raw > 1e12 ? Math.floor(raw / 1000) : Math.floor(raw);
      }
      const str = String(raw).trim();
      if (/^\d+(\.\d+)?$/.test(str)) {
        const num = Number(str);
        return num > 1e12 ? Math.floor(num / 1000) : Math.floor(num);
      }
      const parsed = Date.parse(str);
      if (!Number.isNaN(parsed)) return Math.floor(parsed / 1000);
      return NaN;
    },

    async parseUploadedFile(file) {
      const text = await file.text();
      const name = file.name.toLowerCase();
      let rawRows = [];

      if (name.endsWith('.json')) {
        const json = JSON.parse(text);
        const arr = Array.isArray(json) ? json : (json.candles || json.data || json.list || []);
        if (!Array.isArray(arr) || arr.length === 0) {
          throw new Error('JSON dosyasında geçerli mum dizisi bulunamadı.');
        }
        for (const item of arr) {
          if (Array.isArray(item) && item.length >= 5) {
            rawRows.push({
              time: this.parseTimestamp(item[0]),
              open: parseFloat(item[1]),
              high: parseFloat(item[2]),
              low: parseFloat(item[3]),
              close: parseFloat(item[4]),
              volume: parseFloat(item[5] || 0),
            });
          } else if (item && typeof item === 'object') {
            rawRows.push({
              time: this.parseTimestamp(item.time ?? item.timestamp ?? item.openTime ?? item.date ?? item.t),
              open: parseFloat(item.open ?? item.o),
              high: parseFloat(item.high ?? item.h),
              low: parseFloat(item.low ?? item.l),
              close: parseFloat(item.close ?? item.c),
              volume: parseFloat(item.volume ?? item.v ?? 0),
            });
          }
        }
      } else {
        // CSV parser
        const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        if (lines.length < 2) throw new Error('CSV dosyası çok kısa.');
        const delim = lines[0].includes(';') ? ';' : lines[0].includes('\t') ? '\t' : ',';
        const firstCols = lines[0].split(delim).map((s) => s.trim().toLowerCase());
        const hasHeader = Number.isNaN(parseFloat(firstCols[1]));

        let idxTime = 0, idxOpen = 1, idxHigh = 2, idxLow = 3, idxClose = 4, idxVol = 5;
        if (hasHeader) {
          const findIdx = (keys, fallback) => {
            const i = firstCols.findIndex((c) => keys.some((k) => c.includes(k)));
            return i >= 0 ? i : fallback;
          };
          idxTime = findIdx(['time', 'date', 'timestamp'], 0);
          idxOpen = findIdx(['open'], 1);
          idxHigh = findIdx(['high'], 2);
          idxLow = findIdx(['low'], 3);
          idxClose = findIdx(['close'], 4);
          idxVol = findIdx(['vol'], 5);
        }

        for (let i = hasHeader ? 1 : 0; i < lines.length; i++) {
          const cols = lines[i].split(delim).map((s) => s.trim());
          if (cols.length < 5) continue;
          rawRows.push({
            time: this.parseTimestamp(cols[idxTime]),
            open: parseFloat(cols[idxOpen]),
            high: parseFloat(cols[idxHigh]),
            low: parseFloat(cols[idxLow]),
            close: parseFloat(cols[idxClose]),
            volume: parseFloat(cols[idxVol] || 0),
          });
        }
      }

      const map = new Map();
      for (const r of rawRows) {
        if (
          Number.isFinite(r.time) &&
          Number.isFinite(r.open) &&
          Number.isFinite(r.high) &&
          Number.isFinite(r.low) &&
          Number.isFinite(r.close) &&
          r.open > 0 && r.close > 0
        ) {
          map.set(r.time, r);
        }
      }
      const candles = Array.from(map.values()).sort((a, b) => a.time - b.time);
      if (candles.length < 10) {
        throw new Error('Yüklenen dosyada en az 10 geçerli mum satırı olmalıdır.');
      }
      return candles;
    },
  };

  /* ==================== STRATEJİ & BACKTEST MOTORU ==================== */
  const BacktestEngine = {
    calculateEMA(candles, period) {
      const n = candles.length;
      const ema = new Array(n).fill(null);
      if (n < period || period < 1) return ema;

      let sum = 0;
      for (let i = 0; i < period; i++) sum += candles[i].close;
      ema[period - 1] = sum / period;

      const k = 2 / (period + 1);
      for (let i = period; i < n; i++) {
        ema[i] = candles[i].close * k + ema[i - 1] * (1 - k);
      }
      return ema;
    },

    getStepMargin(params, stepIndex) {
      if (params.dcaMode === 'linear') {
        return params.baseMargin + stepIndex * params.linearStep;
      }
      return params.baseMargin * Math.pow(params.multiplier, stepIndex);
    },

    run(candles, params) {
      const ema = this.calculateEMA(candles, params.emaPeriod);
      const feeRate = params.feeRatePct / 100;
      const stepDrop = params.stepDropPct / 100;
      const leverage = params.leverage;

      let walletBalance = params.initialBalance;
      let peakEquity = params.initialBalance;
      let minEquity = params.initialBalance;
      let maxDrawdownPct = 0;
      let maxDrawdownUsd = 0;
      let maxMarginUsed = 0;
      let totalFeesPaid = 0;
      let totalAddsCount = 0;
      let tradeSeq = 0;
      let liquidatedEvent = null;

      let pos = null; // Active unified position
      const trades = [];
      const emaSeries = [];
      const avgEntrySeries = [];
      const nextAddSeries = [];
      const equitySeries = [];

      for (let i = 0; i < candles.length; i++) {
        const c = candles[i];
        const emaVal = ema[i];

        if (emaVal !== null) {
          emaSeries.push({ time: c.time, value: emaVal });
        }

        // If already liquidated earlier, record flat zero equity
        if (liquidatedEvent) {
          avgEntrySeries.push({ time: c.time });
          nextAddSeries.push({ time: c.time });
          equitySeries.push({ time: c.time, value: 0 });
          continue;
        }

        // 1) AÇIK POZİSYON VARSA: EKLEME -> LİKİDASYON -> EMA ÇIKIŞ
        if (pos) {
          // 1a) Ekleme tetikleme kontrolü (mum içinde low <= nextAddPrice)
          while (pos.addCount < params.maxAdds && c.low <= pos.nextAddPrice) {
            const nextMargin = this.getStepMargin(params, pos.addCount + 1);
            const nextNotional = nextMargin * leverage;
            const addFee = nextNotional * feeRate;
            const freeBalance = walletBalance - pos.totalMargin;

            if (freeBalance < nextMargin + addFee) {
              break; // Kasa yeni ekleme için yetersiz
            }

            const fillPrice = Math.min(c.open, pos.nextAddPrice);
            const addQty = nextNotional / fillPrice;
            const newQty = pos.qty + addQty;

            pos.avgEntryPrice = (pos.avgEntryPrice * pos.qty + fillPrice * addQty) / newQty;
            pos.qty = newQty;
            pos.totalMargin += nextMargin;
            pos.totalNotional += nextNotional;
            pos.fees += addFee;
            walletBalance -= addFee;
            totalFeesPaid += addFee;

            pos.lastEntryPrice = fillPrice;
            pos.addCount += 1;
            totalAddsCount += 1;
            pos.nextAddPrice = pos.lastEntryPrice * (1 - stepDrop);
            pos.adds.push({
              step: pos.addCount,
              time: c.time,
              price: fillPrice,
              margin: nextMargin,
              avgAfter: pos.avgEntryPrice,
            });

            if (pos.totalMargin > maxMarginUsed) {
              maxMarginUsed = pos.totalMargin;
            }
          }

          // 1b) Çapraz Kasa Likidasyon Kontrolü (mumun en düşük noktasında)
          const worstUnrealized = pos.qty * (c.low - pos.avgEntryPrice);
          const worstEquity = walletBalance + worstUnrealized;

          if (worstEquity < peakEquity) {
            const ddUsd = peakEquity - Math.max(0, worstEquity);
            const ddPct = peakEquity > 0 ? (ddUsd / peakEquity) * 100 : 0;
            if (ddPct > maxDrawdownPct) {
              maxDrawdownPct = ddPct;
              maxDrawdownUsd = ddUsd;
            }
          }
          if (worstEquity < minEquity) {
            minEquity = Math.max(0, worstEquity);
          }

          if (params.crossLiquidation && worstEquity <= 0) {
            const liqPrice = Math.max(0, pos.avgEntryPrice - walletBalance / pos.qty);
            const netPnl = -pos.preTradeBalance;
            const netPnlPct = -100;
            walletBalance = 0;

            const closedTrade = {
              id: pos.id,
              status: 'LIQUIDATED',
              entryTime: pos.entryTime,
              exitTime: c.time,
              initialEntryPrice: pos.initialEntryPrice,
              addCount: pos.addCount,
              adds: pos.adds,
              avgEntryPrice: pos.avgEntryPrice,
              totalMargin: pos.totalMargin,
              totalNotional: pos.totalNotional,
              exitPrice: liqPrice,
              fees: pos.fees,
              netPnl,
              netPnlPct,
              endBalance: 0,
            };
            trades.push(closedTrade);
            liquidatedEvent = closedTrade;
            pos = null;

            avgEntrySeries.push({ time: c.time, value: closedTrade.avgEntryPrice });
            nextAddSeries.push({ time: c.time });
            equitySeries.push({ time: c.time, value: 0 });
            maxDrawdownPct = 100;
            maxDrawdownUsd = peakEquity;
            minEquity = 0;
            continue;
          }

          // 1c) EMA Çıkış Kontrolü (mumun high değeri EMA'ya değdiğinde)
          const canExit =
            emaVal !== null &&
            c.high >= emaVal &&
            (!params.onlyExitAboveAvg || emaVal > pos.avgEntryPrice);

          if (canExit) {
            const exitPrice = emaVal;
            const grossPnl = pos.qty * (exitPrice - pos.avgEntryPrice);
            const exitNotional = pos.qty * exitPrice;
            const exitFee = exitNotional * feeRate;

            pos.fees += exitFee;
            totalFeesPaid += exitFee;
            walletBalance += grossPnl - exitFee;

            const netPnl = walletBalance - pos.preTradeBalance;
            const netPnlPct = pos.totalMargin > 0 ? (netPnl / pos.totalMargin) * 100 : 0;

            trades.push({
              id: pos.id,
              status: 'CLOSED',
              entryTime: pos.entryTime,
              exitTime: c.time,
              initialEntryPrice: pos.initialEntryPrice,
              addCount: pos.addCount,
              adds: pos.adds,
              avgEntryPrice: pos.avgEntryPrice,
              totalMargin: pos.totalMargin,
              totalNotional: pos.totalNotional,
              exitPrice,
              fees: pos.fees,
              netPnl,
              netPnlPct,
              endBalance: walletBalance,
            });

            avgEntrySeries.push({ time: c.time, value: pos.avgEntryPrice });
            nextAddSeries.push({ time: c.time });
            pos = null;

            if (walletBalance > peakEquity) peakEquity = walletBalance;
            if (walletBalance < minEquity) minEquity = walletBalance;
            equitySeries.push({ time: c.time, value: walletBalance });
            continue;
          }

          // Pozisyon hala açık: çizgileri ve anlık özsermayeyi kaydet
          avgEntrySeries.push({ time: c.time, value: pos.avgEntryPrice });
          if (pos.addCount < params.maxAdds) {
            nextAddSeries.push({ time: c.time, value: pos.nextAddPrice });
          } else {
            nextAddSeries.push({ time: c.time });
          }

          const markEquity = Math.max(0, walletBalance + pos.qty * (c.close - pos.avgEntryPrice));
          if (markEquity > peakEquity) peakEquity = markEquity;
          if (markEquity < minEquity) minEquity = markEquity;
          equitySeries.push({ time: c.time, value: markEquity });
          continue;
        }

        // 2) AÇIK POZİSYON YOKSA: İLK ALIM KOŞULU (kapanış < EMA)
        if (emaVal !== null && c.close < emaVal) {
          const m0 = params.baseMargin;
          const n0 = m0 * leverage;
          const fee0 = n0 * feeRate;

          if (walletBalance >= m0 + fee0) {
            tradeSeq += 1;
            const preTradeBalance = walletBalance;
            const entryPrice = c.close;
            const qty = n0 / entryPrice;

            walletBalance -= fee0;
            totalFeesPaid += fee0;

            pos = {
              id: tradeSeq,
              entryTime: c.time,
              initialEntryPrice: entryPrice,
              lastEntryPrice: entryPrice,
              avgEntryPrice: entryPrice,
              qty,
              totalMargin: m0,
              totalNotional: n0,
              fees: fee0,
              addCount: 0,
              adds: [],
              nextAddPrice: entryPrice * (1 - stepDrop),
              preTradeBalance,
            };

            if (pos.totalMargin > maxMarginUsed) {
              maxMarginUsed = pos.totalMargin;
            }

            avgEntrySeries.push({ time: c.time, value: pos.avgEntryPrice });
            if (params.maxAdds > 0) {
              nextAddSeries.push({ time: c.time, value: pos.nextAddPrice });
            } else {
              nextAddSeries.push({ time: c.time });
            }
            equitySeries.push({ time: c.time, value: walletBalance });
            continue;
          }
        }

        // Pozisyon yok
        avgEntrySeries.push({ time: c.time });
        nextAddSeries.push({ time: c.time });
        equitySeries.push({ time: c.time, value: walletBalance });
      }

      // Veri sonunda hala açık pozisyon varsa listeye AÇIK olarak ekle
      if (pos && candles.length > 0) {
        const lastCandle = candles[candles.length - 1];
        const floatingGross = pos.qty * (lastCandle.close - pos.avgEntryPrice);
        const floatingNet = floatingGross - pos.fees;
        const floatingPct = pos.totalMargin > 0 ? (floatingNet / pos.totalMargin) * 100 : 0;
        const markBal = Math.max(0, walletBalance + floatingGross);

        trades.push({
          id: pos.id,
          status: 'OPEN',
          entryTime: pos.entryTime,
          exitTime: null,
          initialEntryPrice: pos.initialEntryPrice,
          addCount: pos.addCount,
          adds: pos.adds,
          avgEntryPrice: pos.avgEntryPrice,
          totalMargin: pos.totalMargin,
          totalNotional: pos.totalNotional,
          exitPrice: lastCandle.close,
          fees: pos.fees,
          netPnl: floatingNet,
          netPnlPct: floatingPct,
          endBalance: markBal,
        });
      }

      // Birleşik Grafik Etiketleri (Markers)
      const markers = [];
      for (const t of trades) {
        const addSuffix = t.addCount > 0 ? ` (+${t.addCount} Ekleme)` : '';
        markers.push({
          time: t.entryTime,
          position: 'belowBar',
          color: '#00E676',
          shape: 'arrowUp',
          text: `#${t.id} AL $${t.totalMargin.toFixed(2)}${addSuffix}`,
        });

        if (t.status === 'CLOSED' && t.exitTime) {
          markers.push({
            time: t.exitTime,
            position: 'aboveBar',
            color: t.netPnl >= 0 ? '#00E676' : '#FF5252',
            shape: 'arrowDown',
            text: `#${t.id} SAT ${fmtSignedUsd(t.netPnl)}`,
          });
        } else if (t.status === 'LIQUIDATED' && t.exitTime) {
          markers.push({
            time: t.exitTime,
            position: 'aboveBar',
            color: '#FF5252',
            shape: 'circle',
            text: `#${t.id} LİKİDE ${fmtSignedUsd(t.netPnl)}`,
          });
        }
      }
      markers.sort((a, b) => a.time - b.time);

      // KPI Hesaplamaları
      const closedTrades = trades.filter((t) => t.status === 'CLOSED' || t.status === 'LIQUIDATED');
      const wins = closedTrades.filter((t) => t.netPnl > 0).length;
      const losses = closedTrades.length - wins;
      const winRate = closedTrades.length > 0 ? (wins / closedTrades.length) * 100 : 0;

      const finalEquity = equitySeries.length > 0 ? equitySeries[equitySeries.length - 1].value : params.initialBalance;
      const netPnl = finalEquity - params.initialBalance;
      const roiPct = params.initialBalance > 0 ? (netPnl / params.initialBalance) * 100 : 0;

      return {
        trades,
        markers,
        emaSeries,
        avgEntrySeries,
        nextAddSeries,
        equitySeries,
        liquidatedEvent,
        stats: {
          initialBalance: params.initialBalance,
          finalBalance: finalEquity,
          realizedBalance: walletBalance,
          netPnl,
          roiPct,
          totalFeesPaid,
          winRate,
          wins,
          losses,
          totalTrades: trades.length,
          closedTrades: closedTrades.length,
          totalAddsCount,
          maxDrawdownPct,
          maxDrawdownUsd,
          maxMarginUsed,
          maxMarginRatio: params.initialBalance > 0 ? (maxMarginUsed / params.initialBalance) * 100 : 0,
          peakEquity,
          minEquity,
        },
      };
    },

    computeLadder(params, refPrice) {
      const rows = [];
      const feeRate = params.feeRatePct / 100;
      const stepDrop = params.stepDropPct / 100;
      const leverage = params.leverage;

      let currentPrice = refPrice > 0 ? refPrice : 65000;
      let cumMargin = 0;
      let cumNotional = 0;
      let cumQty = 0;
      let cumFees = 0;

      for (let step = 0; step <= params.maxAdds; step++) {
        if (step > 0) {
          currentPrice = currentPrice * (1 - stepDrop);
        }
        const dropFromStartPct = ((currentPrice - refPrice) / refPrice) * 100;
        const stepMargin = this.getStepMargin(params, step);
        const stepNotional = stepMargin * leverage;
        const stepFee = stepNotional * feeRate;
        const stepQty = stepNotional / currentPrice;

        cumMargin += stepMargin;
        cumNotional += stepNotional;
        cumQty += stepQty;
        cumFees += stepFee;

        const avgEntry = cumNotional / cumQty;
        const bounceToBreakEvenPct = ((avgEntry - currentPrice) / currentPrice) * 100;
        const freeBalance = params.initialBalance - cumMargin - cumFees;
        const availableWallet = Math.max(0, params.initialBalance - cumFees);
        const liqPrice = Math.max(0, avgEntry - availableWallet / cumQty);

        let status = 'SAFE';
        let statusLabel = 'Güvenli';
        if (freeBalance < 0) {
          status = 'INSUFFICIENT';
          statusLabel = 'Yetersiz Kasa';
        } else if (liqPrice >= currentPrice) {
          status = 'LIQ';
          statusLabel = 'Likidasyon Riski';
        } else if (cumMargin / params.initialBalance > 0.5) {
          status = 'WARN';
          statusLabel = 'Yüksek Teminat';
        }

        rows.push({
          step,
          label: step === 0 ? 'İlk Alım' : `+${step}. Ekleme`,
          dropFromStartPct,
          entryPrice: currentPrice,
          stepMargin,
          cumMargin,
          cumNotional,
          avgEntry,
          bounceToBreakEvenPct,
          liqPrice,
          freeBalance,
          status,
          statusLabel,
        });
      }
      return rows;
    },
  };

  /* ==================== GRAFİK YÖNETİCİSİ (LIGHTWEIGHT CHARTS V4) ==================== */
  const ChartManager = {
    mainChart: null,
    candleSeries: null,
    emaSeries: null,
    avgSeries: null,
    nextAddSeries: null,

    equityChart: null,
    equitySeries: null,

    lastCandles: [],
    lastResult: null,
    hasLwc: typeof window.LightweightCharts !== 'undefined',

    initMainChart(container) {
      this.hasLwc = typeof window.LightweightCharts !== 'undefined';
      if (!this.hasLwc) {
        container.innerHTML = '<canvas id="fallbackMainCanvas" style="width:100%;height:100%;display:block;"></canvas>';
        return;
      }

      if (this.mainChart) {
        this.mainChart.remove();
        this.mainChart = null;
      }
      container.innerHTML = '';

      const LWC = window.LightweightCharts;
      this.mainChart = LWC.createChart(container, {
        width: container.clientWidth,
        height: container.clientHeight,
        layout: {
          background: { type: LWC.ColorType.Solid, color: '#000000' },
          textColor: '#98A4B8',
          fontFamily: "'JetBrains Mono', 'Roboto Mono', monospace",
          fontSize: 12,
        },
        grid: {
          vertLines: { color: '#10151E' },
          horzLines: { color: '#10151E' },
        },
        crosshair: {
          mode: LWC.CrosshairMode.Normal,
          vertLine: { color: '#39465B', width: 1, style: LWC.LineStyle.Dashed },
          horzLine: { color: '#39465B', width: 1, style: LWC.LineStyle.Dashed },
        },
        rightPriceScale: {
          borderColor: '#1C222D',
          scaleMargins: { top: 0.08, bottom: 0.12 },
        },
        timeScale: {
          borderColor: '#1C222D',
          timeVisible: true,
          secondsVisible: false,
          rightOffset: 8,
        },
      });

      this.candleSeries = this.mainChart.addCandlestickSeries({
        upColor: '#00E676',
        downColor: '#FF5252',
        borderUpColor: '#00E676',
        borderDownColor: '#FF5252',
        wickUpColor: '#00E676',
        wickDownColor: '#FF5252',
      });

      this.emaSeries = this.mainChart.addLineSeries({
        color: '#FF9800',
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: true,
        title: 'EMA',
      });

      this.avgSeries = this.mainChart.addLineSeries({
        color: '#00E676',
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: true,
        title: 'Ort. Giriş',
      });

      this.nextAddSeries = this.mainChart.addLineSeries({
        color: '#FF5252',
        lineWidth: 1,
        lineStyle: LWC.LineStyle.Dashed,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
        title: 'Sonraki Ekleme',
      });

      // Crosshair Legend senkronizasyonu
      this.mainChart.subscribeCrosshairMove((param) => {
        const ohlcEl = document.getElementById('legendOhlc');
        const emaEl = document.getElementById('legendEmaVal');
        const avgEl = document.getElementById('legendAvgVal');
        const nextEl = document.getElementById('legendNextVal');
        if (!param || !param.time) return;

        const cData = param.seriesData.get(this.candleSeries);
        const eData = param.seriesData.get(this.emaSeries);
        const aData = param.seriesData.get(this.avgSeries);
        const nData = param.seriesData.get(this.nextAddSeries);

        if (cData && ohlcEl) {
          ohlcEl.textContent = `O: ${fmtPrice(cData.open)}  H: ${fmtPrice(cData.high)}  L: ${fmtPrice(cData.low)}  C: ${fmtPrice(cData.close)}`;
        }
        if (emaEl) emaEl.textContent = eData && eData.value !== undefined ? fmtPrice(eData.value) : '—';
        if (avgEl) avgEl.textContent = aData && aData.value !== undefined ? fmtPrice(aData.value) : '—';
        if (nextEl) nextEl.textContent = nData && nData.value !== undefined ? fmtPrice(nData.value) : '—';
      });

      const ro = new ResizeObserver(() => {
        if (this.mainChart && container.clientWidth > 0 && container.clientHeight > 0) {
          this.mainChart.applyOptions({
            width: container.clientWidth,
            height: container.clientHeight,
          });
        }
      });
      ro.observe(container);
    },

    initEquityChart(container) {
      this.hasLwc = typeof window.LightweightCharts !== 'undefined';
      if (!this.hasLwc) {
        container.innerHTML = '<canvas id="fallbackEquityCanvas" style="width:100%;height:100%;display:block;"></canvas>';
        return;
      }

      if (this.equityChart) {
        this.equityChart.remove();
        this.equityChart = null;
      }
      container.innerHTML = '';

      const LWC = window.LightweightCharts;
      this.equityChart = LWC.createChart(container, {
        width: container.clientWidth || 800,
        height: container.clientHeight || 220,
        layout: {
          background: { type: LWC.ColorType.Solid, color: '#000000' },
          textColor: '#98A4B8',
          fontFamily: "'JetBrains Mono', 'Roboto Mono', monospace",
          fontSize: 12,
        },
        grid: {
          vertLines: { color: '#10151E' },
          horzLines: { color: '#10151E' },
        },
        rightPriceScale: {
          borderColor: '#1C222D',
        },
        timeScale: {
          borderColor: '#1C222D',
          timeVisible: true,
          secondsVisible: false,
        },
      });

      this.equitySeries = this.equityChart.addAreaSeries({
        lineColor: '#00E676',
        topColor: 'rgba(0, 230, 118, 0.28)',
        bottomColor: 'rgba(0, 230, 118, 0.01)',
        lineWidth: 2,
      });

      const ro = new ResizeObserver(() => {
        if (this.equityChart && container.clientWidth > 0 && container.clientHeight > 0) {
          this.equityChart.applyOptions({
            width: container.clientWidth,
            height: container.clientHeight,
          });
        }
      });
      ro.observe(container);
    },

    render(candles, result, params) {
      this.lastCandles = candles;
      this.lastResult = result;

      const last = candles[candles.length - 1];
      if (last) {
        document.getElementById('legendOhlc').textContent =
          `O: ${fmtPrice(last.open)}  H: ${fmtPrice(last.high)}  L: ${fmtPrice(last.low)}  C: ${fmtPrice(last.close)}`;
      }
      const lastEma = result.emaSeries[result.emaSeries.length - 1];
      document.getElementById('legendEmaLabel').textContent = `EMA ${params.emaPeriod}:`;
      document.getElementById('legendEmaVal').textContent = lastEma ? fmtPrice(lastEma.value) : '—';

      if (!this.hasLwc) {
        this.renderFallbackCanvas(candles, result);
        return;
      }

      if (!this.mainChart) this.initMainChart(document.getElementById('mainChartContainer'));
      if (!this.equityChart) this.initEquityChart(document.getElementById('equityChartContainer'));

      // Price precision
      const ref = last ? last.close : 100;
      let precision = 2, minMove = 0.01;
      if (ref < 0.01) { precision = 6; minMove = 0.000001; }
      else if (ref < 1) { precision = 5; minMove = 0.00001; }
      else if (ref < 10) { precision = 4; minMove = 0.0001; }
      else if (ref < 100) { precision = 3; minMove = 0.001; }

      this.candleSeries.applyOptions({ priceFormat: { type: 'price', precision, minMove } });
      this.emaSeries.applyOptions({ title: `EMA ${params.emaPeriod}`, priceFormat: { type: 'price', precision, minMove } });
      this.avgSeries.applyOptions({ priceFormat: { type: 'price', precision, minMove } });
      this.nextAddSeries.applyOptions({ priceFormat: { type: 'price', precision, minMove } });

      this.candleSeries.setData(candles);
      this.emaSeries.setData(result.emaSeries);
      this.avgSeries.setData(result.avgEntrySeries);
      this.nextAddSeries.setData(result.nextAddSeries);
      this.candleSeries.setMarkers(result.markers);
      this.mainChart.timeScale().fitContent();

      // Equity Curve
      const isProfit = result.stats.netPnl >= 0;
      this.equitySeries.applyOptions({
        lineColor: isProfit ? '#00E676' : '#FF5252',
        topColor: isProfit ? 'rgba(0, 230, 118, 0.28)' : 'rgba(255, 82, 82, 0.25)',
        bottomColor: isProfit ? 'rgba(0, 230, 118, 0.01)' : 'rgba(255, 82, 82, 0.01)',
      });
      this.equitySeries.setData(result.equitySeries);
      this.equityChart.timeScale().fitContent();
    },

    focusTrade(trade, timeframe) {
      if (!this.hasLwc || !this.mainChart || !this.lastCandles.length) return;
      const tfSec = Math.floor((TIMEFRAME_MS[timeframe] || 900000) / 1000);
      const endSec = trade.exitTime || this.lastCandles[this.lastCandles.length - 1].time;
      const span = Math.max(endSec - trade.entryTime, tfSec * 12);
      const pad = Math.max(tfSec * 18, Math.floor(span * 0.45));

      const firstTime = this.lastCandles[0].time;
      const lastTime = this.lastCandles[this.lastCandles.length - 1].time;
      const from = Math.max(firstTime, trade.entryTime - pad);
      const to = Math.min(lastTime, endSec + pad);

      if (to > from) {
        this.mainChart.timeScale().setVisibleRange({ from, to });
      }
    },

    resetZoom() {
      if (this.hasLwc && this.mainChart) {
        this.mainChart.timeScale().fitContent();
      }
    },

    resizeEquity() {
      const container = document.getElementById('equityChartContainer');
      if (this.hasLwc && this.equityChart && container && container.clientWidth > 0 && container.clientHeight > 0) {
        this.equityChart.applyOptions({
          width: container.clientWidth,
          height: container.clientHeight,
        });
        this.equityChart.timeScale().fitContent();
      }
    },

    // Offline Canvas Fallback (CDN yüklenemediğinde bile grafik çalışır)
    renderFallbackCanvas(candles, result) {
      const canvas = document.getElementById('fallbackMainCanvas');
      if (!canvas || !candles.length) return;
      const rect = canvas.parentElement.getBoundingClientRect();
      canvas.width = rect.width || 900;
      canvas.height = rect.height || 360;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      const slice = candles.slice(-240);
      let minP = Infinity, maxP = -Infinity;
      for (const c of slice) {
        if (c.low < minP) minP = c.low;
        if (c.high > maxP) maxP = c.high;
      }
      const pad = (maxP - minP) * 0.08 || 1;
      minP -= pad;
      maxP += pad;

      const xStep = (canvas.width - 70) / slice.length;
      const yOf = (p) => canvas.height - 24 - ((p - minP) / (maxP - minP)) * (canvas.height - 44);

      slice.forEach((c, idx) => {
        const x = 10 + idx * xStep;
        const isUp = c.close >= c.open;
        ctx.strokeStyle = isUp ? '#00E676' : '#FF5252';
        ctx.fillStyle = isUp ? '#00E676' : '#FF5252';
        ctx.beginPath();
        ctx.moveTo(x + xStep * 0.4, yOf(c.high));
        ctx.lineTo(x + xStep * 0.4, yOf(c.low));
        ctx.stroke();

        const top = yOf(Math.max(c.open, c.close));
        const bot = yOf(Math.min(c.open, c.close));
        ctx.fillRect(x + 1, top, Math.max(2, xStep * 0.75), Math.max(1, bot - top));
      });

      // EMA line
      const emaMap = new Map(result.emaSeries.map((e) => [e.time, e.value]));
      ctx.strokeStyle = '#FF9800';
      ctx.lineWidth = 2;
      ctx.beginPath();
      let started = false;
      slice.forEach((c, idx) => {
        const v = emaMap.get(c.time);
        if (v !== undefined) {
          const x = 10 + idx * xStep + xStep * 0.4;
          const y = yOf(v);
          if (!started) { ctx.moveTo(x, y); started = true; }
          else ctx.lineTo(x, y);
        }
      });
      ctx.stroke();
    },
  };

  /* ==================== UYGULAMA DURUMU & UI KONTROLÜ ==================== */
  const App = {
    state: {
      candles: [],
      result: null,
      selectedTradeId: null,
      customLoadedName: null,
      isRunning: false,
    },

    el: {},

    init() {
      this.cacheElements();
      this.initDates();
      this.restoreSettings();
      this.bindEvents();
      this.updateNetworkBadge();
      this.refreshCacheBadge();
      this.syncDcaModeUI();
      this.renderLadderTable();

      ChartManager.initMainChart(this.el.mainChartContainer);
      ChartManager.initEquityChart(this.el.equityChartContainer);

      // Açılışta varsayılan simülasyonu otomatik çalıştır
      this.runSimulation();
    },

    cacheElements() {
      const ids = [
        'networkStatusBadge', 'cacheCountBadge', 'btnClearCache',
        'symbolSelect', 'timeframeSelect', 'customSymbolWrap', 'customSymbolInput',
        'datePresetSelect', 'customDateWrap', 'startDateInput', 'endDateInput', 'forceRefreshCheck',
        'initialBalanceInput', 'baseMarginInput', 'leverageInput', 'feeRateInput',
        'emaPeriodInput', 'stepDropInput', 'dcaModeSelect', 'multiplierGroup', 'multiplierInput',
        'linearStepGroup', 'linearStepInput', 'maxAddsInput',
        'toggleExitAboveAvg', 'toggleCrossLiq',
        'fetchProgressWrap', 'fetchProgressText', 'fetchProgressPct', 'fetchProgressFill',
        'btnRunSimulation', 'fileUploadInput', 'btnExportCsv',
        'kpiBalance', 'kpiBalanceSub', 'kpiNetPnl', 'kpiNetPnlSub',
        'kpiWinRate', 'kpiWinRateSub', 'kpiTotalTrades', 'kpiTotalTradesSub',
        'kpiMaxDd', 'kpiMaxDdSub', 'kpiMaxMargin', 'kpiMaxMarginSub',
        'chartSymbolLabel', 'chartTfLabel', 'chartSourceBadge', 'chartCandleCount',
        'selectedTradePill', 'btnResetZoom', 'liquidationAlertBar', 'liqAlertText',
        'mainChartContainer', 'equityChartContainer',
        'tabTradesCount', 'tabHintText', 'thMarginVol', 'thEmaExit', 'tradesTableBody',
        'eqStartVal', 'eqPeakVal', 'eqLowVal', 'eqEndVal', 'eqRoiVal',
        'ladderRefPriceInput', 'ladderSummaryBadge', 'ladderTableBody',
      ];
      for (const id of ids) this.el[id] = document.getElementById(id);
    },

    initDates() {
      const now = new Date();
      const start = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      this.el.endDateInput.value = toDateInputValue(now);
      this.el.startDateInput.value = toDateInputValue(start);
    },

    getParams() {
      const symbolRaw = this.el.symbolSelect.value === 'CUSTOM'
        ? this.el.customSymbolInput.value.trim().toUpperCase()
        : this.el.symbolSelect.value;
      const symbol = symbolRaw || 'BTCUSDT';
      const timeframe = this.el.timeframeSelect.value;
      const datePreset = this.el.datePresetSelect.value;

      const nowMs = Date.now();
      let startMs = nowMs - 30 * 24 * 60 * 60 * 1000;
      let endMs = nowMs;

      if (datePreset === '7d') {
        startMs = nowMs - 7 * 24 * 60 * 60 * 1000;
      } else if (datePreset === '30d') {
        startMs = nowMs - 30 * 24 * 60 * 60 * 1000;
      } else if (datePreset === '90d') {
        startMs = nowMs - 90 * 24 * 60 * 60 * 1000;
      } else if (datePreset === 'custom') {
        const s = Date.parse(this.el.startDateInput.value + 'T00:00:00Z');
        const e = Date.parse(this.el.endDateInput.value + 'T23:59:59Z');
        if (!Number.isNaN(s) && !Number.isNaN(e) && e > s) {
          startMs = s;
          endMs = Math.min(nowMs, e);
        }
      }

      return {
        symbol,
        timeframe,
        datePreset,
        startMs,
        endMs,
        forceRefresh: this.el.forceRefreshCheck.checked,
        initialBalance: Math.max(1, parseFloat(this.el.initialBalanceInput.value) || 200),
        baseMargin: Math.max(0.01, parseFloat(this.el.baseMarginInput.value) || 0.5),
        leverage: Math.min(100, Math.max(1, parseFloat(this.el.leverageInput.value) || 10)),
        feeRatePct: Math.max(0, parseFloat(this.el.feeRateInput.value) || 0.05),
        emaPeriod: Math.min(500, Math.max(2, parseInt(this.el.emaPeriodInput.value, 10) || 50)),
        stepDropPct: Math.max(0.1, parseFloat(this.el.stepDropInput.value) || 1.5),
        dcaMode: this.el.dcaModeSelect.value,
        multiplier: Math.max(1, parseFloat(this.el.multiplierInput.value) || 2.0),
        linearStep: Math.max(0.01, parseFloat(this.el.linearStepInput.value) || 0.5),
        maxAdds: Math.min(20, Math.max(0, parseInt(this.el.maxAddsInput.value, 10) || 7)),
        onlyExitAboveAvg: this.el.toggleExitAboveAvg.checked,
        crossLiquidation: this.el.toggleCrossLiq.checked,
      };
    },

    saveSettings() {
      try {
        const data = {
          symbolSelect: this.el.symbolSelect.value,
          customSymbolInput: this.el.customSymbolInput.value,
          timeframeSelect: this.el.timeframeSelect.value,
          datePresetSelect: this.el.datePresetSelect.value,
          initialBalanceInput: this.el.initialBalanceInput.value,
          baseMarginInput: this.el.baseMarginInput.value,
          leverageInput: this.el.leverageInput.value,
          feeRateInput: this.el.feeRateInput.value,
          emaPeriodInput: this.el.emaPeriodInput.value,
          stepDropInput: this.el.stepDropInput.value,
          dcaModeSelect: this.el.dcaModeSelect.value,
          multiplierInput: this.el.multiplierInput.value,
          linearStepInput: this.el.linearStepInput.value,
          maxAddsInput: this.el.maxAddsInput.value,
          toggleExitAboveAvg: this.el.toggleExitAboveAvg.checked,
          toggleCrossLiq: this.el.toggleCrossLiq.checked,
        };
        localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(data));
      } catch (_) {}
    },

    restoreSettings() {
      try {
        const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
        if (!raw) return;
        const data = JSON.parse(raw);
        for (const [k, v] of Object.entries(data)) {
          if (!this.el[k]) continue;
          if (this.el[k].type === 'checkbox') this.el[k].checked = Boolean(v);
          else this.el[k].value = v;
        }
        this.el.customSymbolWrap.classList.toggle('hidden', this.el.symbolSelect.value !== 'CUSTOM');
        this.el.customDateWrap.classList.toggle('hidden', this.el.datePresetSelect.value !== 'custom');
      } catch (_) {}
    },

    syncDcaModeUI() {
      const isLinear = this.el.dcaModeSelect.value === 'linear';
      this.el.multiplierGroup.classList.toggle('hidden', isLinear);
      this.el.linearStepGroup.classList.toggle('hidden', !isLinear);
    },

    bindEvents() {
      window.addEventListener('online', () => this.updateNetworkBadge());
      window.addEventListener('offline', () => this.updateNetworkBadge());

      this.el.symbolSelect.addEventListener('change', () => {
        this.el.customSymbolWrap.classList.toggle('hidden', this.el.symbolSelect.value !== 'CUSTOM');
        this.state.customLoadedName = null;
        this.saveSettings();
      });

      this.el.datePresetSelect.addEventListener('change', () => {
        this.el.customDateWrap.classList.toggle('hidden', this.el.datePresetSelect.value !== 'custom');
        this.saveSettings();
      });

      this.el.dcaModeSelect.addEventListener('change', () => {
        this.syncDcaModeUI();
        this.saveSettings();
        this.renderLadderTable();
      });

      // Strateji girdileri değiştikçe Kademe & Likidasyon tablosunu anlık güncelle
      const liveInputs = [
        'initialBalanceInput', 'baseMarginInput', 'leverageInput', 'feeRateInput',
        'emaPeriodInput', 'stepDropInput', 'multiplierInput', 'linearStepInput',
        'maxAddsInput', 'ladderRefPriceInput',
      ];
      for (const id of liveInputs) {
        this.el[id].addEventListener('input', () => {
          this.saveSettings();
          this.renderLadderTable();
        });
      }

      ['timeframeSelect', 'customSymbolInput', 'toggleExitAboveAvg', 'toggleCrossLiq'].forEach((id) => {
        this.el[id].addEventListener('change', () => {
          this.saveSettings();
          if (id === 'timeframeSelect' || id === 'customSymbolInput') {
            this.state.customLoadedName = null;
          }
        });
      });

      this.el.btnRunSimulation.addEventListener('click', () => this.runSimulation());
      this.el.btnExportCsv.addEventListener('click', () => this.exportTradesCsv());

      this.el.btnResetZoom.addEventListener('click', () => {
        this.state.selectedTradeId = null;
        this.el.selectedTradePill.classList.add('hidden');
        document.querySelectorAll('#tradesTableBody tr.selected-row').forEach((r) => r.classList.remove('selected-row'));
        ChartManager.resetZoom();
      });

      this.el.btnClearCache.addEventListener('click', async () => {
        await CacheDB.clear();
        await this.refreshCacheBadge();
        showToast('IndexedDB çevrimdışı mum önbelleği temizlendi.', 'info');
      });

      // CSV / JSON Dosya Yükleme
      this.el.fileUploadInput.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        try {
          const candles = await DataEngine.parseUploadedFile(file);
          this.state.candles = candles;
          this.state.customLoadedName = file.name;
          const params = this.getParams();

          // IndexedDB'ye de kaydet
          await CacheDB.put({
            key: `FILE_${file.name}`,
            symbol: params.symbol,
            timeframe: params.timeframe,
            source: `Dosya: ${file.name}`,
            updatedAt: Date.now(),
            startTime: candles[0].time,
            endTime: candles[candles.length - 1].time,
            candles,
          });
          await this.refreshCacheBadge();

          this.executeBacktestAndRender(candles, `Dosya: ${file.name}`, params);
          showToast(`${file.name} yüklendi (${candles.length.toLocaleString('tr-TR')} mum).`, 'success');
        } catch (err) {
          showToast(`Dosya okuma hatası: ${err.message}`, 'error', 5000);
        } finally {
          e.target.value = '';
        }
      });

      // Sekme geçişleri
      document.querySelectorAll('.tab-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          const target = btn.dataset.tab;
          document.querySelectorAll('.tab-btn').forEach((b) => {
            b.classList.toggle('active', b === btn);
            b.setAttribute('aria-selected', b === btn ? 'true' : 'false');
          });
          document.querySelectorAll('.tab-content').forEach((c) => {
            c.classList.toggle('active', c.id === `tab-${target}`);
          });

          if (target === 'equity') {
            this.el.tabHintText.textContent = 'Zaman içinde anlık özsermaye (bakiye + gerçekleşmemiş K/Z) gelişimi';
            requestAnimationFrame(() => ChartManager.resizeEquity());
          } else if (target === 'ladder') {
            this.el.tabHintText.textContent = 'Sol paneldeki ayarlar değiştikçe kademeler anlık güncellenir';
            this.renderLadderTable();
          } else {
            this.el.tabHintText.textContent = 'Grafikte odaklanmak için herhangi bir işlem satırına tıklayın';
          }
        });
      });
    },

    updateNetworkBadge() {
      const online = navigator.onLine;
      this.el.networkStatusBadge.textContent = online ? '● Çevrimiçi' : '● Çevrimdışı';
      this.el.networkStatusBadge.className = `pill ${online ? 'pill-online' : 'pill-offline'}`;
    },

    async refreshCacheBadge() {
      const count = await CacheDB.count();
      this.el.cacheCountBadge.textContent = `Önbellek: ${count}`;
    },

    setProgress(visible, text = '', pct = 0) {
      this.el.fetchProgressWrap.classList.toggle('hidden', !visible);
      if (visible) {
        this.el.fetchProgressText.textContent = text;
        this.el.fetchProgressPct.textContent = `${pct}%`;
        this.el.fetchProgressFill.style.width = `${pct}%`;
      }
    },

    async runSimulation() {
      if (this.state.isRunning) return;
      this.state.isRunning = true;
      this.el.btnRunSimulation.disabled = true;

      const params = this.getParams();
      this.saveSettings();

      try {
        // Kullanıcı özel dosya yüklediyse ve pariteyi değiştirmediyse o veri üzerinde yeniden test et
        if (this.state.customLoadedName && this.state.candles.length > 0 && !params.forceRefresh) {
          this.executeBacktestAndRender(this.state.candles, `Dosya: ${this.state.customLoadedName}`, params);
          showToast('Simülasyon yüklü dosya üzerinde güncellendi.', 'success');
          return;
        }

        this.setProgress(true, 'Geçmiş mum verisi hazırlanıyor...', 5);
        const { candles, source } = await DataEngine.loadCandles({
          symbol: params.symbol,
          timeframe: params.timeframe,
          startMs: params.startMs,
          endMs: params.endMs,
          forceRefresh: params.forceRefresh,
          onProgress: (msg, pct) => this.setProgress(true, msg, pct),
        });

        this.setProgress(true, 'Backtest motoru hesaplıyor...', 98);
        this.state.candles = candles;
        await this.refreshCacheBadge();

        this.executeBacktestAndRender(candles, source, params);
        this.setProgress(true, 'Tamamlandı', 100);
        setTimeout(() => this.setProgress(false), 450);

        showToast(`${params.symbol} (${params.timeframe}) — ${candles.length.toLocaleString('tr-TR')} mum analiz edildi.`, 'success');
      } catch (err) {
        this.setProgress(false);
        showToast(`Simülasyon hatası: ${err.message}`, 'error', 5000);
      } finally {
        this.state.isRunning = false;
        this.el.btnRunSimulation.disabled = false;
      }
    },

    executeBacktestAndRender(candles, source, params) {
      const result = BacktestEngine.run(candles, params);
      this.state.result = result;
      this.state.selectedTradeId = null;

      // Update reference price in Ladder tab with latest close
      const lastClose = candles[candles.length - 1]?.close;
      if (lastClose) {
        this.el.ladderRefPriceInput.value = Number(lastClose.toFixed(lastClose < 10 ? 4 : 2));
      }

      // Header labels
      this.el.chartSymbolLabel.textContent = params.symbol;
      this.el.chartTfLabel.textContent = params.timeframe;
      this.el.chartSourceBadge.textContent = source;
      this.el.chartCandleCount.textContent = `${candles.length.toLocaleString('tr-TR')} mum`;
      this.el.selectedTradePill.classList.add('hidden');

      this.el.thMarginVol.textContent = `Toplam Teminat / Hacim (${params.leverage}x)`;
      this.el.thEmaExit.textContent = `EMA ${params.emaPeriod} Çıkış`;

      // Liquidation alert bar
      if (result.liquidatedEvent) {
        const liq = result.liquidatedEvent;
        this.el.liqAlertText.textContent =
          `#${liq.id} numaralı işlem ${fmtDateTime(liq.exitTime)} mumunda ${fmtPrice(liq.exitPrice)} seviyesinde çapraz kasa likidasyonuna uğradı (Toplam ${liq.addCount} ekleme, Ort. Giriş: ${fmtPrice(liq.avgEntryPrice)}).`;
        this.el.liquidationAlertBar.classList.remove('hidden');
      } else {
        this.el.liquidationAlertBar.classList.add('hidden');
      }

      this.renderKpis(result.stats);
      this.renderTradesTable(result.trades, params);
      this.renderEquitySummary(result.stats);
      this.renderLadderTable();
      ChartManager.render(candles, result, params);
    },

    renderKpis(s) {
      this.el.kpiBalance.textContent = fmtUsd(s.finalBalance);
      this.el.kpiBalance.className = `kpi-value mono ${s.netPnl > 0 ? 'positive' : s.netPnl < 0 ? 'negative' : ''}`;
      this.el.kpiBalanceSub.textContent = `Başlangıç: ${fmtUsd(s.initialBalance)} (${fmtSignedPct(s.roiPct)})`;

      this.el.kpiNetPnl.textContent = fmtSignedUsd(s.netPnl);
      this.el.kpiNetPnl.className = `kpi-value mono ${s.netPnl > 0 ? 'positive' : s.netPnl < 0 ? 'negative' : ''}`;
      this.el.kpiNetPnlSub.textContent = `Komisyon: -${fmtUsd(s.totalFeesPaid)}`;

      this.el.kpiWinRate.textContent = `${s.winRate.toFixed(1)}%`;
      this.el.kpiWinRate.className = `kpi-value mono ${s.winRate >= 50 ? 'positive' : s.closedTrades > 0 ? 'negative' : ''}`;
      this.el.kpiWinRateSub.textContent = `${s.wins} Kâr / ${s.losses} Zarar`;

      this.el.kpiTotalTrades.textContent = String(s.totalTrades);
      this.el.kpiTotalTradesSub.textContent = `Toplam Ekleme: +${s.totalAddsCount}`;

      this.el.kpiMaxDd.textContent = `-${s.maxDrawdownPct.toFixed(2)}%`;
      this.el.kpiMaxDdSub.textContent = `-${fmtUsd(s.maxDrawdownUsd)} tepe-dip`;

      this.el.kpiMaxMargin.textContent = fmtUsd(s.maxMarginUsed);
      this.el.kpiMaxMarginSub.textContent = `Kasa oranı: ${s.maxMarginRatio.toFixed(1)}%`;
    },

    renderEquitySummary(s) {
      this.el.eqStartVal.textContent = fmtUsd(s.initialBalance);
      this.el.eqPeakVal.textContent = fmtUsd(s.peakEquity);
      this.el.eqLowVal.textContent = fmtUsd(s.minEquity);
      this.el.eqEndVal.textContent = fmtUsd(s.finalBalance);
      this.el.eqRoiVal.textContent = fmtSignedPct(s.roiPct);
      this.el.eqRoiVal.className = `mono ${s.roiPct >= 0 ? 'positive' : 'negative'}`;
    },

    renderTradesTable(trades, params) {
      const tbody = this.el.tradesTableBody;
      this.el.tabTradesCount.textContent = String(trades.length);

      if (!trades.length) {
        tbody.innerHTML = `<tr class="empty-row"><td colspan="10">Seçilen tarih aralığı ve parametrelerle hiç işlem tetiklenmedi.</td></tr>`;
        return;
      }

      const frag = document.createDocumentFragment();
      for (const t of trades) {
        const tr = document.createElement('tr');
        tr.className = 'clickable' + (t.status === 'LIQUIDATED' ? ' liq-row' : '');
        tr.dataset.tradeId = String(t.id);

        const statusBadge =
          t.status === 'LIQUIDATED'
            ? '<span class="status-tag tag-liq">LİKİDE</span>'
            : t.status === 'OPEN'
              ? '<span class="status-tag tag-open">AÇIK</span>'
              : '';

        const addTag =
          t.addCount > 0
            ? `<span class="status-tag tag-add">+${t.addCount} Ekleme</span>`
            : `<span class="status-tag tag-zero">+0</span>`;

        const pnlClass = t.netPnl > 0 ? 'positive' : t.netPnl < 0 ? 'negative' : '';

        tr.innerHTML = `
          <td class="mono"><span class="trade-id-badge">#${t.id} ${statusBadge}</span></td>
          <td class="mono">${fmtDateTime(t.entryTime)}</td>
          <td class="mono">${t.exitTime ? fmtDateTime(t.exitTime) : '<span class="warning-text">Açık Pozisyon</span>'}</td>
          <td class="num mono">${fmtPrice(t.initialEntryPrice)}</td>
          <td class="num mono">${addTag}</td>
          <td class="num mono">${fmtPrice(t.avgEntryPrice)}</td>
          <td class="num mono">${fmtUsd(t.totalMargin)} / ${fmtUsd(t.totalNotional)}</td>
          <td class="num mono">${fmtPrice(t.exitPrice)}</td>
          <td class="num mono ${pnlClass}"><strong>${fmtSignedUsd(t.netPnl)}</strong> (${fmtSignedPct(t.netPnlPct)})</td>
          <td class="num mono">${fmtUsd(t.endBalance)}</td>
        `;

        tr.addEventListener('click', () => {
          document.querySelectorAll('#tradesTableBody tr.selected-row').forEach((r) => r.classList.remove('selected-row'));
          tr.classList.add('selected-row');
          this.state.selectedTradeId = t.id;

          this.el.selectedTradePill.textContent =
            `#${t.id} | +${t.addCount} Ekleme | Ort: ${fmtPrice(t.avgEntryPrice)} | ${fmtSignedUsd(t.netPnl)}`;
          this.el.selectedTradePill.classList.remove('hidden');

          ChartManager.focusTrade(t, params.timeframe);
        });

        frag.appendChild(tr);
      }

      tbody.innerHTML = '';
      tbody.appendChild(frag);
    },

    renderLadderTable() {
      const params = this.getParams();
      const refPrice = parseFloat(this.el.ladderRefPriceInput.value) || 65000;
      const rows = BacktestEngine.computeLadder(params, refPrice);
      const tbody = this.el.ladderTableBody;

      const lastRow = rows[rows.length - 1];
      this.el.ladderSummaryBadge.textContent =
        `${rows.length} Kademe | Toplam Teminat: ${fmtUsd(lastRow ? lastRow.cumMargin : 0)} (${params.leverage}x)`;

      const frag = document.createDocumentFragment();
      for (const r of rows) {
        const tr = document.createElement('tr');
        if (r.status === 'INSUFFICIENT' || r.status === 'LIQ') tr.classList.add('liq-row');

        const tagClass =
          r.status === 'SAFE' ? 'tag-safe' :
          r.status === 'WARN' ? 'tag-warn' : 'tag-liq';

        tr.innerHTML = `
          <td><strong>${r.label}</strong></td>
          <td class="num mono ${r.dropFromStartPct < 0 ? 'negative' : ''}">${r.dropFromStartPct.toFixed(2)}%</td>
          <td class="num mono">${fmtPrice(r.entryPrice)}</td>
          <td class="num mono">${fmtUsd(r.stepMargin)}</td>
          <td class="num mono">${fmtUsd(r.cumMargin)}</td>
          <td class="num mono">${fmtUsd(r.cumNotional)}</td>
          <td class="num mono positive">${fmtPrice(r.avgEntry)}</td>
          <td class="num mono">+${r.bounceToBreakEvenPct.toFixed(2)}%</td>
          <td class="num mono negative">${fmtPrice(r.liqPrice)}</td>
          <td class="num mono ${r.freeBalance < 0 ? 'negative' : ''}">${fmtSignedUsd(r.freeBalance)}</td>
          <td><span class="status-tag ${tagClass}">${r.statusLabel}</span></td>
        `;
        frag.appendChild(tr);
      }

      tbody.innerHTML = '';
      tbody.appendChild(frag);
    },

    exportTradesCsv() {
      const res = this.state.result;
      if (!res || !res.trades.length) {
        showToast('Dışa aktarılacak işlem bulunamadı.', 'warning');
        return;
      }
      const params = this.getParams();
      const headers = [
        'Islem_No', 'Durum', 'Giris_Zamani', 'Cikis_Zamani',
        'Ilk_Alim_Fiyati', 'Ekleme_Sayisi', 'Ort_Giris_Fiyati',
        'Toplam_Teminat_USD', `Toplam_Hacim_${params.leverage}x_USD`,
        `EMA_${params.emaPeriod}_Cikis`, 'Komisyon_USD',
        'Net_KZ_USD', 'Net_KZ_Yuzde', 'Islem_Sonu_Kasa_USD',
      ];

      const lines = [headers.join(',')];
      for (const t of res.trades) {
        lines.push([
          `#${t.id}`,
          t.status,
          `"${fmtDateTime(t.entryTime)}"`,
          `"${t.exitTime ? fmtDateTime(t.exitTime) : 'ACIK'}"`,
          t.initialEntryPrice.toFixed(6),
          t.addCount,
          t.avgEntryPrice.toFixed(6),
          t.totalMargin.toFixed(4),
          t.totalNotional.toFixed(4),
          t.exitPrice.toFixed(6),
          t.fees.toFixed(4),
          t.netPnl.toFixed(4),
          t.netPnlPct.toFixed(2),
          t.endBalance.toFixed(4),
        ].join(','));
      }

      const blob = new Blob(['\uFEFF' + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `futures-dca-${params.symbol}-${params.timeframe}-${Date.now()}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);

      showToast(`${res.trades.length} birleşik işlem CSV olarak indirildi.`, 'success');
    },
  };

  document.addEventListener('DOMContentLoaded', () => App.init());
})();
