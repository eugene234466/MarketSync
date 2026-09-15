import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import session from 'express-session';
import cookieParser from 'cookie-parser';
import nunjucks from 'nunjucks';
import bcrypt from 'bcryptjs';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

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

// ── PERSISTENT DATA STORAGE ──────────────────────────────────────────────────

interface User {
  id: number;
  username: string;
  email: string;
  password: string;
  created_at: string;
}

interface Portfolio {
  id: number;
  user_id: number;
  ticker: string;
  shares: number;
  buy_price: number;
  added_at: string;
}

interface Alert {
  id: number;
  user_id: number;
  ticker: string;
  target_price: number;
  direction: 'above' | 'below';
  active: boolean;
  created_at: string;
}

interface DatabaseSchema {
  users: User[];
  portfolios: Portfolio[];
  alerts: Alert[];
  nextUserId: number;
  nextPortfolioId: number;
  nextAlertId: number;
}

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'marketsync.json');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadDb(): DatabaseSchema {
  try {
    if (fs.existsSync(DB_FILE)) {
      const content = fs.readFileSync(DB_FILE, 'utf-8');
      return JSON.parse(content);
    }
  } catch (err) {
    console.error('Error loading database file:', err);
  }
  const initial: DatabaseSchema = {
    users: [],
    portfolios: [],
    alerts: [],
    nextUserId: 1,
    nextPortfolioId: 1,
    nextAlertId: 1
  };
  saveDb(initial);
  return initial;
}

function saveDb(db: DatabaseSchema): void {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf-8');
  } catch (err) {
    console.error('Error saving database file:', err);
  }
}

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

async function getGseStock(ticker: string) {
  ticker = ticker.toUpperCase();
  const cacheKey = `GSE:${ticker}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  try {
    const url = `https://dev.kwayisi.org/apis/gse/equities/${ticker}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(6000)
    });
    if (!res.ok) return null;
    const data = await res.json();
    const price = parseNumber(data.price) || 0;
    const change_pct = parseNumber(data.change) || 0;
    const change = Math.round(price * change_pct * 100) / 10000;
    const prev = change ? Math.round((price - change) * 10000) / 10000 : price;

    const result = {
      symbol: cacheKey,
      name: data.name || ticker,
      price: Math.round(price * 10000) / 10000,
      prev_close: prev,
      change,
      change_percent: Math.round(change_pct * 100) / 100,
      volume: data.volume ?? null,
      market_cap: null,
      high_52: null,
      low_52: null,
      pe_ratio: null,
      dividend: null,
      currency: 'GHS',
      exchange: 'Ghana Stock Exchange'
    };
    setCached(cacheKey, result);
    return result;
  } catch (err) {
    console.error(`[GSE] Error fetching ${ticker}:`, err);
    return null;
  }
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

async function getStockData(ticker: string) {
  ticker = ticker.trim().toUpperCase();

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
    return null;
  }
}

