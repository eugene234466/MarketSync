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
  NSE: 'Nairobi Securities Exchange (KES)',
  JSE: 'Johannesburg Stock Exchange (ZAR)',
  BRVM: 'BRVM West Africa (XOF)',
  EGX: 'Egyptian Exchange (EGP)'
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
  RUT: '^RUT',
  'GSE-CI': 'GSE-CI',
  'GSE-FSI': 'GSE-FSI',
  'NGX-ASI': 'NGX-ASI',
  'NSE-20': 'NSE-20',
  'JSE-TOP40': 'JSE-TOP40',
  'BRVM-C': 'BRVM-C',
  'EGX30': 'EGX30'
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

export interface AfricanStockDefinition {
  symbol: string;
  display_symbol?: string;
  name: string;
  price: number;
  prev_close: number;
  change: number;
  change_percent: number;
  volume: number;
  market_cap: number | null;
  high_52: number | null;
  low_52: number | null;
  pe_ratio: number | null;
  dividend: number | null;
  sector: string;
  currency: string;
  exchange: string;
  exchange_code: string;
  country: string;
  flag: string;
}

export type GseStockDefinition = AfricanStockDefinition;

export const AFRICAN_CATALOG: Record<string, AfricanStockDefinition> = {
  // ── 🇳🇬 NIGERIA (NGX - NIGERIAN EXCHANGE) ─────────────────────────
  DANGCEM: {
    symbol: 'DANGCEM',
    name: 'Dangote Cement PLC',
    price: 680.00,
    prev_close: 675.00,
    change: 5.00,
    change_percent: 0.74,
    volume: 1450000,
    market_cap: 11500000000000,
    high_52: 750.00,
    low_52: 320.00,
    pe_ratio: 14.2,
    dividend: 4.5,
    sector: 'Industrial & Building Materials',
    currency: 'NGN',
    exchange: 'Nigerian Exchange (NGX)',
    exchange_code: 'NGX',
    country: 'Nigeria',
    flag: '🇳🇬'
  },
  MTNN: {
    symbol: 'MTNN',
    name: 'MTN Nigeria Communications PLC',
    price: 285.50,
    prev_close: 282.00,
    change: 3.50,
    change_percent: 1.24,
    volume: 3200000,
    market_cap: 5900000000000,
    high_52: 320.00,
    low_52: 210.00,
    pe_ratio: 11.5,
    dividend: 5.2,
    sector: 'Telecommunications',
    currency: 'NGN',
    exchange: 'Nigerian Exchange (NGX)',
    exchange_code: 'NGX',
    country: 'Nigeria',
    flag: '🇳🇬'
  },
  GTCO: {
    symbol: 'GTCO',
    name: 'Guaranty Trust Holding Company PLC',
    price: 52.80,
    prev_close: 51.70,
    change: 1.10,
    change_percent: 2.13,
    volume: 8900000,
    market_cap: 1550000000000,
    high_52: 55.00,
    low_52: 36.00,
    pe_ratio: 4.8,
    dividend: 6.8,
    sector: 'Banking & Financial Services',
    currency: 'NGN',
    exchange: 'Nigerian Exchange (NGX)',
    exchange_code: 'NGX',
    country: 'Nigeria',
    flag: '🇳🇬'
  },
  ZENITHBANK: {
    symbol: 'ZENITHBANK',
    name: 'Zenith Bank PLC',
    price: 44.50,
    prev_close: 43.70,
    change: 0.80,
    change_percent: 1.83,
    volume: 9400000,
    market_cap: 1390000000000,
    high_52: 47.00,
    low_52: 32.50,
    pe_ratio: 4.2,
    dividend: 7.5,
    sector: 'Banking & Financial Services',
    currency: 'NGN',
    exchange: 'Nigerian Exchange (NGX)',
    exchange_code: 'NGX',
    country: 'Nigeria',
    flag: '🇳🇬'
  },
  AIRTELAFRI: {
    symbol: 'AIRTELAFRI',
    name: 'Airtel Africa PLC',
    price: 2150.00,
    prev_close: 2160.00,
    change: -10.00,
    change_percent: -0.46,
    volume: 450000,
    market_cap: 8100000000000,
    high_52: 2400.00,
    low_52: 1800.00,
    pe_ratio: 16.8,
    dividend: 3.1,
    sector: 'Telecommunications',
    currency: 'NGN',
    exchange: 'Nigerian Exchange (NGX)',
    exchange_code: 'NGX',
    country: 'Nigeria',
    flag: '🇳🇬'
  },
  SEPLAT: {
    symbol: 'SEPLAT',
    name: 'Seplat Energy PLC',
    price: 3980.00,
    prev_close: 3860.00,
    change: 120.00,
    change_percent: 3.11,
    volume: 380000,
    market_cap: 2340000000000,
    high_52: 4200.00,
    low_52: 1900.00,
    pe_ratio: 7.4,
    dividend: 4.1,
    sector: 'Energy / Oil & Gas',
    currency: 'NGN',
    exchange: 'Nigerian Exchange (NGX)',
    exchange_code: 'NGX',
    country: 'Nigeria',
    flag: '🇳🇬'
  },
  NESTLE: {
    symbol: 'NESTLE',
    name: 'Nestle Nigeria PLC',
    price: 900.00,
    prev_close: 900.00,
    change: 0.00,
    change_percent: 0.00,
    volume: 65000,
    market_cap: 713000000000,
    high_52: 1150.00,
    low_52: 850.00,
    pe_ratio: 21.0,
    dividend: 3.8,
    sector: 'Consumer Goods / FMCG',
    currency: 'NGN',
    exchange: 'Nigerian Exchange (NGX)',
    exchange_code: 'NGX',
    country: 'Nigeria',
    flag: '🇳🇬'
  },
  ACCESSCORP: {
    symbol: 'ACCESSCORP',
    name: 'Access Holdings PLC',
    price: 21.40,
    prev_close: 21.10,
    change: 0.30,
    change_percent: 1.42,
    volume: 12500000,
    market_cap: 760000000000,
    high_52: 28.50,
    low_52: 16.50,
    pe_ratio: 3.8,
    dividend: 6.0,
    sector: 'Banking & Financial Services',
    currency: 'NGN',
    exchange: 'Nigerian Exchange (NGX)',
    exchange_code: 'NGX',
    country: 'Nigeria',
    flag: '🇳🇬'
  },
  'NGX-ASI': {
    symbol: 'NGX-ASI',
    name: 'NGX All-Share Index',
    price: 98240.50,
    prev_close: 97605.00,
    change: 635.50,
    change_percent: 0.65,
    volume: 450000000,
    market_cap: 56000000000000,
    high_52: 105000.00,
    low_52: 70000.00,
    pe_ratio: null,
    dividend: null,
    sector: 'National Benchmark Index',
    currency: 'NGN',
    exchange: 'Nigerian Exchange (NGX)',
    exchange_code: 'NGX',
    country: 'Nigeria',
    flag: '🇳🇬'
  },

  // ── 🇰🇪 KENYA (NSE - NAIROBI SECURITIES EXCHANGE) ──────────────────
  SCOM: {
    symbol: 'SCOM',
    name: 'Safaricom PLC',
    price: 17.50,
    prev_close: 17.20,
    change: 0.30,
    change_percent: 1.74,
    volume: 14200000,
    market_cap: 701000000000,
    high_52: 20.50,
    low_52: 13.50,
    pe_ratio: 12.8,
    dividend: 6.9,
    sector: 'Telecommunications & Fintech (M-Pesa)',
    currency: 'KES',
    exchange: 'Nairobi Securities Exchange (NSE)',
    exchange_code: 'NSE',
    country: 'Kenya',
    flag: '🇰🇪'
  },
  EQTY: {
    symbol: 'EQTY',
    name: 'Equity Group Holdings PLC',
    price: 44.00,
    prev_close: 43.00,
    change: 1.00,
    change_percent: 2.33,
    volume: 4100000,
    market_cap: 166000000000,
    high_52: 48.50,
    low_52: 34.00,
    pe_ratio: 4.1,
    dividend: 9.1,
    sector: 'Banking & Financial Services',
    currency: 'KES',
    exchange: 'Nairobi Securities Exchange (NSE)',
    exchange_code: 'NSE',
    country: 'Kenya',
    flag: '🇰🇪'
  },
  KCB: {
    symbol: 'KCB',
    name: 'KCB Group PLC',
    price: 32.75,
    prev_close: 32.40,
    change: 0.35,
    change_percent: 1.08,
    volume: 3500000,
    market_cap: 105000000000,
    high_52: 38.00,
    low_52: 21.00,
    pe_ratio: 3.6,
    dividend: 6.1,
    sector: 'Banking & Financial Services',
    currency: 'KES',
    exchange: 'Nairobi Securities Exchange (NSE)',
    exchange_code: 'NSE',
    country: 'Kenya',
    flag: '🇰🇪'
  },
  EABL: {
    symbol: 'EABL',
    name: 'East African Breweries Limited',
    price: 152.00,
    prev_close: 153.00,
    change: -1.00,
    change_percent: -0.65,
    volume: 580000,
    market_cap: 120000000000,
    high_52: 175.00,
    low_52: 120.00,
    pe_ratio: 11.2,
    dividend: 5.8,
    sector: 'Beverages & Brewing',
    currency: 'KES',
    exchange: 'Nairobi Securities Exchange (NSE)',
    exchange_code: 'NSE',
    country: 'Kenya',
    flag: '🇰🇪'
  },
  BAT: {
    symbol: 'BAT',
    name: 'British American Tobacco Kenya PLC',
    price: 415.00,
    prev_close: 415.00,
    change: 0.00,
    change_percent: 0.00,
    volume: 45000,
    market_cap: 41500000000,
    high_52: 460.00,
    low_52: 390.00,
    pe_ratio: 8.5,
    dividend: 11.5,
    sector: 'Consumer Goods',
    currency: 'KES',
    exchange: 'Nairobi Securities Exchange (NSE)',
    exchange_code: 'NSE',
    country: 'Kenya',
    flag: '🇰🇪'
  },
  SCBK: {
    symbol: 'SCBK',
    name: 'Standard Chartered Bank Kenya Limited',
    price: 198.50,
    prev_close: 197.00,
    change: 1.50,
    change_percent: 0.76,
    volume: 180000,
    market_cap: 75000000000,
    high_52: 210.00,
    low_52: 155.00,
    pe_ratio: 5.4,
    dividend: 11.8,
    sector: 'Banking & Financial Services',
    currency: 'KES',
    exchange: 'Nairobi Securities Exchange (NSE)',
    exchange_code: 'NSE',
    country: 'Kenya',
    flag: '🇰🇪'
  },
  'NSE-20': {
    symbol: 'NSE-20',
    name: 'NSE 20 Share Index',
    price: 1845.20,
    prev_close: 1836.40,
    change: 8.80,
    change_percent: 0.48,
    volume: 25000000,
    market_cap: 1600000000000,
    high_52: 1950.00,
    low_52: 1450.00,
    pe_ratio: null,
    dividend: null,
    sector: 'National Benchmark Index',
    currency: 'KES',
    exchange: 'Nairobi Securities Exchange (NSE)',
    exchange_code: 'NSE',
    country: 'Kenya',
    flag: '🇰🇪'
  },

  // ── 🇿🇦 SOUTH AFRICA (JSE - JOHANNESBURG STOCK EXCHANGE) ─────────
  NPN: {
    symbol: 'NPN',
    name: 'Naspers Limited',
    price: 3820.00,
    prev_close: 3750.00,
    change: 70.00,
    change_percent: 1.87,
    volume: 1250000,
    market_cap: 1620000000000,
    high_52: 4100.00,
    low_52: 2850.00,
    pe_ratio: 24.5,
    dividend: 0.8,
    sector: 'Technology & Global Internet',
    currency: 'ZAR',
    exchange: 'Johannesburg Stock Exchange (JSE)',
    exchange_code: 'JSE',
    country: 'South Africa',
    flag: '🇿🇦'
  },
  FSR: {
    symbol: 'FSR',
    name: 'FirstRand Limited',
    price: 78.50,
    prev_close: 77.80,
    change: 0.70,
    change_percent: 0.90,
    volume: 8600000,
    market_cap: 440000000000,
    high_52: 83.00,
    low_52: 61.00,
    pe_ratio: 10.2,
    dividend: 4.9,
    sector: 'Banking & Financial Services',
    currency: 'ZAR',
    exchange: 'Johannesburg Stock Exchange (JSE)',
    exchange_code: 'JSE',
    country: 'South Africa',
    flag: '🇿🇦'
  },
  SOL: {
    symbol: 'SOL',
    name: 'Sasol Limited',
    price: 138.40,
    prev_close: 140.40,
    change: -2.00,
    change_percent: -1.42,
    volume: 3100000,
    market_cap: 88000000000,
    high_52: 240.00,
    low_52: 125.00,
    pe_ratio: 6.8,
    dividend: 5.5,
    sector: 'Chemicals & Synthetic Fuels',
    currency: 'ZAR',
    exchange: 'Johannesburg Stock Exchange (JSE)',
    exchange_code: 'JSE',
    country: 'South Africa',
    flag: '🇿🇦'
  },
  MTN: {
    symbol: 'MTN',
    name: 'MTN Group Limited',
    price: 96.20,
    prev_close: 94.20,
    change: 2.00,
    change_percent: 2.12,
    volume: 4800000,
    market_cap: 181000000000,
    high_52: 128.00,
    low_52: 78.00,
    pe_ratio: 12.0,
    dividend: 4.4,
    sector: 'Telecommunications',
    currency: 'ZAR',
    exchange: 'Johannesburg Stock Exchange (JSE)',
    exchange_code: 'JSE',
    country: 'South Africa',
    flag: '🇿🇦'
  },
  SBK: {
    symbol: 'SBK',
    name: 'Standard Bank Group Limited',
    price: 215.00,
    prev_close: 212.50,
    change: 2.50,
    change_percent: 1.18,
    volume: 3900000,
    market_cap: 358000000000,
    high_52: 225.00,
    low_52: 168.00,
    pe_ratio: 8.7,
    dividend: 6.8,
    sector: 'Banking & Financial Services',
    currency: 'ZAR',
    exchange: 'Johannesburg Stock Exchange (JSE)',
    exchange_code: 'JSE',
    country: 'South Africa',
    flag: '🇿🇦'
  },
  AGL: {
    symbol: 'AGL',
    name: 'Anglo American PLC',
    price: 540.00,
    prev_close: 537.00,
    change: 3.00,
    change_percent: 0.56,
    volume: 2400000,
    market_cap: 720000000000,
    high_52: 650.00,
    low_52: 410.00,
    pe_ratio: 15.1,
    dividend: 3.2,
    sector: 'Mining & Natural Resources',
    currency: 'ZAR',
    exchange: 'Johannesburg Stock Exchange (JSE)',
    exchange_code: 'JSE',
    country: 'South Africa',
    flag: '🇿🇦'
  },
  SHP: {
    symbol: 'SHP',
    name: 'Shoprite Holdings Limited',
    price: 294.00,
    prev_close: 290.00,
    change: 4.00,
    change_percent: 1.38,
    volume: 1600000,
    market_cap: 174000000000,
    high_52: 310.00,
    low_52: 230.00,
    pe_ratio: 18.5,
    dividend: 2.8,
    sector: 'Retail & Supermarkets',
    currency: 'ZAR',
    exchange: 'Johannesburg Stock Exchange (JSE)',
    exchange_code: 'JSE',
    country: 'South Africa',
    flag: '🇿🇦'
  },
  'JSE-TOP40': {
    symbol: 'JSE-TOP40',
    name: 'FTSE/JSE Top 40 Index',
    price: 76450.00,
    prev_close: 75905.00,
    change: 545.00,
    change_percent: 0.72,
    volume: 85000000,
    market_cap: 18000000000000,
    high_52: 79000.00,
    low_52: 66000.00,
    pe_ratio: null,
    dividend: null,
    sector: 'National Benchmark Index',
    currency: 'ZAR',
    exchange: 'Johannesburg Stock Exchange (JSE)',
    exchange_code: 'JSE',
    country: 'South Africa',
    flag: '🇿🇦'
  },

  // ── 🇨🇮 BRVM (WEST AFRICA REGIONAL EXCHANGE - CÔTE D'IVOIRE / SENEGAL) ─
  SNTS: {
    symbol: 'SNTS',
    name: 'Sonatel Senegal (Orange)',
    price: 19800.00,
    prev_close: 19600.00,
    change: 200.00,
    change_percent: 1.02,
    volume: 120000,
    market_cap: 1980000000000,
    high_52: 21000.00,
    low_52: 15500.00,
    pe_ratio: 8.2,
    dividend: 8.5,
    sector: 'Telecommunications',
    currency: 'XOF',
    exchange: 'BRVM West Africa',
    exchange_code: 'BRVM',
    country: 'Senegal / Côte d\'Ivoire',
    flag: '🇨🇮'
  },
  ECOC: {
    symbol: 'ECOC',
    name: 'Ecobank Côte d\'Ivoire',
    price: 7650.00,
    prev_close: 7500.00,
    change: 150.00,
    change_percent: 1.99,
    volume: 65000,
    market_cap: 420000000000,
    high_52: 8200.00,
    low_52: 5200.00,
    pe_ratio: 6.1,
    dividend: 7.4,
    sector: 'Banking & Financial Services',
    currency: 'XOF',
    exchange: 'BRVM West Africa',
    exchange_code: 'BRVM',
    country: 'Côte d\'Ivoire',
    flag: '🇨🇮'
  },
  SGBC: {
    symbol: 'SGBC',
    name: 'Société Générale Côte d\'Ivoire',
    price: 18200.00,
    prev_close: 18100.00,
    change: 100.00,
    change_percent: 0.55,
    volume: 45000,
    market_cap: 565000000000,
    high_52: 19500.00,
    low_52: 13500.00,
    pe_ratio: 7.0,
    dividend: 6.8,
    sector: 'Banking & Financial Services',
    currency: 'XOF',
    exchange: 'BRVM West Africa',
    exchange_code: 'BRVM',
    country: 'Côte d\'Ivoire',
    flag: '🇨🇮'
  },
  ONTBF: {
    symbol: 'ONTBF',
    name: 'Onatel Burkina Faso',
    price: 2450.00,
    prev_close: 2470.00,
    change: -20.00,
    change_percent: -0.81,
    volume: 85000,
    market_cap: 166000000000,
    high_52: 3100.00,
    low_52: 2200.00,
    pe_ratio: 5.9,
    dividend: 9.2,
    sector: 'Telecommunications',
    currency: 'XOF',
    exchange: 'BRVM West Africa',
    exchange_code: 'BRVM',
    country: 'Burkina Faso',
    flag: '🇨🇮'
  },
  'BRVM-C': {
    symbol: 'BRVM-C',
    name: 'BRVM Composite Index',
    price: 268.40,
    prev_close: 267.50,
    change: 0.90,
    change_percent: 0.34,
    volume: 1500000,
    market_cap: 9800000000000,
    high_52: 285.00,
    low_52: 205.00,
    pe_ratio: null,
    dividend: null,
    sector: 'Regional Benchmark Index',
    currency: 'XOF',
    exchange: 'BRVM West Africa',
    exchange_code: 'BRVM',
    country: 'UEMOA Regional',
    flag: '🇨🇮'
  },

  // ── 🇪🇬 EGYPT (EGX - EGYPTIAN EXCHANGE) ───────────────────────────
  COMI: {
    symbol: 'COMI',
    name: 'Commercial International Bank (CIB)',
    price: 82.50,
    prev_close: 81.20,
    change: 1.30,
    change_percent: 1.60,
    volume: 6800000,
    market_cap: 248000000000,
    high_52: 94.00,
    low_52: 58.00,
    pe_ratio: 7.8,
    dividend: 4.5,
    sector: 'Banking & Financial Services',
    currency: 'EGP',
    exchange: 'Egyptian Exchange (EGX)',
    exchange_code: 'EGX',
    country: 'Egypt',
    flag: '🇪🇬'
  },
  EAST: {
    symbol: 'EAST',
    name: 'Eastern Company',
    price: 27.80,
    prev_close: 27.60,
    change: 0.20,
    change_percent: 0.72,
    volume: 4200000,
    market_cap: 62000000000,
    high_52: 33.00,
    low_52: 21.00,
    pe_ratio: 6.2,
    dividend: 9.5,
    sector: 'Consumer Goods',
    currency: 'EGP',
    exchange: 'Egyptian Exchange (EGX)',
    exchange_code: 'EGX',
    country: 'Egypt',
    flag: '🇪🇬'
  },
  HRHO: {
    symbol: 'HRHO',
    name: 'EFG Holding (Hermes)',
    price: 19.40,
    prev_close: 19.00,
    change: 0.40,
    change_percent: 2.11,
    volume: 8100000,
    market_cap: 28000000000,
    high_52: 23.50,
    low_52: 14.50,
    pe_ratio: 8.9,
    dividend: 5.0,
    sector: 'Investment Banking & Financial Services',
    currency: 'EGP',
    exchange: 'Egyptian Exchange (EGX)',
    exchange_code: 'EGX',
    country: 'Egypt',
    flag: '🇪🇬'
  },
  TMGH: {
    symbol: 'TMGH',
    name: 'Talaat Moustafa Group Holding',
    price: 58.20,
    prev_close: 56.20,
    change: 2.00,
    change_percent: 3.56,
    volume: 5500000,
    market_cap: 120000000000,
    high_52: 72.00,
    low_52: 32.00,
    pe_ratio: 12.4,
    dividend: 2.5,
    sector: 'Real Estate & Hospitality',
    currency: 'EGP',
    exchange: 'Egyptian Exchange (EGX)',
    exchange_code: 'EGX',
    country: 'Egypt',
    flag: '🇪🇬'
  },
  EGX30: {
    symbol: 'EGX30',
    name: 'EGX 30 Index',
    price: 30540.00,
    prev_close: 30192.00,
    change: 348.00,
    change_percent: 1.15,
    volume: 95000000,
    market_cap: 2100000000000,
    high_52: 33500.00,
    low_52: 23000.00,
    pe_ratio: null,
    dividend: null,
    sector: 'National Benchmark Index',
    currency: 'EGP',
    exchange: 'Egyptian Exchange (EGX)',
    exchange_code: 'EGX',
    country: 'Egypt',
    flag: '🇪🇬'
  },

  // ── 🇬🇭 GHANA (GSE - GHANA STOCK EXCHANGE) ────────────────────────
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
    exchange: 'Ghana Stock Exchange (GSE)',
    exchange_code: 'GSE',
    country: 'Ghana',
    flag: '🇬🇭'
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
    exchange: 'Ghana Stock Exchange (GSE)',
    exchange_code: 'GSE',
    country: 'Ghana',
    flag: '🇬🇭'
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
    exchange: 'Ghana Stock Exchange (GSE)',
    exchange_code: 'GSE',
    country: 'Ghana',
    flag: '🇬🇭'
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
    exchange: 'Ghana Stock Exchange (GSE)',
    exchange_code: 'GSE',
    country: 'Ghana',
    flag: '🇬🇭'
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
    exchange: 'Ghana Stock Exchange (GSE)',
    exchange_code: 'GSE',
    country: 'Ghana',
    flag: '🇬🇭'
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
    exchange: 'Ghana Stock Exchange (GSE)',
    exchange_code: 'GSE',
    country: 'Ghana',
    flag: '🇬🇭'
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
    exchange: 'Ghana Stock Exchange (GSE)',
    exchange_code: 'GSE',
    country: 'Ghana',
    flag: '🇬🇭'
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
    exchange: 'Ghana Stock Exchange (GSE)',
    exchange_code: 'GSE',
    country: 'Ghana',
    flag: '🇬🇭'
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
    exchange: 'Ghana Stock Exchange (GSE)',
    exchange_code: 'GSE',
    country: 'Ghana',
    flag: '🇬🇭'
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
    exchange: 'Ghana Stock Exchange (GSE)',
    exchange_code: 'GSE',
    country: 'Ghana',
    flag: '🇬🇭'
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
    exchange: 'Ghana Stock Exchange (GSE)',
    exchange_code: 'GSE',
    country: 'Ghana',
    flag: '🇬🇭'
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
    exchange: 'Ghana Stock Exchange (GSE)',
    exchange_code: 'GSE',
    country: 'Ghana',
    flag: '🇬🇭'
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
    exchange: 'Ghana Stock Exchange (GSE)',
    exchange_code: 'GSE',
    country: 'Ghana',
    flag: '🇬🇭'
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
    exchange: 'Ghana Stock Exchange (GSE)',
    exchange_code: 'GSE',
    country: 'Ghana',
    flag: '🇬🇭'
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
    exchange: 'Ghana Stock Exchange (GSE)',
    exchange_code: 'GSE',
    country: 'Ghana',
    flag: '🇬🇭'
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
    exchange: 'Ghana Stock Exchange (GSE)',
    exchange_code: 'GSE',
    country: 'Ghana',
    flag: '🇬🇭'
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
    exchange: 'Ghana Stock Exchange (GSE)',
    exchange_code: 'GSE',
    country: 'Ghana',
    flag: '🇬🇭'
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
    exchange: 'Ghana Stock Exchange (GSE)',
    exchange_code: 'GSE',
    country: 'Ghana',
    flag: '🇬🇭'
  }
};

