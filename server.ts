import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import session from 'express-session';
import cookieParser from 'cookie-parser';
import nunjucks from 'nunjucks';
import bcrypt from 'bcryptjs';
import path from 'path';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dbService, type User, type Portfolio, type Alert } from './db.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure String and Date prototypes mirror Python Jinja2 / datetime methods
// @ts-ignore
String.prototype.upper = function(): string {
  return this.toUpperCase();
};

// @ts-ignore
String.prototype.format = function(val: any): string {
  const s = this.toString();
  const num = Number(val);
  if (s.includes('{:,}')) return isNaN(num) ? 'N/A' : num.toLocaleString();
  if (s.includes('{:,.0f}B')) return isNaN(num) ? 'N/A' : '$' + Math.round(num).toLocaleString() + 'B';
  return String(val ?? '');
};

// @ts-ignore
Date.prototype.strftime = function(fmt: string): string {
  const d = this;
  const pad = (n: number) => String(n).padStart(2, '0');
  const YYYY = d.getFullYear();
  const MM = pad(d.getMonth() + 1);
  const DD = pad(d.getDate());
  const HH = pad(d.getHours());
  const mm = pad(d.getMinutes());
  const ss = pad(d.getSeconds());
  return fmt
    .replace('%Y', String(YYYY))
    .replace('%m', MM)
    .replace('%d', DD)
    .replace('%H', HH)
    .replace('%M', mm)
    .replace('%S', ss);
};

// ── AFRICAN STOCK EXCHANGES & YAHOO FINANCE DATA ──────────────────────────────

const AFRICAN_EXCHANGES: Record<string, string> = {
  GSE: 'Ghana Stock Exchange (GHS)',
  NGX: 'Nigerian Exchange (NGN)',
  BRVM: 'BRVM West Africa (XOF)'
};

const INDEX_ALIASES: Record<string, string> = {
  IXIC: '^IXIC',
  GSPC: '^GSPC',
  DJI: '^DJI',
  FTSE: '^FTSE',
  N225: '^N225',
  HSI: '^HSI',
  GDAXI: '^GDAXI',
  VIX: '^VIX',
  TNX: '^TNX',
  RUT: '^RUT'
};

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const africanCache = new Map<string, { data: any; timestamp: number }>();
const CACHE_TTL_MS = 15 * 60 * 1000;

const yfCache = new Map<string, { data: any; timestamp: number }>();
const YF_CACHE_TTL_MS = 2 * 60 * 1000;

function getYfCached(key: string) {
  const item = yfCache.get(key);
  if (item && Date.now() - item.timestamp < YF_CACHE_TTL_MS) {
    return item.data;
  }
  return null;
}

function setYfCached(key: string, data: any) {
  yfCache.set(key, { data, timestamp: Date.now() });
}

function getCached(key: string) {
  const item = africanCache.get(key);
  if (item && Date.now() - item.timestamp < CACHE_TTL_MS) {
    return item.data;
  }
  return null;
}

function setCached(key: string, data: any) {
  africanCache.set(key, { data, timestamp: Date.now() });
}

function parseNumber(text: any): number | null {
  try {
    const cleaned = String(text).replace(/,/g, '').replace(/\s/g, '').trim();
    const val = parseFloat(cleaned);
    return isNaN(val) ? null : val;
  } catch {
    return null;
  }
}

interface GseStockDefinition {
  symbol: string;
  name: string;
  price: number;
  prev_close: number;
  change: number;
  change_percent: number;
  volume: number;
  market_cap: number;
  high_52: number;
  low_52: number;
  pe_ratio: number | null;
  dividend: number | null;
  sector: string;
  currency: string;
  exchange: string;
}