async function getStockHistory(ticker: string, period = '1mo'): Promise<{ dates: string[]; prices: number[] }> {
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
  const currency = ticker.startsWith('GSE:')
    ? 'GHS'
    : ticker.startsWith('NGX:')
    ? 'NGN'
    : ticker.startsWith('BRVM:')
    ? 'XOF'
    : 'USD';

  // If GROQ_API_KEY is available, use Groq
  if (process.env.GROQ_API_KEY) {
    try {
      const prompt = `You are a financial analyst. Give a brief analysis of ${name} (${ticker}). Current price: ${currency} ${price}. Change today: ${changePct.toFixed(2)}%. Cover: current trend, key factors affecting price, and short-term outlook. Keep it concise, clear and under 150 words.`;
      
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
    const db = loadDb();
    let updated = false;
    for (const alert of db.alerts) {
      if (!alert.active) continue;
      const stock = await getStockData(alert.ticker);
      if (!stock || !stock.price) continue;
      const triggered =
        (alert.direction === 'above' && stock.price >= alert.target_price) ||
        (alert.direction === 'below' && stock.price <= alert.target_price);
      if (triggered) {
        alert.active = false;
        updated = true;
      }
    }
    if (updated) {
      saveDb(db);
    }
  } catch (err) {
    console.error('Error checking alerts:', err);
  }
}

setInterval(checkAlerts, 15 * 60 * 1000);

// ── EXPRESS APPLICATION SETUP ────────────────────────────────────────────────

const app = express();
const PORT = 3000;

// Flash message type declaration
declare module 'express-session' {
  interface SessionData {
    userId?: number;
    flashes?: Array<[string, string]>;
  }
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(
  session({
    secret: process.env.SECRET_KEY || 'dev_key_123',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 }
  }) as any
);

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

env.addFilter('tojson', (val: any) => JSON.stringify(val));
env.addFilter('upper', (val: any) => String(val ?? '').toUpperCase());

// Attach current user & flash retriever per request
app.use((req: Request, res: Response, next: NextFunction) => {
  const db = loadDb();
  const userId = req.session.userId;
  const user = userId ? db.users.find(u => u.id === userId) : null;

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

app.get('/', async (_req: Request, res: Response) => {
  const indicesSymbols = [
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
            change_percent: stock.change_percent
          };
        }
      } catch (err) {
        console.error(`[Index] Error loading ${item.symbol}:`, err);
      }
      return {
        symbol: item.symbol,
        name: item.fallback,
        price: 'N/A',
        change_percent: 0
      };
    })
  );

  res.render('index.html', { indices: indicesData });
});