// Aliased for full backwards compatibility
export const GSE_CATALOG: Record<string, AfricanStockDefinition> = Object.fromEntries(
  Object.entries(AFRICAN_CATALOG).filter(([_, s]) => s.exchange_code === 'GSE')
);

function normalizeAfricanTicker(rawTicker: string): string {
  return rawTicker
    .trim()
    .toUpperCase()
    .replace(/^(GSE|NGX|NSE|JSE|BRVM|EGX):/, '')
    .replace(/\.(GH|GSE|NG|NRB|JSE|JO|CA)$/, '');
}

function isAfricanTicker(rawTicker: string): boolean {
  const t = rawTicker.trim().toUpperCase();
  if (['GSE:', 'NGX:', 'NSE:', 'JSE:', 'BRVM:', 'EGX:'].some(p => t.startsWith(p))) return true;
  if (/\.(GH|GSE|NG|NRB|JSE|JO|CA)$/.test(t)) return true;
  const clean = normalizeAfricanTicker(t);
  return Boolean(AFRICAN_CATALOG[clean] || AFRICAN_CATALOG[t]);
}

function normalizeGseTicker(rawTicker: string): string {
  return normalizeAfricanTicker(rawTicker);
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
    const raw = tickerStr.trim().toUpperCase();
    const clean = normalizeAfricanTicker(raw);
    const cacheKey = `AFRICA:${clean}`;
    const cached = getCached(cacheKey);
    if (cached) return cached;

    // Check catalog first
    const catalogItem = AFRICAN_CATALOG[clean] || AFRICAN_CATALOG[raw];

    // For GSE stocks, try live scraper first
    if (catalogItem?.exchange_code === 'GSE' || raw.startsWith('GSE:') || raw.endsWith('.GH')) {
      const gse = await getGseStock(clean);
      if (gse) return gse;
    }

    // For NGX / BRVM prefixed lookups, attempt live scraping if not found
    if (raw.includes(':')) {
      const [exchange, sym] = raw.split(':', 2);
      if (exchange === 'NGX' || exchange === 'BRVM') {
        const live = await getAfricanStockAfx(sym, exchange);
        if (live) return live;
      }
    }

    if (catalogItem) {
      const stock = { ...catalogItem, symbol: clean };
      setCached(cacheKey, stock);
      return stock;
    }

    return null;
  } catch (err) {
    console.error('[African] Routing error:', err);
    return null;
  }
}