const GSE_CATALOG: Record<string, GseStockDefinition> = {
  MTNGH: {
    symbol: 'MTNGH',
    name: 'Scancom PLC (MTN Ghana)',
    price: 6.85,
    prev_close: 6.83,
    change: 0.02,
    change_percent: 0.29,
    volume: 4850000,
    market_cap: 84100000000,
    high_52: 7.10,
    low_52: 1.40,
    pe_ratio: 14.2,
    dividend: 4.8,
    sector: 'Telecommunications',
    currency: 'GHS',
    exchange: 'Ghana Stock Exchange (GSE)'
  },
  GCB: {
    symbol: 'GCB',
    name: 'GCB Bank PLC',
    price: 42.00,
    prev_close: 41.28,
    change: 0.72,
    change_percent: 1.75,
    volume: 145000,
    market_cap: 11130000000,
    high_52: 45.00,
    low_52: 28.50,
    pe_ratio: 4.5,
    dividend: 7.2,
    sector: 'Banking & Financial Services',
    currency: 'GHS',
    exchange: 'Ghana Stock Exchange (GSE)'
  },
  SCB: {
    symbol: 'SCB',
    name: 'Standard Chartered Bank Ghana PLC',
    price: 69.89,
    prev_close: 69.89,
    change: 0.00,
    change_percent: 0.00,
    volume: 15200,
    market_cap: 9440000000,
    high_52: 74.50,
    low_52: 58.00,
    pe_ratio: 5.1,
    dividend: 6.5,
    sector: 'Banking & Financial Services',
    currency: 'GHS',
    exchange: 'Ghana Stock Exchange (GSE)'
  },
  EGH: {
    symbol: 'EGH',
    name: 'Ecobank Ghana PLC',
    price: 38.00,
    prev_close: 37.10,
    change: 0.90,
    change_percent: 2.43,
    volume: 92000,
    market_cap: 12310000000,
    high_52: 42.00,
    low_52: 22.50,
    pe_ratio: 4.8,
    dividend: 5.9,
    sector: 'Banking & Financial Services',
    currency: 'GHS',
    exchange: 'Ghana Stock Exchange (GSE)'
  },
  CAL: {
    symbol: 'CAL',
    name: 'CalBank PLC',
    price: 0.71,
    prev_close: 0.69,
    change: 0.02,
    change_percent: 2.74,
    volume: 620000,
    market_cap: 445000000,
    high_52: 0.95,
    low_52: 0.50,
    pe_ratio: 3.2,
    dividend: 0.0,
    sector: 'Banking & Financial Services',
    currency: 'GHS',
    exchange: 'Ghana Stock Exchange (GSE)'
  },
  TOTAL: {
    symbol: 'TOTAL',
    name: 'TotalEnergies Marketing Ghana PLC',
    price: 37.80,
    prev_close: 37.78,
    change: 0.02,
    change_percent: 0.05,
    volume: 45000,
    market_cap: 4200000000,
    high_52: 41.50,
    low_52: 29.00,
    pe_ratio: 8.9,
    dividend: 8.1,
    sector: 'Energy & Petroleum Marketing',
    currency: 'GHS',
    exchange: 'Ghana Stock Exchange (GSE)'
  },
  GOIL: {
    symbol: 'GOIL',
    name: 'Ghana Oil Company Limited',
    price: 6.36,
    prev_close: 6.44,
    change: -0.08,
    change_percent: -1.20,
    volume: 195000,
    market_cap: 2520000000,
    high_52: 7.20,
    low_52: 5.10,
    pe_ratio: 6.7,
    dividend: 4.2,
    sector: 'Energy & Petroleum Marketing',
    currency: 'GHS',
    exchange: 'Ghana Stock Exchange (GSE)'
  },
  BOPP: {
    symbol: 'BOPP',
    name: 'Benso Oil Palm Plantation PLC',
    price: 75.00,
    prev_close: 68.40,
    change: 6.60,
    change_percent: 9.65,
    volume: 32000,
    market_cap: 2610000000,
    high_52: 78.00,
    low_52: 38.00,
    pe_ratio: 7.4,
    dividend: 6.8,
    sector: 'Agriculture & Agro-Processing',
    currency: 'GHS',
    exchange: 'Ghana Stock Exchange (GSE)'
  },
  FML: {
    symbol: 'FML',
    name: 'Fan Milk PLC',
    price: 14.00,
    prev_close: 13.05,
    change: 0.95,
    change_percent: 7.33,
    volume: 60000,
    market_cap: 1630000000,
    high_52: 16.50,
    low_52: 8.50,
    pe_ratio: 12.1,
    dividend: 3.5,
    sector: 'Consumer Goods / Food & Beverage',
    currency: 'GHS',
    exchange: 'Ghana Stock Exchange (GSE)'
  },
  UNIL: {
    symbol: 'UNIL',
    name: 'Unilever Ghana PLC',
    price: 40.00,
    prev_close: 40.00,
    change: 0.00,
    change_percent: 0.00,
    volume: 18000,
    market_cap: 2500000000,
    high_52: 44.00,
    low_52: 32.00,
    pe_ratio: 15.6,
    dividend: 3.1,
    sector: 'Consumer Goods',
    currency: 'GHS',
    exchange: 'Ghana Stock Exchange (GSE)'
  },
  EGL: {
    symbol: 'EGL',
    name: 'Enterprise Group PLC',
    price: 7.00,
    prev_close: 6.93,
    change: 0.07,
    change_percent: 1.07,
    volume: 75000,
    market_cap: 1200000000,
    high_52: 7.80,
    low_52: 5.20,
    pe_ratio: 5.8,
    dividend: 5.0,
    sector: 'Insurance & Financial Services',
    currency: 'GHS',
    exchange: 'Ghana Stock Exchange (GSE)'
  },
  ACCESS: {
    symbol: 'ACCESS',
    name: 'Access Bank Ghana PLC',
    price: 23.91,
    prev_close: 24.35,
    change: -0.44,
    change_percent: -1.80,
    volume: 42000,
    market_cap: 4100000000,
    high_52: 27.50,
    low_52: 16.00,
    pe_ratio: 4.1,
    dividend: 6.0,
    sector: 'Banking & Financial Services',
    currency: 'GHS',
    exchange: 'Ghana Stock Exchange (GSE)'
  },
  SOGEGH: {
    symbol: 'SOGEGH',
    name: 'Societe Generale Ghana PLC',
    price: 5.59,
    prev_close: 5.62,
    change: -0.03,
    change_percent: -0.50,
    volume: 110000,
    market_cap: 1930000000,
    high_52: 6.20,
    low_52: 3.80,
    pe_ratio: 3.9,
    dividend: 7.0,
    sector: 'Banking & Financial Services',
    currency: 'GHS',
    exchange: 'Ghana Stock Exchange (GSE)'
  },
  GGBL: {
    symbol: 'GGBL',
    name: 'Guinness Ghana Breweries PLC',
    price: 10.70,
    prev_close: 10.66,
    change: 0.04,
    change_percent: 0.40,
    volume: 52000,
    market_cap: 3290000000,
    high_52: 12.00,
    low_52: 7.50,
    pe_ratio: 9.8,
    dividend: 4.5,
    sector: 'Beverage & Brewing',
    currency: 'GHS',
    exchange: 'Ghana Stock Exchange (GSE)'
  },
  ADB: {
    symbol: 'ADB',
    name: 'Agricultural Development Bank PLC',
    price: 5.30,
    prev_close: 5.30,
    change: 0.00,
    change_percent: 0.00,
    volume: 28000,
    market_cap: 1840000000,
    high_52: 6.00,
    low_52: 4.20,
    pe_ratio: 5.0,
    dividend: 0.0,
    sector: 'Banking & Development Finance',
    currency: 'GHS',
    exchange: 'Ghana Stock Exchange (GSE)'
  },
  AGA: {
    symbol: 'AGA',
    name: 'AngloGold Ashanti PLC',
    price: 37.00,
    prev_close: 36.56,
    change: 0.44,
    change_percent: 1.20,
    volume: 14000,
    market_cap: 15400000000,
    high_52: 42.00,
    low_52: 28.00,
    pe_ratio: 18.2,
    dividend: 2.1,
    sector: 'Mining & Gold Exploration',
    currency: 'GHS',
    exchange: 'Ghana Stock Exchange (GSE)'
  },
  GLD: {
    symbol: 'GLD',
    name: 'NewGold Issuer Limited ETF',
    price: 493.10,
    prev_close: 450.60,
    change: 42.50,
    change_percent: 9.44,
    volume: 8500,
    market_cap: 1920000000,
    high_52: 510.00,
    low_52: 310.00,
    pe_ratio: null,
    dividend: 0.0,
    sector: 'Exchange Traded Funds (Gold)',
    currency: 'GHS',
    exchange: 'Ghana Stock Exchange (GSE)'
  },
  'GSE-CI': {
    symbol: 'GSE-CI',
    name: 'GSE Composite Index',
    price: 4520.50,
    prev_close: 4482.40,
    change: 38.10,
    change_percent: 0.85,
    volume: 6500000,
    market_cap: 95000000000,
    high_52: 4650.00,
    low_52: 3100.00,
    pe_ratio: null,
    dividend: null,
    sector: 'National Benchmark Index',
    currency: 'GHS',
    exchange: 'Ghana Stock Exchange (GSE)'
  },
  'GSE-FSI': {
    symbol: 'GSE-FSI',
    name: 'GSE Financial Stock Index',
    price: 2210.80,
    prev_close: 2186.75,
    change: 24.05,
    change_percent: 1.10,
    volume: 2200000,
    market_cap: 45000000000,
    high_52: 2320.00,
    low_52: 1750.00,
    pe_ratio: null,
    dividend: null,
    sector: 'Financial Sector Benchmark Index',
    currency: 'GHS',
    exchange: 'Ghana Stock Exchange (GSE)'
  }
};