app.get('/search', async (req: Request, res: Response) => {
  const query = String(req.query.q || '').trim().toUpperCase();
  const results: any[] = [];

  if (query) {
    const data = await getStockData(query);
    if (data) {
      results.push(data);
    } else {
      if (query.includes(':') && AFRICAN_EXCHANGES[query.split(':')[0]]) {
        flash(
          req,
          `Could not find ${query}. Check the ticker — e.g. GSE:MTNGH, NGX:DANGCEM, BRVM:SNTS`,
          'danger'
        );
      } else {
        flash(
          req,
          `No results for "${query}". Try: AAPL, TSLA, BTC-USD. For West Africa use: GSE:MTNGH, NGX:DANGCEM, BRVM:SNTS`,
          'warning'
        );
      }
    }
  }

  res.render('search.html', { results, query });
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
    const db = loadDb();
    inPortfolio = db.portfolios.some(p => p.user_id === req.session.userId && p.ticker === ticker);
    userAlerts = db.alerts
      .filter(a => a.user_id === req.session.userId && a.ticker === ticker)
      .map(a => ({
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
  const db = loadDb();
  const entries = db.portfolios.filter(p => p.user_id === req.session.userId);

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
        gain_loss_pct: gainLossPct
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
    const db = loadDb();
    const newEntry: Portfolio = {
      id: db.nextPortfolioId++,
      user_id: req.session.userId!,
      ticker,
      shares,
      buy_price: buyPrice,
      added_at: new Date().toISOString()
    };
    db.portfolios.push(newEntry);
    saveDb(db);
    flash(req, `${ticker} added to portfolio!`, 'success');
  } catch (err: any) {
    flash(req, `Error adding ${ticker}: ${err.message}`, 'danger');
  }

  res.redirect('/portfolio');
});

app.post('/portfolio/delete/:entryId', requireLogin, (req: Request, res: Response) => {
  const entryId = parseInt(req.params.entryId, 10);
  const db = loadDb();
  const index = db.portfolios.findIndex(p => p.id === entryId);

  if (index === -1 || db.portfolios[index].user_id !== req.session.userId) {
    flash(req, 'Unauthorized or entry not found.', 'danger');
    return res.redirect('/portfolio');
  }

  const [removed] = db.portfolios.splice(index, 1);
  saveDb(db);
  flash(req, `${removed.ticker} removed from portfolio.`, 'success');
  res.redirect('/portfolio');
});

app.get('/alerts', requireLogin, (req: Request, res: Response) => {
  const db = loadDb();
  const userAlerts = db.alerts
    .filter(a => a.user_id === req.session.userId)
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .map(a => ({
      ...a,
      created_at: new Date(a.created_at) as any
    }));

  res.render('alerts.html', { alerts: userAlerts });
});

app.post('/alerts/add', requireLogin, (req: Request, res: Response) => {
  const ticker = String(req.body.ticker || '').trim().toUpperCase();
  const targetPrice = parseFloat(req.body.target_price);
  const direction = String(req.body.direction || '').toLowerCase();

  if (!ticker || isNaN(targetPrice) || targetPrice <= 0 || !['above', 'below'].includes(direction)) {
    flash(req, 'All fields are required and must be valid.', 'danger');
    return res.redirect('/alerts');
  }

  try {
    const db = loadDb();
    const newAlert: Alert = {
      id: db.nextAlertId++,
      user_id: req.session.userId!,
      ticker,
      target_price: targetPrice,
      direction: direction as 'above' | 'below',
      active: true,
      created_at: new Date().toISOString()
    };
    db.alerts.push(newAlert);
    saveDb(db);
    flash(req, `Alert set for ${ticker}!`, 'success');
  } catch (err: any) {
    flash(req, `Error setting alert: ${err.message}`, 'danger');
  }

  res.redirect('/alerts');
});

app.post('/alerts/delete/:alertId', requireLogin, (req: Request, res: Response) => {
  const alertId = parseInt(req.params.alertId, 10);
  const db = loadDb();
  const index = db.alerts.findIndex(a => a.id === alertId);

  if (index === -1 || db.alerts[index].user_id !== req.session.userId) {
    flash(req, 'Unauthorized or alert not found.', 'danger');
    return res.redirect('/alerts');
  }

  db.alerts.splice(index, 1);
  saveDb(db);
  flash(req, 'Alert deleted.', 'success');
  res.redirect('/alerts');
});

app.get('/register', (req: Request, res: Response) => {
  if (req.session.userId) return res.redirect('/');
  res.render('register.html');
});

app.post('/register', (req: Request, res: Response) => {
  if (req.session.userId) return res.redirect('/');

  const username = String(req.body.username || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const confirmPassword = String(req.body.confirm_password || '');

  const db = loadDb();

  if (!username || !email || !password) {
    flash(req, 'All fields are required.', 'danger');
    return res.render('register.html');
  }

  if (db.users.some(u => u.email === email)) {
    flash(req, 'Email already registered.', 'danger');
    return res.render('register.html');
  }

  if (db.users.some(u => u.username.toLowerCase() === username.toLowerCase())) {
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

  const newUser: User = {
    id: db.nextUserId++,
    username,
    email,
    password: hashedPassword,
    created_at: new Date().toISOString()
  };

  db.users.push(newUser);
  saveDb(db);

  req.session.userId = newUser.id;
  flash(req, `Welcome to MarketSync, ${username}!`, 'success');
  res.redirect('/');
});

app.get('/login', (req: Request, res: Response) => {
  if (req.session.userId) return res.redirect('/');
  res.render('login.html');
});

app.post('/login', (req: Request, res: Response) => {
  if (req.session.userId) return res.redirect('/');

  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');

  const db = loadDb();
  const user = db.users.find(u => u.email === email);

  if (user && bcrypt.compareSync(password, user.password)) {
    req.session.userId = user.id;
    flash(req, `Welcome back, ${user.username}!`, 'success');
    const nextPage = String(req.query.next || '');
    return res.redirect(nextPage.startsWith('/') ? nextPage : '/');
  }

  flash(req, 'Invalid email or password.', 'danger');
  res.render('login.html');
});

app.get('/logout', (req: Request, res: Response) => {
  req.session.destroy(() => {
    res.redirect('/');
  });
});

app.get('/health', (req: Request, res: Response) => {
  const db = loadDb();
  res.json({
    status: 'healthy',
    database: {
      connected: true,
      type: 'json_store',
      records: {
        users: db.users.length,
        portfolios: db.portfolios.length,
        alerts: db.alerts.length
      }
    },
    environment: {
      groq_configured: Boolean(process.env.GROQ_API_KEY)
    }
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`MarketSync running on port ${PORT}`);
});