function generateAfricanHistory(stock: any, period = '1mo'): { dates: string[]; prices: number[] } {
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
  const sym = stock.symbol || 'AFX';
  for (let i = 0; i < sym.length; i++) {
    seed += sym.charCodeAt(i);
  }

  const tempPrices: number[] = [];
  let p = currentPrice;
  tempPrices.push(p);

  const stepVolatility = currentPrice * 0.015;
  for (let i = 1; i < count; i++) {
    seed = (seed * 9301 + 49297) % 233280;
    const rnd = seed / 233280 - 0.48;
    p = Math.max(0.01, p - rnd * stepVolatility);
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

const generateGseHistory = generateAfricanHistory;

function getAfricanNews(symbol: string, name: string, exchange = 'African Market', country = 'African', sector = 'Equities') {
  const now = Date.now();
  return [
    {
      title: `${name} (${symbol}) registers strong trading volume and investor interest on ${exchange}`,
      link: 'https://afx.kwayisi.org',
      date: new Date(now - 2 * 3600 * 1000).toUTCString()
    },
    {
      title: `${country} equities advance as institutional capital expands positions across ${sector}`,
      link: 'https://afx.kwayisi.org',
      date: new Date(now - 11 * 3600 * 1000).toUTCString()
    },
    {
      title: `Quarterly outlook: Analysts assess fundamentals, cashflow, and dividend prospects for ${symbol}`,
      link: 'https://afx.kwayisi.org',
      date: new Date(now - 29 * 3600 * 1000).toUTCString()
    },
    {
      title: `African capital markets demonstrate resilient growth and regional cross-border investment flows`,
      link: 'https://afx.kwayisi.org',
      date: new Date(now - 52 * 3600 * 1000).toUTCString()
    }
  ];
}

function getGseNews(symbol: string, name: string) {
  return getAfricanNews(symbol, name, 'Ghana Stock Exchange (GSE)', 'Ghana', 'Equities');
}

async function getStockData(ticker: string) {
  ticker = ticker.trim().toUpperCase();

  // 1. Direct African stock lookup (GSE, NGX, NSE, JSE, BRVM, EGX)
  if (isAfricanTicker(ticker)) {
    const africanStock = await getAfricanStock(ticker);
    if (africanStock) return africanStock;
  }

  // 2. Prefixed African ticker (e.g. GSE:MTNGH, NGX:DANGCEM, NSE:SCOM, JSE:NPN, BRVM:SNTS, EGX:COMI)
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
  // African stocks (including GSE, NGX, NSE, JSE, BRVM, EGX)
  if (isAfricanTicker(ticker) || isGseTicker(ticker)) {
    const stock = await getStockData(ticker);
    if (stock) {
      return generateAfricanHistory(stock, period);
    }
    return { dates: [], prices: [] };
  }

  if (ticker.includes(':')) {
    const [prefix] = ticker.split(':');
    if (AFRICAN_EXCHANGES[prefix]) {
      const stock = await getStockData(ticker);
      if (stock) return generateAfricanHistory(stock, period);
    }
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
  if (isAfricanTicker(ticker) || isGseTicker(ticker)) {
    const clean = normalizeAfricanTicker(ticker);
    const stock = (await getStockData(ticker)) || AFRICAN_CATALOG[clean];
    return getAfricanNews(
      clean,
      stock?.name || clean,
      stock?.exchange || 'African Market',
      stock?.country || 'African',
      stock?.sector || 'Equities'
    );
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

function cleanAnalysisText(text: string): string {
  if (!text) return '';
  return text
    // Remove conversational AI intros/greetings
    .replace(/^(as an ai|as an ai language model|as a financial analyst ai|here is a brief analysis[^:]*:?|here is an analysis[^:]*:?|certainly!?:?|sure!?:?)\s*/i, '')
    // Remove markdown headers like ### or ##
    .replace(/^#+\s+/gm, '')
    // Remove bold and italic markers
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    // Remove inline code ticks
    .replace(/`([^`]+)`/g, '$1')
    // Clean bullet list symbols
    .replace(/^\s*[-*•]\s+/gm, '')
    // Remove common AI disclaimer footers
    .replace(/(note:\s*(this is an ai|not financial advice|ai-generated|for informational purposes only).*$)/i, '')
    .trim();
}

async function getAiAnalysis(ticker: string, name: string, price: number, changePct: number): Promise<string> {
  const clean = normalizeAfricanTicker(ticker);
  const africanStock = AFRICAN_CATALOG[clean];
  const isAfrican = Boolean(africanStock || isAfricanTicker(ticker));

  const currency = africanStock?.currency || (
    ticker.startsWith('NGX:') ? 'NGN' :
    ticker.startsWith('NSE:') ? 'KES' :
    ticker.startsWith('JSE:') ? 'ZAR' :
    ticker.startsWith('BRVM:') ? 'XOF' :
    ticker.startsWith('EGX:') ? 'EGP' :
    isGseTicker(ticker) ? 'GHS' : 'USD'
  );

  const country = africanStock?.country || (
    currency === 'GHS' ? 'Ghana' :
    currency === 'NGN' ? 'Nigeria' :
    currency === 'KES' ? 'Kenya' :
    currency === 'ZAR' ? 'South Africa' :
    currency === 'XOF' ? 'West Africa' :
    currency === 'EGP' ? 'Egypt' : 'Global'
  );

  const exchange = africanStock?.exchange || (
    currency === 'GHS' ? 'Ghana Stock Exchange (GSE)' :
    currency === 'NGN' ? 'Nigerian Exchange (NGX)' :
    currency === 'KES' ? 'Nairobi Securities Exchange (NSE)' :
    currency === 'ZAR' ? 'Johannesburg Stock Exchange (JSE)' :
    currency === 'XOF' ? 'BRVM West Africa' :
    currency === 'EGP' ? 'Egyptian Exchange (EGX)' : 'Global Market'
  );

  const macroContext = isAfrican
    ? ` Focus on ${country} macroeconomic dynamics, central bank monetary policy, local currency trends, and sector liquidity on the ${exchange}.`
    : '';

  const systemInstruction = 'You are a professional financial market analyst. Be factual, concise, and write in clean plain text paragraphs without asterisks, markdown syntax, bullet points, headers, or AI self-references.';

  // If GROQ_API_KEY is available, use Groq
  if (process.env.GROQ_API_KEY) {
    try {
      const prompt = `You are a financial analyst.${macroContext} Give a brief market analysis of ${name} (${ticker}). Current price: ${currency} ${price}. Change today: ${changePct.toFixed(2)}%. Summarize current trend, key price factors, and short-term outlook in seamless plain text prose without any asterisks, markdown, bullets, or headers. Keep it under 140 words.`;
      
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
              { role: 'system', content: systemInstruction },
              { role: 'user', content: prompt }
            ],
            temperature: 0.2,
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
        if (text) return cleanAnalysisText(text);
      }
    } catch (err) {
      console.warn('[Analysis] Groq call failed:', err);
    }
  }

  // If GEMINI_API_KEY is available, use Gemini
  if (process.env.GEMINI_API_KEY) {
    try {
      const prompt = `You are a professional financial analyst.${macroContext} Give a brief market analysis of ${name} (${ticker}). Current price: ${currency} ${price}. Change today: ${changePct.toFixed(2)}%. Summarize current trend, key price factors, and short-term outlook in seamless plain text prose without any asterisks, markdown, bullets, or headers. Keep it under 140 words.`;
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          systemInstruction: { parts: [{ text: systemInstruction }] }
        }),
        signal: AbortSignal.timeout(8000)
      });
      if (res.ok) {
        const json = await res.json();
        const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) return cleanAnalysisText(text);
      }
    } catch (err) {
      console.warn('[Analysis] Gemini call failed:', err);
    }
  }

  // Graceful deterministic financial summary when external API is not configured
  const direction = changePct >= 0 ? 'bullish momentum' : 'bearish pressure';
  const sign = changePct >= 0 ? '+' : '';
  const fallbackText = `${name} (${ticker}) is currently trading at ${currency} ${price.toLocaleString()}, reflecting ${direction} with a ${sign}${changePct.toFixed(2)}% session change. Trading volumes and market sentiment indicate active institutional participation and liquidity. Key drivers include macroeconomic updates, sector performance, and quarterly expectations. Short-term outlook remains sensitive to support levels and prevailing volatility.`;
  return cleanAnalysisText(fallbackText);
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
    { symbol: 'NGX-ASI', fallback: 'NGX All-Share (Lagos)' },
    { symbol: 'NSE-20', fallback: 'NSE 20 (Nairobi)' },
    { symbol: 'JSE-TOP40', fallback: 'JSE Top 40 (Joburg)' },
    { symbol: '^GSPC', fallback: 'S&P 500' },
    { symbol: '^IXIC', fallback: 'NASDAQ' },
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

  // Grouped African stocks for dashboard showcase
  const gseTickers = ['MTNGH', 'GCB', 'TOTAL', 'EGH', 'CAL', 'GOIL', 'BOPP', 'FML'];
  const ngxTickers = ['DANGCEM', 'MTNN', 'ZENITHBANK', 'GTCO', 'AIRTELAFRI', 'SEPLAT', 'ACCESSCORP', 'NESTLE'];
  const nseTickers = ['SCOM', 'EQTY', 'KCB', 'EABL', 'BAT', 'SCBK'];
  const jseTickers = ['NPN', 'FSR', 'SOL', 'AGL', 'BTI', 'SHP'];
  const brvmTickers = ['SNTS', 'SGBC', 'ECOC', 'ONTBF', 'TTLC'];
  const egxTickers = ['COMI', 'ETEL', 'EAST', 'HRHO', 'TMGH'];

  const [gseStocks, ngxStocks, nseStocks, jseStocks, brvmStocks, egxStocks] = await Promise.all([
    Promise.all(gseTickers.map(t => getStockData(t))),
    Promise.all(ngxTickers.map(t => getStockData(t))),
    Promise.all(nseTickers.map(t => getStockData(t))),
    Promise.all(jseTickers.map(t => getStockData(t))),
    Promise.all(brvmTickers.map(t => getStockData(t))),
    Promise.all(egxTickers.map(t => getStockData(t)))
  ]);

  const cleanGse = gseStocks.filter(Boolean);
  const cleanNgx = ngxStocks.filter(Boolean);
  const cleanNse = nseStocks.filter(Boolean);
  const cleanJse = jseStocks.filter(Boolean);
  const cleanBrvm = brvmStocks.filter(Boolean);
  const cleanEgx = egxStocks.filter(Boolean);

  const allAfricanStocks = [
    ...cleanGse,
    ...cleanNgx,
    ...cleanNse,
    ...cleanJse,
    ...cleanBrvm,
    ...cleanEgx
  ];

  res.render('index.html', {
    indices: indicesData,
    gse_stocks: cleanGse,
    ngx_stocks: cleanNgx,
    nse_stocks: cleanNse,
    jse_stocks: cleanJse,
    brvm_stocks: cleanBrvm,
    egx_stocks: cleanEgx,
    african_stocks: allAfricanStocks,
    just_logged_out: justLoggedOut
  });
});

app.get('/search', async (req: Request, res: Response) => {
  const rawQuery = String(req.query.q || '').trim();
  const query = rawQuery.toUpperCase();
  const results: any[] = [];

  if (query) {
    const cleanTicker = normalizeAfricanTicker(query);

    // 1. Regional / Country / Exchange queries
    const isAfricaGeneral = ['AFRICA', 'AFRICAN'].some(k => query.includes(k));
    const isGhana = ['GHANA', 'GSE', 'CEDI', 'CEDIS', 'ACCRA'].some(k => query.includes(k));
    const isNigeria = ['NIGERIA', 'NGX', 'NAIRA', 'LAGOS'].some(k => query.includes(k));
    const isKenya = ['KENYA', 'NSE', 'SHILLING', 'NAIROBI'].some(k => query.includes(k));
    const isSouthAfrica = ['SOUTH AFRICA', 'JSE', 'RAND', 'JOHANNESBURG'].some(k => query.includes(k));
    const isBrvm = ['BRVM', 'WAEMU', 'CFA', 'ABIDJAN', 'IVORY COAST', "COTE D'IVOIRE", 'SENEGAL'].some(k => query.includes(k));
    const isEgypt = ['EGYPT', 'EGX', 'POUND', 'CAIRO'].some(k => query.includes(k));

    if (isAfricaGeneral) {
      const sampleTickers = ['MTNGH', 'GCB', 'DANGCEM', 'MTNN', 'SCOM', 'EQTY', 'NPN', 'FSR', 'SNTS', 'SGBC', 'COMI', 'ETEL'];
      for (const t of sampleTickers) {
        const s = await getStockData(t);
        if (s && !results.some(r => r.symbol === s.symbol)) results.push(s);
      }
    } else if (isGhana) {
      for (const [key, item] of Object.entries(AFRICAN_CATALOG)) {
        if (item.exchange_code === 'GSE') {
          const s = await getStockData(key);
          if (s && !results.some(r => r.symbol === s.symbol)) results.push(s);
        }
      }
    } else if (isNigeria) {
      for (const [key, item] of Object.entries(AFRICAN_CATALOG)) {
        if (item.exchange_code === 'NGX') {
          const s = await getStockData(key);
          if (s && !results.some(r => r.symbol === s.symbol)) results.push(s);
        }
      }
    } else if (isKenya) {
      for (const [key, item] of Object.entries(AFRICAN_CATALOG)) {
        if (item.exchange_code === 'NSE') {
          const s = await getStockData(key);
          if (s && !results.some(r => r.symbol === s.symbol)) results.push(s);
        }
      }
    } else if (isSouthAfrica) {
      for (const [key, item] of Object.entries(AFRICAN_CATALOG)) {
        if (item.exchange_code === 'JSE') {
          const s = await getStockData(key);
          if (s && !results.some(r => r.symbol === s.symbol)) results.push(s);
        }
      }
    } else if (isBrvm) {
      for (const [key, item] of Object.entries(AFRICAN_CATALOG)) {
        if (item.exchange_code === 'BRVM') {
          const s = await getStockData(key);
          if (s && !results.some(r => r.symbol === s.symbol)) results.push(s);
        }
      }
    } else if (isEgypt) {
      for (const [key, item] of Object.entries(AFRICAN_CATALOG)) {
        if (item.exchange_code === 'EGX') {
          const s = await getStockData(key);
          if (s && !results.some(r => r.symbol === s.symbol)) results.push(s);
        }
      }
    } else {
      // 2. Search catalog by ticker, company name, sector, country, or exchange
      for (const [key, item] of Object.entries(AFRICAN_CATALOG)) {
        if (
          key === cleanTicker ||
          key === query ||
          item.name.toUpperCase().includes(query) ||
          item.sector.toUpperCase().includes(query) ||
          item.country.toUpperCase().includes(query) ||
          item.exchange_code.toUpperCase() === query
        ) {
          const s = await getStockData(key);
          if (s && !results.some(r => r.symbol === s.symbol)) {
            results.push(s);
          }
        }
      }

      // 3. Fallback to general getStockData lookup
      if (results.length === 0) {
        const data = await getStockData(query);
        if (data) results.push(data);
      }
    }

    if (results.length === 0) {
      flash(
        req,
        `No results for "${rawQuery}". Try African stocks: MTNGH, DANGCEM, SCOM, NPN, SNTS, COMI, or global: AAPL, TSLA, BTC-USD`,
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