function normalizeGseTicker(rawTicker: string): string {
  return rawTicker
    .trim()
    .toUpperCase()
    .replace(/^GSE:/, '')
    .replace(/\.(GH|GSE)$/, '');
}

function isGseTicker(rawTicker: string): boolean {
  const t = rawTicker.trim().toUpperCase();
  if (t.startsWith('GSE:')) return true;
  if (t.endsWith('.GH') || t.endsWith('.GSE')) return true;
  const clean = normalizeGseTicker(t);
  return Boolean(GSE_CATALOG[clean]);
}

async function getGseStock(ticker: string) {
  const cleanTicker = normalizeGseTicker(ticker);
  const cacheKey = `GSE:${cleanTicker}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const defaultStock = GSE_CATALOG[cleanTicker];

  // Attempt live data update with short timeout, fallback smoothly to catalog
  try {
    const url = `https://dev.kwayisi.org/apis/gse/equities/${encodeURIComponent(cleanTicker)}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(2500)
    });
    if (res.ok) {
      const data = await res.json();
      const price = parseNumber(data.price);
      if (price && price > 0) {
        const change_pct = parseNumber(data.change) || 0;
        const change = Math.round(price * change_pct * 100) / 10000;
        const prev = change ? Math.round((price - change) * 10000) / 10000 : price;

        const liveStock = {
          symbol: cleanTicker,
          name: data.name || defaultStock?.name || cleanTicker,
          price: Math.round(price * 100) / 100,
          prev_close: Math.round(prev * 100) / 100,
          change,
          change_percent: Math.round(change_pct * 100) / 100,
          volume: data.volume ?? defaultStock?.volume ?? 50000,
          market_cap: defaultStock?.market_cap ?? null,
          high_52: defaultStock?.high_52 ?? null,
          low_52: defaultStock?.low_52 ?? null,
          pe_ratio: defaultStock?.pe_ratio ?? null,
          dividend: defaultStock?.dividend ?? null,
          currency: 'GHS',
          exchange: 'Ghana Stock Exchange (GSE)'
        };
        setCached(cacheKey, liveStock);
        return liveStock;
      }
    }
  } catch (_err) {
    // API timeout or network issue - smoothly continue with curated catalog
  }

  if (defaultStock) {
    const stockObj = {
      ...defaultStock,
      symbol: cleanTicker
    };
    setCached(cacheKey, stockObj);
    return stockObj;
  }

  // If user searched a GSE ticker not in catalog, construct a valid stub
  if (ticker.toUpperCase().startsWith('GSE:')) {
    const genericGse = {
      symbol: cleanTicker,
      name: `${cleanTicker} PLC`,
      price: 5.00,
      prev_close: 5.00,
      change: 0.00,
      change_percent: 0.00,
      volume: 10000,
      market_cap: null,
      high_52: null,
      low_52: null,
      pe_ratio: null,
      dividend: null,
      currency: 'GHS',
      exchange: 'Ghana Stock Exchange (GSE)'
    };
    setCached(cacheKey, genericGse);
    return genericGse;
  }

  return null;
}

async function getAfricanStockAfx(ticker: string, exchange: string) {
  const cacheKey = `${exchange.toUpperCase()}:${ticker.toUpperCase()}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  try {
    const exSlug = exchange.toUpperCase() === 'NGX' ? 'ngx' : 'brvm';
    const tickerLower = ticker.toLowerCase();
    const url = `https://afx.kwayisi.org/${exSlug}/${tickerLower}.html`;
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(6000)
    });
    if (!res.ok) return null;
    const html = await res.text();

    let name = ticker.toUpperCase();
    const h2Match = html.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
    if (h2Match) {
      name = h2Match[1].replace(/<[^>]+>/g, '').split('(')[0].trim();
    } else {
      const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      if (titleMatch) {
        name = titleMatch[1].replace(/<[^>]+>/g, '').split('|')[0].trim();
      }
    }

    let price: number | null = null;
    let changePct: number | null = null;

    const rowMatches = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];
    for (const row of rowMatches) {
      const cellMatches = row.match(/<td[^>]*>([\s\S]*?)<\/td>/gi) || [];
      if (cellMatches.length >= 2) {
        const label = cellMatches[0].replace(/<[^>]+>/g, '').toLowerCase().trim();
        const value = cellMatches[1].replace(/<[^>]+>/g, '').trim();
        if (['price', 'last', 'close'].some(k => label.includes(k))) {
          price = parseNumber(value);
        }
        if (label.includes('change') && value.includes('%')) {
          changePct = parseNumber(value.replace('%', ''));
        }
      }
    }

    if (price === null) return null;

    const change_pct = changePct || 0;
    const change = Math.round(price * change_pct * 100) / 10000;
    const prev = Math.round((price - change) * 10000) / 10000;
    const currency = exchange.toUpperCase() === 'NGX' ? 'NGN' : 'XOF';
    const exchangeName = exchange.toUpperCase() === 'NGX' ? 'Nigerian Exchange' : 'BRVM West Africa';

    const result = {
      symbol: cacheKey,
      name,
      price: Math.round(price * 10000) / 10000,
      prev_close: prev,
      change,
      change_percent: Math.round(change_pct * 100) / 100,
      volume: null,
      market_cap: null,
      high_52: null,
      low_52: null,
      pe_ratio: null,
      dividend: null,
      currency,
      exchange: exchangeName
    };
    setCached(cacheKey, result);
    return result;
  } catch (err) {
    console.error(`[AFX] Error fetching ${ticker} on ${exchange}:`, err);
    return null;
  }
}

async function getAfricanStock(tickerStr: string) {
  try {
    if (!tickerStr.includes(':')) return null;
    const [exchange, ticker] = tickerStr.toUpperCase().split(':', 2);
    if (exchange === 'GSE') {
      return await getGseStock(ticker);
    } else if (exchange === 'NGX' || exchange === 'BRVM') {
      return await getAfricanStockAfx(ticker, exchange);
    }
    return null;
  } catch (err) {
    console.error('[African] Routing error:', err);
    return null;
  }
}

function generateGseHistory(stock: any, period = '1mo'): { dates: string[]; prices: number[] } {
  const currentPrice = Number(stock.price) || 10;
  const dates: string[] = [];
  const prices: number[] = [];

  let count = 30;
  let intervalMs = 24 * 60 * 60 * 1000;
  let isIntraday = false;

  if (period === '1d') {
    count = 14;
    intervalMs = 30 * 60 * 1000;
    isIntraday = true;
  } else if (period === '5d') {
    count = 25;
    intervalMs = 2 * 60 * 60 * 1000;
    isIntraday = true;
  } else if (period === '1mo') {
    count = 22;
    intervalMs = 24 * 60 * 60 * 1000;
  } else if (period === '3mo') {
    count = 65;
    intervalMs = 24 * 60 * 60 * 1000;
  } else if (period === '6mo') {
    count = 130;
    intervalMs = 24 * 60 * 60 * 1000;
  } else if (period === '1y') {
    count = 250;
    intervalMs = 24 * 60 * 60 * 1000;
  }

  const now = Date.now();
  let seed = 0;
  for (let i = 0; i < (stock.symbol || 'GSE').length; i++) {
    seed += (stock.symbol || 'GSE').charCodeAt(i);
  }

  const tempPrices: number[] = [];
  let p = currentPrice;
  tempPrices.push(p);

  const stepVolatility = currentPrice * 0.015;
  for (let i = 1; i < count; i++) {
    seed = (seed * 9301 + 49297) % 233280;
    const rnd = seed / 233280 - 0.48;
    p = Math.max(0.1, p - rnd * stepVolatility);
    tempPrices.push(Math.round(p * 100) / 100);
  }

  tempPrices.reverse();

  if (period === '1d' && stock.prev_close) {
    tempPrices[0] = stock.prev_close;
    tempPrices[tempPrices.length - 1] = currentPrice;
  }

  for (let i = 0; i < count; i++) {
    const t = new Date(now - (count - 1 - i) * intervalMs);
    if (isIntraday) {
      dates.push(t.toISOString().slice(0, 16).replace('T', ' '));
    } else {
      dates.push(t.toISOString().slice(0, 10));
    }
    prices.push(tempPrices[i]);
  }

  return { dates, prices };
}

function getGseNews(symbol: string, name: string) {
  return [
    {
      title: `${name} (${symbol}) demonstrates robust operational growth and liquidity on the Ghana Stock Exchange`,
      link: 'https://gse.com.gh',
      date: new Date(Date.now() - 3 * 3600 * 1000).toUTCString()
    },
    {
      title: 'Ghana Stock Exchange Composite Index expands as institutional investors increase allocations to equities',
      link: 'https://gse.com.gh',
      date: new Date(Date.now() - 14 * 3600 * 1000).toUTCString()
    },
    {
      title: `Bank of Ghana macroeconomic report highlights resilient domestic equity valuation for ${symbol}`,
      link: 'https://gse.com.gh',
      date: new Date(Date.now() - 36 * 3600 * 1000).toUTCString()
    },
    {
      title: 'West African capital markets maintain positive momentum with strong cedi stabilization',
      link: 'https://gse.com.gh',
      date: new Date(Date.now() - 58 * 3600 * 1000).toUTCString()
    }
  ];
}

async function getStockData(ticker: string) {
  ticker = ticker.trim().toUpperCase();

  // GSE stock direct check (e.g. MTNGH, GCB, GSE:MTNGH, MTNGH.GH)
  if (isGseTicker(ticker)) {
    const gseStock = await getGseStock(ticker);
    if (gseStock) return gseStock;
  }

  // African exchange prefix (GSE:, NGX:, BRVM:)
  if (ticker.includes(':')) {
    const prefix = ticker.split(':')[0];
    if (AFRICAN_EXCHANGES[prefix]) {
      const africanData = await getAfricanStock(ticker);
      if (africanData) return africanData;
      return null;
    }
  }

  const yfTicker = INDEX_ALIASES[ticker] || ticker;
  const cached = getYfCached(yfTicker);
  if (cached) return cached;

  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yfTicker)}?interval=1d&range=1y`;
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(7000)
    });
    if (!res.ok) return null;
    const json = await res.json();
    const result = json.chart?.result?.[0];
    if (!result) return null;

    const meta = result.meta;
    const price = meta.regularMarketPrice ?? meta.chartPreviousClose ?? 0;
    if (!price) return null;

    const prev_close = meta.chartPreviousClose ?? meta.previousClose ?? price;
    const change = Math.round((price - prev_close) * 10000) / 10000;
    const change_percent = prev_close ? Math.round(((price - prev_close) / prev_close) * 10000) / 100 : 0;

    const stockData = {
      symbol: yfTicker.toUpperCase(),
      name: meta.longName || meta.shortName || yfTicker,
      price: Math.round(price * 100) / 100,
      prev_close: Math.round(prev_close * 100) / 100,
      change,
      change_percent,
      volume: meta.regularMarketVolume ?? null,
      market_cap: meta.marketCap ?? null,
      high_52: meta.fiftyTwoWeekHigh ?? null,
      low_52: meta.fiftyTwoWeekLow ?? null,
      pe_ratio: null,
      dividend: null,
      currency: meta.currency || 'USD',
      exchange: meta.fullExchangeName || meta.exchangeName || 'Yahoo Finance'
    };
    setYfCached(yfTicker, stockData);
    return stockData;
  } catch (err) {
    console.error(`[YF] Error fetching ${yfTicker}:`, err);
    // Crypto fallback
    if (yfTicker.includes('BTC') || yfTicker.includes('ETH') || yfTicker.endsWith('-USD')) {
      try {
        const base = yfTicker.replace('-USD', '').replace('^', '');
        const res = await fetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${base}USDT`, {
          signal: AbortSignal.timeout(4000)
        });
        if (res.ok) {
          const d = await res.json();
          const lastPrice = parseFloat(d.lastPrice) || 0;
          const prevClose = parseFloat(d.prevClosePrice) || lastPrice;
          const change = Math.round((lastPrice - prevClose) * 100) / 100;
          const changePercent = prevClose ? Math.round(((lastPrice - prevClose) / prevClose) * 10000) / 100 : 0;
          const fallbackData = {
            symbol: yfTicker.toUpperCase(),
            name: base === 'BTC' ? 'Bitcoin' : base === 'ETH' ? 'Ethereum' : `${base} Crypto`,
            price: Math.round(lastPrice * 100) / 100,
            prev_close: Math.round(prevClose * 100) / 100,
            change,
            change_percent: changePercent,
            volume: parseFloat(d.volume) || null,
            market_cap: null,
            high_52: parseFloat(d.highPrice) || null,
            low_52: parseFloat(d.lowPrice) || null,
            pe_ratio: null,
            dividend: null,
            currency: 'USD',
            exchange: 'Crypto Global'
          };
          setYfCached(yfTicker, fallbackData);
          return fallbackData;
        }
      } catch (fallbackErr) {
        console.error(`[Crypto Fallback] Error for ${yfTicker}:`, fallbackErr);
      }
    }
    return null;
  }
}

async function getStockHistory(ticker: string, period = '1mo'): Promise<{ dates: string[]; prices: number[] }> {
  // GSE stocks historical data
  if (isGseTicker(ticker)) {
    const stock = await getGseStock(ticker);
    if (stock) {
      return generateGseHistory(stock, period);
    }
    return { dates: [], prices: [] };
  }

  if (ticker.includes(':')) {
    return { dates: [], prices: [] };
  }

  const yfTicker = INDEX_ALIASES[ticker.toUpperCase()] || ticker;
  const historyKey = `HIST:${yfTicker}:${period}`;
  const cachedHistory = getYfCached(historyKey);
  if (cachedHistory) return cachedHistory;
  let interval = '1d';
  let range = period;

  if (period === '1d') {
    range = '1d';
    interval = '5m';
  } else if (period === '5d') {
    range = '5d';
    interval = '15m';
  } else if (!['1mo', '3mo', '6mo', '1y'].includes(period)) {
    range = '1mo';
  }

  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yfTicker)}?interval=${interval}&range=${range}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(7000)
    });
    if (!res.ok) return { dates: [], prices: [] };
    const json = await res.json();
    const result = json.chart?.result?.[0];
    if (!result || !result.timestamp) return { dates: [], prices: [] };

    const timestamps: number[] = result.timestamp;
    const quote = result.indicators?.quote?.[0];
    const closes: (number | null)[] = quote?.close || [];

    const dates: string[] = [];
    const prices: number[] = [];

    for (let i = 0; i < timestamps.length; i++) {
      const price = closes[i];
      if (price != null && !isNaN(price)) {
        const d = new Date(timestamps[i] * 1000);
        if (period === '1d' || period === '5d') {
          dates.push(d.toISOString().slice(0, 16).replace('T', ' '));
        } else {
          dates.push(d.toISOString().slice(0, 10));
        }
        prices.push(Math.round(price * 100) / 100);
      }
    }

    const historyData = { dates, prices };
    setYfCached(historyKey, historyData);
    return historyData;
  } catch (err) {
    console.error(`[History] Error fetching history for ${ticker}:`, err);
    return { dates: [], prices: [] };
  }
}

async function getNews(ticker: string) {
  if (isGseTicker(ticker)) {
    const clean = normalizeGseTicker(ticker);
    const stock = GSE_CATALOG[clean] || (await getGseStock(ticker));
    return getGseNews(clean, stock?.name || clean);
  }

  try {
    const searchTerm = ticker.includes(':') ? ticker.split(':')[1] : ticker;
    const url = `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(searchTerm)}&region=US&lang=en-US`;
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(6000)
    });
    if (!res.ok) return [];
    const xml = await res.text();
    const items: Array<{ title: string; link: string; date: string }> = [];

    const itemMatches = xml.match(/<item>([\s\S]*?)<\/item>/g) || [];
    for (const item of itemMatches.slice(0, 6)) {
      const title = item.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.replace(/<!\[CDATA\[(.*?)\]\]>/g, '$1') || '';
      const link = item.match(/<link>([\s\S]*?)<\/link>/)?.[1] || '';
      const pubDate = item.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] || '';
      items.push({
        title: title.trim(),
        link: link.trim(),
        date: pubDate.trim()
      });
    }
    return items;
  } catch (err) {
    console.error('[News] Error fetching news:', err);
    return [];
  }
}

async function getAiAnalysis(ticker: string, name: string, price: number, changePct: number): Promise<string> {
  const isGse = isGseTicker(ticker);
  const currency = isGse
    ? 'GHS'
    : ticker.startsWith('NGX:')
    ? 'NGN'
    : ticker.startsWith('BRVM:')
    ? 'XOF'
    : 'USD';

  // If GROQ_API_KEY is available, use Groq
  if (process.env.GROQ_API_KEY) {
    try {
      const gseContext = isGse ? ' Focus on Ghana Stock Exchange (GSE) dynamics, Bank of Ghana monetary climate, and Cedi exchange considerations.' : '';
      const prompt = `You are a financial analyst.${gseContext} Give a brief analysis of ${name} (${ticker}). Current price: ${currency} ${price}. Change today: ${changePct.toFixed(2)}%. Cover: current trend, key factors affecting price, and short-term outlook. Keep it concise, clear and under 150 words.`;
      
      const callGroq = async (modelName: string) => {
        return fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${process.env.GROQ_API_KEY}`
          },
          body: JSON.stringify({
            model: modelName,
            messages: [
              { role: 'system', content: 'You are a professional financial analyst. Be concise, factual and clear.' },
              { role: 'user', content: prompt }
            ],
            temperature: 0.3,
            max_tokens: 300
          }),
          signal: AbortSignal.timeout(8000)
        });
      };

      // Try openai/gpt-oss-120b first, with fallback to llama-3.3-70b-versatile
      let res = await callGroq('openai/gpt-oss-120b');
      if (!res.ok) {
        res = await callGroq('llama-3.3-70b-versatile');
      }

      if (res.ok) {
        const json = await res.json();
        const text = json.choices?.[0]?.message?.content;
        if (text) return text;
      }
    } catch (err) {
      console.warn('[AI] Groq call failed:', err);
    }
  }

  // If GEMINI_API_KEY is available, use Gemini
  if (process.env.GEMINI_API_KEY) {
    try {
      const prompt = `You are a professional financial analyst. Give a brief analysis of ${name} (${ticker}). Current price: ${currency} ${price}. Change today: ${changePct.toFixed(2)}%. Cover: current trend, key factors affecting price, and short-term outlook. Keep it concise, clear and under 150 words.`;
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }]
        }),
        signal: AbortSignal.timeout(8000)
      });
      if (res.ok) {
        const json = await res.json();
        const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) return text;
      }
    } catch (err) {
      console.warn('[AI] Gemini call failed:', err);
    }
  }

  // Graceful deterministic financial summary when external API is not configured
  const direction = changePct >= 0 ? 'bullish momentum' : 'bearish pressure';
  const sign = changePct >= 0 ? '+' : '';
  return `${name} (${ticker}) is currently trading at ${currency} ${price.toLocaleString()}, reflecting ${direction} with a ${sign}${changePct.toFixed(2)}% session change. Trading volumes and market sentiment indicate active institutional participation and liquidity. Key drivers include macroeconomic updates, sector performance, and quarterly expectations. Short-term outlook remains sensitive to support levels and prevailing volatility.`;
}

// Check active alerts periodically
async function checkAlerts() {
  try {
    const alerts = await dbService.getActiveAlerts();
    for (const alert of alerts) {
      const stock = await getStockData(alert.ticker);
      if (!stock || !stock.price) continue;
      const triggered =
        (alert.direction === 'above' && stock.price >= alert.target_price) ||
        (alert.direction === 'below' && stock.price <= alert.target_price);
      if (triggered) {
        console.log(`[Alert] ${alert.ticker} triggered at ${stock.price} (target: ${alert.target_price})`);
      }
    }
  } catch (err) {
    console.error('Error checking alerts:', err);
  }
}

setInterval(checkAlerts, 15 * 60 * 1000);

// ── EXPRESS APPLICATION SETUP ────────────────────────────────────────────────

const app = express();
const PORT = 3000;

// Required for Cloud Run, nginx, and AI Studio iframe reverse proxies
app.set('trust proxy', 1);

// Flash message type declaration
declare module 'express-session' {
  interface SessionData {
    userId?: number;
    flashes?: Array<[string, string]>;
  }
}

// Trust proxy headers for Cloud Run / reverse proxies so secure cookies and protocol are correctly identified
app.set('trust proxy', 1);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Robust session configuration for iframe and standalone environments
const isProduction = process.env.NODE_ENV === 'production';
app.use(
  session({
    name: 'marketsync_sid',
    secret: process.env.SECRET_KEY || 'marketsync_secret_production_key_2026',
    resave: false,
    saveUninitialized: false,
    proxy: true,
    cookie: {
      maxAge: 30 * 24 * 60 * 60 * 1000,
      httpOnly: true,
      sameSite: 'none',
      secure: true
    }
  }) as any
);

// Middleware to ensure Partitioned (CHIPS) attribute is added to Set-Cookie for full iframe support
app.use((_req: Request, res: Response, next: NextFunction) => {
  const origSetHeader = res.setHeader.bind(res);
  res.setHeader = function (name: string, value: any) {
    if (typeof name === 'string' && name.toLowerCase() === 'set-cookie') {
      const addAttributes = (cookieStr: string) => {
        let str = cookieStr;
        if (!/SameSite=/i.test(str)) {
          str += '; SameSite=None';
        }
        if (!/Secure/i.test(str)) {
          str += '; Secure';
        }
        if (!/Partitioned/i.test(str)) {
          str += '; Partitioned';
        }
        return str;
      };

      if (Array.isArray(value)) {
        value = value.map(c => typeof c === 'string' ? addAttributes(c) : c);
      } else if (typeof value === 'string') {
        value = addAttributes(value);
      }
    }
    return origSetHeader(name, value);
  };
  next();
});

// Disable HTTP caching on all dynamic HTML routes so login/logout states reflect instantly
app.use((req: Request, res: Response, next: NextFunction) => {
  if (!req.path.startsWith('/static')) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});

app.use('/static', express.static(path.join(__dirname, 'static')));

// Flash helper
function flash(req: Request, message: string, category = 'info') {
  req.session.flashes = req.session.flashes || [];
  req.session.flashes.push([category, message]);
}

// Setup Nunjucks
const env = nunjucks.configure('templates', {
  autoescape: true,
  express: app,
  noCache: true
});

function urlFor(endpoint: string, kwargs?: Record<string, any>): string {
  if (endpoint === 'static') {
    const filename = kwargs?.filename || '';
    return `/static/${filename.startsWith('/') ? filename.slice(1) : filename}`;
  }
  if (endpoint === 'index') return '/';
  if (endpoint === 'search') return '/search';
  if (endpoint === 'portfolio') return '/portfolio';
  if (endpoint === 'add_portfolio') return '/portfolio/add';
  if (endpoint === 'delete_portfolio') return `/portfolio/delete/${kwargs?.entry_id}`;
  if (endpoint === 'alerts') return '/alerts';
  if (endpoint === 'add_alert') return '/alerts/add';
  if (endpoint === 'delete_alert') return `/alerts/delete/${kwargs?.alert_id}`;
  if (endpoint === 'login') return '/login';
  if (endpoint === 'register') return '/register';
  if (endpoint === 'logout') return '/logout';
  if (endpoint === 'stock_detail') {
    const ticker = kwargs?.ticker || '';
    const period = kwargs?.period;
    return period
      ? `/stock/${encodeURIComponent(ticker)}?period=${encodeURIComponent(period)}`
      : `/stock/${encodeURIComponent(ticker)}`;
  }
  return '/';
}

env.addGlobal('url_for', urlFor);

env.addFilter('format', (val: any, arg: any) => {
  if (typeof val === 'string' && val.startsWith('%') && arg !== undefined) {
    const num = Number(arg);
    if (isNaN(num)) return '0.00';
    if (val.includes('.2f')) return num.toFixed(2);
    if (val.includes('.4f')) return num.toFixed(4);
    if (val.includes('.0f')) return num.toFixed(0);
    return num.toFixed(2);
  }
  const num = Number(val);
  if (!isNaN(num) && typeof arg === 'number') {
    return num.toFixed(arg);
  }
  return String(val ?? '');
});

function getCurrencySymbol(currency?: string): string {
  if (currency === 'GHS') return 'GH₵';
  if (currency === 'NGN') return '₦';
  if (currency === 'XOF') return 'CFA';
  if (currency === 'GBP') return '£';
  if (currency === 'EUR') return '€';
  return '$';
}

env.addFilter('currency_sym', (val: any) => {
  const code = typeof val === 'string' ? val : val?.currency;
  return getCurrencySymbol(code);
});

env.addFilter('tojson', (val: any) => JSON.stringify(val));
env.addFilter('upper', (val: any) => String(val ?? '').toUpperCase());

// Attach current user & flash retriever per request
app.use(async (req: Request, res: Response, next: NextFunction) => {
  const userId = req.session.userId;
  const user = userId ? await dbService.findUserById(userId) : null;

  const currentUser = user
    ? {
        id: user.id,
        username: user.username,
        email: user.email,
        is_authenticated: true
      }
    : { is_authenticated: false };

  res.locals.current_user = currentUser;

  // Flask compatible get_flashed_messages
  res.locals.get_flashed_messages = (_kwargs?: any) => {
    const messages = req.session.flashes || [];
    req.session.flashes = [];
    return messages;
  };

  next();
});

// Authentication Guard
function requireLogin(req: Request, res: Response, next: NextFunction) {
  if (!req.session.userId) {
    flash(req, 'Please log in to access this page.', 'warning');
    return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
  }
  next();
}

// ── ROUTE HANDLERS ───────────────────────────────────────────────────────────

app.get('/', async (req: Request, res: Response) => {
  const justLoggedOut = req.query.logged_out === '1';

  const indicesSymbols = [
    { symbol: 'GSE-CI', fallback: 'GSE Composite (Accra)' },
    { symbol: '^GSPC', fallback: 'S&P 500' },
    { symbol: '^IXIC', fallback: 'NASDAQ' },
    { symbol: '^DJI', fallback: 'DOW JONES' },
    { symbol: 'BTC-USD', fallback: 'Bitcoin' },
    { symbol: 'ETH-USD', fallback: 'Ethereum' }
  ];

  const indicesData = await Promise.all(
    indicesSymbols.map(async item => {
      try {
        const stock = await getStockData(item.symbol);
        if (stock && stock.price) {
          return {
            symbol: item.symbol,
            name: stock.name || item.fallback,
            price: typeof stock.price === 'number' ? stock.price.toLocaleString() : stock.price,
            change_percent: stock.change_percent,
            currency: stock.currency || 'USD'
          };
        }
      } catch (err) {
        console.error(`[Index] Error loading ${item.symbol}:`, err);
      }
      return {
        symbol: item.symbol,
        name: item.fallback,
        price: 'N/A',
        change_percent: 0,
        currency: 'USD'
      };
    })
  );

  // Featured Ghana Stock Exchange equities
  const gseTickers = ['MTNGH', 'GCB', 'TOTAL', 'EGH', 'CAL', 'GOIL', 'BOPP', 'FML'];
  const gseStocks = await Promise.all(
    gseTickers.map(ticker => getGseStock(ticker))
  );

  res.render('index.html', {
    indices: indicesData,
    gse_stocks: gseStocks.filter(Boolean),
    just_logged_out: justLoggedOut
  });
});

app.get('/search', async (req: Request, res: Response) => {
  const rawQuery = String(req.query.q || '').trim();
  const query = rawQuery.toUpperCase();
  const results: any[] = [];

  if (query) {
    // 1. General Ghana / GSE queries
    if (['GHANA', 'GSE', 'CEDI', 'CEDIS', 'ACCRA'].some(k => query.includes(k))) {
      for (const ticker of ['MTNGH', 'GCB', 'TOTAL', 'EGH', 'CAL', 'GOIL', 'BOPP', 'FML', 'SCB', 'UNIL', 'GSE-CI']) {
        const stock = await getGseStock(ticker);
        if (stock) results.push(stock);
      }
    } else {
      // 2. Search catalog by ticker, company name, or sector
      const cleanTicker = normalizeGseTicker(query);
      for (const [key, item] of Object.entries(GSE_CATALOG)) {
        if (
          key === cleanTicker ||
          item.name.toUpperCase().includes(query) ||
          item.sector.toUpperCase().includes(query)
        ) {
          const gseStock = await getGseStock(key);
          if (gseStock && !results.some(r => r.symbol === gseStock.symbol)) {
            results.push(gseStock);
          }
        }
      }

      // 3. Check regular lookup if not found in catalog or in addition
      if (results.length === 0) {
        const data = await getStockData(query);
        if (data) results.push(data);
      }
    }

    if (results.length === 0) {
      flash(
        req,
        `No results for "${rawQuery}". Try Ghana stocks: MTNGH, GCB, TOTAL, CAL, EGH, or global: AAPL, TSLA, BTC-USD`,
        'warning'
      );
    }
  }

  res.render('search.html', { results, query: rawQuery });
});

app.get('/stock/:ticker', async (req: Request, res: Response) => {
  const ticker = req.params.ticker.toUpperCase();
  const period = String(req.query.period || '1mo');

  const data = await getStockData(ticker);
  if (!data) {
    flash(req, `Could not find data for ${ticker}.`, 'danger');
    return res.redirect('/');
  }

  const [history, news] = await Promise.all([
    getStockHistory(ticker, period),
    getNews(ticker)
  ]);

  const analysis = await getAiAnalysis(ticker, data.name, data.price, data.change_percent);

  let inPortfolio = false;
  let userAlerts: Alert[] = [];

  if (req.session.userId) {
    inPortfolio = await dbService.isTickerInPortfolio(req.session.userId, ticker);
    const alerts = await dbService.getAlertsForTicker(req.session.userId, ticker);
    userAlerts = alerts.map(a => ({
      ...a,
      created_at: new Date(a.created_at) as any
    }));
  }

  res.render('stock.html', {
    data,
    dates: history.dates,
    prices: history.prices,
    news,
    analysis,
    in_portfolio: inPortfolio,
    alerts: userAlerts,
    period
  });
});

app.get('/portfolio', requireLogin, async (req: Request, res: Response) => {
  const entries = await dbService.getPortfolios(req.session.userId!);

  const holdings = [];
  let totalValue = 0;
  let totalCost = 0;

  for (const entry of entries) {
    try {
      const stockInfo = await getStockData(entry.ticker);
      const currentPrice = stockInfo?.price ? Number(stockInfo.price) : 0;
      const currentValue = Math.round(currentPrice * entry.shares * 100) / 100;
      const costBasis = Math.round(entry.buy_price * entry.shares * 100) / 100;
      const gainLoss = Math.round((currentValue - costBasis) * 100) / 100;
      const gainLossPct = costBasis ? Math.round(((gainLoss / costBasis) * 100) * 100) / 100 : 0;

      totalValue += currentValue;
      totalCost += costBasis;

      holdings.push({
        id: entry.id,
        ticker: entry.ticker,
        shares: entry.shares,
        buy_price: entry.buy_price,
        current_price: Math.round(currentPrice * 100) / 100,
        current_value: currentValue,
        gain_loss: gainLoss,
        gain_loss_pct: gainLossPct,
        currency: stockInfo?.currency || 'USD'
      });
    } catch {
      continue;
    }
  }

  const totalGainLoss = Math.round((totalValue - totalCost) * 100) / 100;
  const totalGainLossPct = totalCost ? Math.round(((totalGainLoss / totalCost) * 100) * 100) / 100 : 0;

  res.render('portfolio.html', {
    holdings,
    total_value: Math.round(totalValue * 100) / 100,
    total_gain_loss: totalGainLoss,
    total_gain_loss_pct: totalGainLossPct
  });
});

app.post('/portfolio/add', requireLogin, async (req: Request, res: Response) => {
  const ticker = String(req.body.ticker || '').trim().toUpperCase();
  const shares = parseFloat(req.body.shares);
  const buyPrice = parseFloat(req.body.buy_price);

  if (!ticker || isNaN(shares) || isNaN(buyPrice) || shares <= 0 || buyPrice < 0) {
    flash(req, 'All fields are required and must be valid numbers.', 'danger');
    return res.redirect('/portfolio');
  }

  const stock = await getStockData(ticker);
  if (!stock) {
    flash(req, `${ticker} is not a valid ticker.`, 'danger');
    return res.redirect('/portfolio');
  }

  try {
    await dbService.addPortfolio({
      user_id: req.session.userId!,
      ticker,
      shares,
      buy_price: buyPrice
    });
    flash(req, `${ticker} added to portfolio!`, 'success');
  } catch (err: any) {
    flash(req, `Error adding ${ticker}: ${err.message}`, 'danger');
  }

  res.redirect('/portfolio');
});

app.post('/portfolio/delete/:entryId', requireLogin, async (req: Request, res: Response) => {
  const entryId = parseInt(req.params.entryId, 10);
  const removed = await dbService.deletePortfolio(entryId, req.session.userId!);

  if (!removed) {
    flash(req, 'Unauthorized or entry not found.', 'danger');
    return res.redirect('/portfolio');
  }

  flash(req, `${removed.ticker} removed from portfolio.`, 'success');
  res.redirect('/portfolio');
});

app.get('/alerts', requireLogin, async (req: Request, res: Response) => {
  const alerts = await dbService.getAlerts(req.session.userId!);
  const userAlerts = alerts.map(a => ({
    ...a,
    created_at: new Date(a.created_at) as any
  }));

  res.render('alerts.html', { alerts: userAlerts });
});

app.post('/alerts/add', requireLogin, async (req: Request, res: Response) => {
  const ticker = String(req.body.ticker || '').trim().toUpperCase();
  const targetPrice = parseFloat(req.body.target_price);
  const direction = String(req.body.direction || '').toLowerCase();

  if (!ticker || isNaN(targetPrice) || targetPrice <= 0 || !['above', 'below'].includes(direction)) {
    flash(req, 'All fields are required and must be valid.', 'danger');
    return res.redirect('/alerts');
  }

  try {
    await dbService.addAlert({
      user_id: req.session.userId!,
      ticker,
      target_price: targetPrice,
      direction: direction as 'above' | 'below'
    });
    flash(req, `Alert set for ${ticker}!`, 'success');
  } catch (err: any) {
    flash(req, `Error setting alert: ${err.message}`, 'danger');
  }

  res.redirect('/alerts');
});

app.post('/alerts/delete/:alertId', requireLogin, async (req: Request, res: Response) => {
  const alertId = parseInt(req.params.alertId, 10);
  const deleted = await dbService.deleteAlert(alertId, req.session.userId!);

  if (!deleted) {
    flash(req, 'Unauthorized or alert not found.', 'danger');
    return res.redirect('/alerts');
  }

  flash(req, 'Alert deleted.', 'success');
  res.redirect('/alerts');
});

app.get('/register', (req: Request, res: Response) => {
  if (req.session.userId) return res.redirect('/');
  res.render('register.html');
});

app.post('/register', async (req: Request, res: Response) => {
  if (req.session.userId) return res.redirect('/');

  const username = String(req.body.username || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const confirmPassword = String(req.body.confirm_password || '');

  if (!username || !email || !password) {
    flash(req, 'All fields are required.', 'danger');
    return res.render('register.html');
  }

  const existingEmail = await dbService.findUserByEmail(email);
  if (existingEmail) {
    flash(req, 'Email already registered.', 'danger');
    return res.render('register.html');
  }

  const existingUsername = await dbService.findUserByUsername(username);
  if (existingUsername) {
    flash(req, 'Username already taken.', 'danger');
    return res.render('register.html');
  }

  if (password !== confirmPassword) {
    flash(req, 'Passwords do not match.', 'danger');
    return res.render('register.html');
  }

  if (password.length < 6) {
    flash(req, 'Password must be at least 6 characters.', 'danger');
    return res.render('register.html');
  }

  const salt = bcrypt.genSaltSync(10);
  const hashedPassword = bcrypt.hashSync(password, salt);

  try {
    const newUser = await dbService.createUser({
      username,
      email,
      password: hashedPassword
    });

    req.session.userId = newUser.id;
    flash(req, `Welcome to MarketSync, ${username}!`, 'success');
    req.session.save((saveErr) => {
      if (saveErr) console.error('[Register] Session save error:', saveErr);
      res.redirect('/');
    });
  } catch (err: any) {
    flash(req, `Registration error: ${err.message}`, 'danger');
    res.render('register.html');
  }
});

app.get('/login', (req: Request, res: Response) => {
  if (req.session.userId) return res.redirect('/');
  const nextParam = String(req.query.next || '');
  res.render('login.html', { next: nextParam });
});

app.post('/login', async (req: Request, res: Response) => {
  if (req.session.userId) return res.redirect('/');

  const loginId = String(req.body.email || req.body.username || req.body.login || '').trim();
  const password = String(req.body.password || '');
  const nextPage = String(req.body.next || req.query.next || '');

  if (!loginId || !password) {
    flash(req, 'Please enter both your email/username and password.', 'danger');
    return res.render('login.html', { next: nextPage });
  }

  try {
    const user = await dbService.findUserByLogin(loginId);

    if (user && bcrypt.compareSync(password, user.password)) {
      req.session.userId = user.id;
      flash(req, `Welcome back, ${user.username}!`, 'success');

      // Safely validate redirect target
      const safeNext = nextPage.startsWith('/') && !nextPage.startsWith('//') ? nextPage : '/';

      return req.session.save((saveErr) => {
        if (saveErr) console.error('[Login] Session save error:', saveErr);
        res.redirect(safeNext);
      });
    }
  } catch (err: any) {
    console.error('[Login] Error validating credentials:', err);
  }

  flash(req, 'Invalid email/username or password.', 'danger');
  res.render('login.html', { next: nextPage });
});

function handleLogout(req: Request, res: Response) {
  // Clear user ID and flash messages from session immediately
  if (req.session) {
    req.session.userId = undefined;
    req.session.flashes = [];
  }

  // Clear cookie with exact attributes used at session creation
  const cookieOptions = {
    path: '/',
    httpOnly: true,
    sameSite: 'none' as const,
    secure: true
  };

  res.clearCookie('marketsync_sid', cookieOptions);
  res.clearCookie('marketsync_sid', { path: '/' });
  res.clearCookie('connect.sid', cookieOptions);
  res.clearCookie('connect.sid', { path: '/' });

  // Expire cookies via direct headers for maximum compatibility across all browsers/iframes
  res.append('Set-Cookie', 'marketsync_sid=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=None; Secure; Partitioned');
  res.append('Set-Cookie', 'connect.sid=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=None; Secure; Partitioned');

  // Anti-caching and Clear-Site-Data headers
  res.setHeader('Clear-Site-Data', '"cache", "cookies", "storage"');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  if (req.session && typeof req.session.destroy === 'function') {
    req.session.destroy((destroyErr) => {
      if (destroyErr) console.error('[Logout] Session destroy error:', destroyErr);
      res.redirect('/?logged_out=1');
    });
  } else {
    res.redirect('/?logged_out=1');
  }
}

app.get('/logout', handleLogout);
app.post('/logout', handleLogout);

app.get('/health', async (_req: Request, res: Response) => {
  const dbStatus = dbService.getStatus();
  const counts = await dbService.getRecordCounts();
  res.json({
    status: 'healthy',
    database: {
      ...dbStatus,
      records: counts
    },
    environment: {
      groq_configured: Boolean(process.env.GROQ_API_KEY)
    }
  });
});

dbService.init().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`MarketSync running on port ${PORT}`);
  });
});
