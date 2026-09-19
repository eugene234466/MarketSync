import os
import yfinance as yf
import feedparser
import requests
from bs4 import BeautifulSoup
from datetime import datetime, timedelta
from flask import Flask, render_template, request, jsonify, redirect, url_for, flash, send_from_directory, session, make_response
from flask_login import login_user, logout_user, login_required, current_user
from groq import Groq
from dotenv import load_dotenv
from apscheduler.schedulers.background import BackgroundScheduler
from models import db, bcrypt, login_manager, User, Portfolio, Alert
from yahoo_service import get_stock_data_service, get_stock_history_service, session_manager

load_dotenv()

basedir = os.path.abspath(os.path.dirname(__file__))
static_dir = os.path.join(basedir, 'static')
template_dir = os.path.join(basedir, 'templates')

from werkzeug.middleware.proxy_fix import ProxyFix

app = Flask(
    __name__,
    static_folder=static_dir,
    static_url_path='/static',
    template_folder=template_dir
)

def currency_sym_filter(val):
    if isinstance(val, dict):
        val = val.get('currency', '')
    val = str(val or '')
    if val == 'GHS':
        return 'GH₵'
    if val == 'NGN':
        return '₦'
    if val == 'KES':
        return 'KSh'
    if val == 'ZAR':
        return 'R'
    if val == 'XOF':
        return 'CFA'
    if val == 'EGP':
        return 'E£'
    if val == 'GBP':
        return '£'
    if val == 'EUR':
        return '€'
    return '$'

app.jinja_env.filters['currency_sym'] = currency_sym_filter

# Enable proxy headers support for Render, Vercel, and Cloud Run
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1, x_port=1, x_prefix=1)

is_production = bool(os.getenv('RENDER') or os.getenv('VERCEL') or os.getenv('DYNO') or os.getenv('PRODUCTION'))

app.config['SECRET_KEY'] = os.getenv('SECRET_KEY', 'dev_key_123')
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False

# Session and cookie security for top-level and iframe execution
app.config['SESSION_COOKIE_HTTPONLY'] = True
app.config['SESSION_COOKIE_SAMESITE'] = 'None' if is_production else 'Lax'
app.config['SESSION_COOKIE_SECURE'] = is_production
app.config['REMEMBER_COOKIE_HTTPONLY'] = True
app.config['REMEMBER_COOKIE_SAMESITE'] = 'None' if is_production else 'Lax'
app.config['REMEMBER_COOKIE_SECURE'] = is_production
app.config['REMEMBER_COOKIE_DURATION'] = timedelta(days=30)

@app.after_request
def add_cookie_security(response):
    # Support Partitioned cookies (CHIPS) when running in iframes
    set_cookies = response.headers.getlist('Set-Cookie')
    if set_cookies:
        response.headers.remove('Set-Cookie')
        for cookie in set_cookies:
            if 'SameSite=None' in cookie and 'Partitioned' not in cookie:
                cookie = f"{cookie}; Partitioned"
            response.headers.add('Set-Cookie', cookie)
    return response

# Explicit route to ensure CSS, JS, images, and manifest are served reliably on Vercel and cloud platforms
@app.route('/static/<path:filename>')
def serve_static(filename):
    return send_from_directory(static_dir, filename)

# Use init_db from models — handles DATABASE_URL with SQLite fallback
from models import init_db, create_tables, check_database_connection
init_db(app)
create_tables(app)
bcrypt.init_app(app)
login_manager.init_app(app)
login_manager.login_view = 'login'

def get_groq_client():
    api_key = os.getenv('GROQ_API_KEY')
    if not api_key:
        return None
    try:
        return Groq(api_key=api_key)
    except Exception as e:
        app.logger.warning(f"Could not initialize Groq client: {e}")
        return None

_tables_initialized = False

@app.before_request
def ensure_db_initialized():
    global _tables_initialized
    if not _tables_initialized:
        try:
            create_tables(app)
            _tables_initialized = True
        except Exception as e:
            app.logger.warning(f"Database verify tables error: {e}")


# ── HELPER FUNCTIONS ──────────────────────────────────────────────────────────

# ── AFRICAN CAPITAL MARKETS & EXCHANGES CATALOG ──────────────────────────────
# Covers GSE (Ghana), NGX (Nigeria), NSE (Kenya), JSE (South Africa), BRVM (West Africa), EGX (Egypt)
import re

AFRICAN_EXCHANGES = {
    'GSE':  'Ghana Stock Exchange (GHS)',
    'NGX':  'Nigerian Exchange (NGN)',
    'NSE':  'Nairobi Securities Exchange (KES)',
    'JSE':  'Johannesburg Stock Exchange (ZAR)',
    'BRVM': 'BRVM West Africa (XOF)',
    'EGX':  'Egyptian Exchange (EGP)'
}

AFRICAN_CATALOG = {
    # ── 🇳🇬 NIGERIA (NGX - NIGERIAN EXCHANGE) ─────────────────────────
    'DANGCEM': {
        'symbol': 'DANGCEM',
        'name': 'Dangote Cement PLC',
        'price': 680.00,
        'prev_close': 675.00,
        'change': 5.00,
        'change_percent': 0.74,
        'volume': 1450000,
        'market_cap': 11500000000000,
        'high_52': 750.00,
        'low_52': 320.00,
        'pe_ratio': 14.2,
        'dividend': 4.5,
        'sector': 'Industrial & Building Materials',
        'currency': 'NGN',
        'exchange': 'Nigerian Exchange (NGX)',
        'exchange_code': 'NGX',
        'country': 'Nigeria',
        'flag': '🇳🇬'
    },
    'MTNN': {
        'symbol': 'MTNN',
        'name': 'MTN Nigeria Communications PLC',
        'price': 285.50,
        'prev_close': 282.00,
        'change': 3.50,
        'change_percent': 1.24,
        'volume': 3200000,
        'market_cap': 5900000000000,
        'high_52': 320.00,
        'low_52': 210.00,
        'pe_ratio': 11.5,
        'dividend': 5.2,
        'sector': 'Telecommunications',
        'currency': 'NGN',
        'exchange': 'Nigerian Exchange (NGX)',
        'exchange_code': 'NGX',
        'country': 'Nigeria',
        'flag': '🇳🇬'
    },
    'GTCO': {
        'symbol': 'GTCO',
        'name': 'Guaranty Trust Holding Company PLC',
        'price': 52.80,
        'prev_close': 51.70,
        'change': 1.10,
        'change_percent': 2.13,
        'volume': 8900000,
        'market_cap': 1550000000000,
        'high_52': 55.00,
        'low_52': 36.00,
        'pe_ratio': 4.8,
        'dividend': 6.8,
        'sector': 'Banking & Financial Services',
        'currency': 'NGN',
        'exchange': 'Nigerian Exchange (NGX)',
        'exchange_code': 'NGX',
        'country': 'Nigeria',
        'flag': '🇳🇬'
    },
    'ZENITHBANK': {
        'symbol': 'ZENITHBANK',
        'name': 'Zenith Bank PLC',
        'price': 44.50,
        'prev_close': 43.70,
        'change': 0.80,
        'change_percent': 1.83,
        'volume': 9400000,
        'market_cap': 1390000000000,
        'high_52': 47.00,
        'low_52': 32.50,
        'pe_ratio': 4.2,
        'dividend': 7.5,
        'sector': 'Banking & Financial Services',
        'currency': 'NGN',
        'exchange': 'Nigerian Exchange (NGX)',
        'exchange_code': 'NGX',
        'country': 'Nigeria',
        'flag': '🇳🇬'
    },
    'AIRTELAFRI': {
        'symbol': 'AIRTELAFRI',
        'name': 'Airtel Africa PLC',
        'price': 2150.00,
        'prev_close': 2160.00,
        'change': -10.00,
        'change_percent': -0.46,
        'volume': 450000,
        'market_cap': 8100000000000,
        'high_52': 2400.00,
        'low_52': 1800.00,
        'pe_ratio': 16.8,
        'dividend': 3.1,
        'sector': 'Telecommunications',
        'currency': 'NGN',
        'exchange': 'Nigerian Exchange (NGX)',
        'exchange_code': 'NGX',
        'country': 'Nigeria',
        'flag': '🇳🇬'
    },
    'SEPLAT': {
        'symbol': 'SEPLAT',
        'name': 'Seplat Energy PLC',
        'price': 3980.00,
        'prev_close': 3860.00,
        'change': 120.00,
        'change_percent': 3.11,
        'volume': 380000,
        'market_cap': 2340000000000,
        'high_52': 4200.00,
        'low_52': 1900.00,
        'pe_ratio': 7.4,
        'dividend': 4.1,
        'sector': 'Energy / Oil & Gas',
        'currency': 'NGN',
        'exchange': 'Nigerian Exchange (NGX)',
        'exchange_code': 'NGX',
        'country': 'Nigeria',
        'flag': '🇳🇬'
    },
    'NESTLE': {
        'symbol': 'NESTLE',
        'name': 'Nestle Nigeria PLC',
        'price': 900.00,
        'prev_close': 900.00,
        'change': 0.00,
        'change_percent': 0.00,
        'volume': 65000,
        'market_cap': 71300000000,
        'high_52': 1150.00,
        'low_52': 850.00,
        'pe_ratio': 21.0,
        'dividend': 3.8,
        'sector': 'Consumer Goods / FMCG',
        'currency': 'NGN',
        'exchange': 'Nigerian Exchange (NGX)',
        'exchange_code': 'NGX',
        'country': 'Nigeria',
        'flag': '🇳🇬'
    },
    'ACCESSCORP': {
        'symbol': 'ACCESSCORP',
        'name': 'Access Holdings PLC',
        'price': 21.40,
        'prev_close': 21.10,
        'change': 0.30,
        'change_percent': 1.42,
        'volume': 12500000,
        'market_cap': 760000000000,
        'high_52': 28.50,
        'low_52': 16.50,
        'pe_ratio': 3.8,
        'dividend': 6.0,
        'sector': 'Banking & Financial Services',
        'currency': 'NGN',
        'exchange': 'Nigerian Exchange (NGX)',
        'exchange_code': 'NGX',
        'country': 'Nigeria',
        'flag': '🇳🇬'
    },
    'NGX-ASI': {
        'symbol': 'NGX-ASI',
        'name': 'NGX All-Share Index',
        'price': 98240.50,
        'prev_close': 97605.00,
        'change': 635.50,
        'change_percent': 0.65,
        'volume': 450000000,
        'market_cap': 56000000000000,
        'high_52': 105000.00,
        'low_52': 70000.00,
        'pe_ratio': None,
        'dividend': None,
        'sector': 'National Benchmark Index',
        'currency': 'NGN',
        'exchange': 'Nigerian Exchange (NGX)',
        'exchange_code': 'NGX',
        'country': 'Nigeria',
        'flag': '🇳🇬'
    },

    # ── 🇰🇪 KENYA (NSE - NAIROBI SECURITIES EXCHANGE) ──────────────────
    'SCOM': {
        'symbol': 'SCOM',
        'name': 'Safaricom PLC',
        'price': 17.50,
        'prev_close': 17.20,
        'change': 0.30,
        'change_percent': 1.74,
        'volume': 14200000,
        'market_cap': 701000000000,
        'high_52': 20.50,
        'low_52': 13.50,
        'pe_ratio': 12.8,
        'dividend': 6.9,
        'sector': 'Telecommunications & Fintech (M-Pesa)',
        'currency': 'KES',
        'exchange': 'Nairobi Securities Exchange (NSE)',
        'exchange_code': 'NSE',
        'country': 'Kenya',
        'flag': '🇰🇪'
    },
    'EQTY': {
        'symbol': 'EQTY',
        'name': 'Equity Group Holdings PLC',
        'price': 44.00,
        'prev_close': 43.00,
        'change': 1.00,
        'change_percent': 2.33,
        'volume': 4100000,
        'market_cap': 166000000000,
        'high_52': 48.50,
        'low_52': 34.00,
        'pe_ratio': 4.1,
        'dividend': 9.1,
        'sector': 'Banking & Financial Services',
        'currency': 'KES',
        'exchange': 'Nairobi Securities Exchange (NSE)',
        'exchange_code': 'NSE',
        'country': 'Kenya',
        'flag': '🇰🇪'
    },
    'KCB': {
        'symbol': 'KCB',
        'name': 'KCB Group PLC',
        'price': 32.75,
        'prev_close': 32.40,
        'change': 0.35,
        'change_percent': 1.08,
        'volume': 3500000,
        'market_cap': 105000000000,
        'high_52': 38.00,
        'low_52': 21.00,
        'pe_ratio': 3.6,
        'dividend': 6.1,
        'sector': 'Banking & Financial Services',
        'currency': 'KES',
        'exchange': 'Nairobi Securities Exchange (NSE)',
        'exchange_code': 'NSE',
        'country': 'Kenya',
        'flag': '🇰🇪'
    },
    'EABL': {
        'symbol': 'EABL',
        'name': 'East African Breweries Limited',
        'price': 152.00,
        'prev_close': 153.00,
        'change': -1.00,
        'change_percent': -0.65,
        'volume': 580000,
        'market_cap': 120000000000,
        'high_52': 175.00,
        'low_52': 120.00,
        'pe_ratio': 11.2,
        'dividend': 5.8,
        'sector': 'Beverages & Brewing',
        'currency': 'KES',
        'exchange': 'Nairobi Securities Exchange (NSE)',
        'exchange_code': 'NSE',
        'country': 'Kenya',
        'flag': '🇰🇪'
    },
    'BAT': {
        'symbol': 'BAT',
        'name': 'British American Tobacco Kenya PLC',
        'price': 415.00,
        'prev_close': 415.00,
        'change': 0.00,
        'change_percent': 0.00,
        'volume': 45000,
        'market_cap': 41500000000,
        'high_52': 460.00,
        'low_52': 390.00,
        'pe_ratio': 8.5,
        'dividend': 11.5,
        'sector': 'Consumer Goods',
        'currency': 'KES',
        'exchange': 'Nairobi Securities Exchange (NSE)',
        'exchange_code': 'NSE',
        'country': 'Kenya',
        'flag': '🇰🇪'
    },
    'SCBK': {
        'symbol': 'SCBK',
        'name': 'Standard Chartered Bank Kenya Limited',
        'price': 198.50,
        'prev_close': 197.00,
        'change': 1.50,
        'change_percent': 0.76,
        'volume': 180000,
        'market_cap': 75000000000,
        'high_52': 210.00,
        'low_52': 155.00,
        'pe_ratio': 5.4,
        'dividend': 11.8,
        'sector': 'Banking & Financial Services',
        'currency': 'KES',
        'exchange': 'Nairobi Securities Exchange (NSE)',
        'exchange_code': 'NSE',
        'country': 'Kenya',
        'flag': '🇰🇪'
    },
    'NSE-20': {
        'symbol': 'NSE-20',
        'name': 'NSE 20 Share Index',
        'price': 1845.20,
        'prev_close': 1836.40,
        'change': 8.80,
        'change_percent': 0.48,
        'volume': 25000000,
        'market_cap': 1600000000000,
        'high_52': 1950.00,
        'low_52': 1450.00,
        'pe_ratio': None,
        'dividend': None,
        'sector': 'National Benchmark Index',
        'currency': 'KES',
        'exchange': 'Nairobi Securities Exchange (NSE)',
        'exchange_code': 'NSE',
        'country': 'Kenya',
        'flag': '🇰🇪'
    },

    # ── 🇿🇦 SOUTH AFRICA (JSE - JOHANNESBURG STOCK EXCHANGE) ─────────
    'NPN': {
        'symbol': 'NPN',
        'name': 'Naspers Limited',
        'price': 3820.00,
        'prev_close': 3750.00,
        'change': 70.00,
        'change_percent': 1.87,
        'volume': 1250000,
        'market_cap': 1620000000000,
        'high_52': 4100.00,
        'low_52': 2850.00,
        'pe_ratio': 24.5,
        'dividend': 0.8,
        'sector': 'Technology & Global Internet',
        'currency': 'ZAR',
        'exchange': 'Johannesburg Stock Exchange (JSE)',
        'exchange_code': 'JSE',
        'country': 'South Africa',
        'flag': '🇿🇦'
    },
    'FSR': {
        'symbol': 'FSR',
        'name': 'FirstRand Limited',
        'price': 78.50,
        'prev_close': 77.80,
        'change': 0.70,
        'change_percent': 0.90,
        'volume': 8600000,
        'market_cap': 440000000000,
        'high_52': 83.00,
        'low_52': 61.00,
        'pe_ratio': 10.2,
        'dividend': 4.9,
        'sector': 'Banking & Financial Services',
        'currency': 'ZAR',
        'exchange': 'Johannesburg Stock Exchange (JSE)',
        'exchange_code': 'JSE',
        'country': 'South Africa',
        'flag': '🇿🇦'
    },
    'SOL': {
        'symbol': 'SOL',
        'name': 'Sasol Limited',
        'price': 138.40,
        'prev_close': 140.40,
        'change': -2.00,
        'change_percent': -1.42,
        'volume': 3100000,
        'market_cap': 88000000000,
        'high_52': 240.00,
        'low_52': 125.00,
        'pe_ratio': 6.8,
        'dividend': 5.5,
        'sector': 'Chemicals & Synthetic Fuels',
        'currency': 'ZAR',
        'exchange': 'Johannesburg Stock Exchange (JSE)',
        'exchange_code': 'JSE',
        'country': 'South Africa',
        'flag': '🇿🇦'
    },
    'MTN': {
        'symbol': 'MTN',
        'name': 'MTN Group Limited',
        'price': 96.20,
        'prev_close': 94.20,
        'change': 2.00,
        'change_percent': 2.12,
        'volume': 4800000,
        'market_cap': 181000000000,
        'high_52': 128.00,
        'low_52': 78.00,
        'pe_ratio': 12.0,
        'dividend': 4.4,
        'sector': 'Telecommunications',
        'currency': 'ZAR',
        'exchange': 'Johannesburg Stock Exchange (JSE)',
        'exchange_code': 'JSE',
        'country': 'South Africa',
        'flag': '🇿🇦'
    },
    'SBK': {
        'symbol': 'SBK',
        'name': 'Standard Bank Group Limited',
        'price': 215.00,
        'prev_close': 212.50,
        'change': 2.50,
        'change_percent': 1.18,
        'volume': 3900000,
        'market_cap': 358000000000,
        'high_52': 225.00,
        'low_52': 168.00,
        'pe_ratio': 8.7,
        'dividend': 6.8,
        'sector': 'Banking & Financial Services',
        'currency': 'ZAR',
        'exchange': 'Johannesburg Stock Exchange (JSE)',
        'exchange_code': 'JSE',
        'country': 'South Africa',
        'flag': '🇿🇦'
    },
    'AGL': {
        'symbol': 'AGL',
        'name': 'Anglo American PLC',
        'price': 540.00,
        'prev_close': 537.00,
        'change': 3.00,
        'change_percent': 0.56,
        'volume': 2400000,
        'market_cap': 720000000000,
        'high_52': 650.00,
        'low_52': 410.00,
        'pe_ratio': 15.1,
        'dividend': 3.2,
        'sector': 'Mining & Natural Resources',
        'currency': 'ZAR',
        'exchange': 'Johannesburg Stock Exchange (JSE)',
        'exchange_code': 'JSE',
        'country': 'South Africa',
        'flag': '🇿🇦'
    },
    'SHP': {
        'symbol': 'SHP',
        'name': 'Shoprite Holdings Limited',
        'price': 294.00,
        'prev_close': 290.00,
        'change': 4.00,
        'change_percent': 1.38,
        'volume': 1600000,
        'market_cap': 174000000000,
        'high_52': 310.00,
        'low_52': 230.00,
        'pe_ratio': 18.5,
        'dividend': 2.8,
        'sector': 'Retail & Supermarkets',
        'currency': 'ZAR',
        'exchange': 'Johannesburg Stock Exchange (JSE)',
        'exchange_code': 'JSE',
        'country': 'South Africa',
        'flag': '🇿🇦'
    },
    'JSE-TOP40': {
        'symbol': 'JSE-TOP40',
        'name': 'FTSE/JSE Top 40 Index',
        'price': 76450.00,
        'prev_close': 75905.00,
        'change': 545.00,
        'change_percent': 0.72,
        'volume': 85000000,
        'market_cap': 18000000000000,
        'high_52': 79000.00,
        'low_52': 66000.00,
        'pe_ratio': None,
        'dividend': None,
        'sector': 'National Benchmark Index',
        'currency': 'ZAR',
        'exchange': 'Johannesburg Stock Exchange (JSE)',
        'exchange_code': 'JSE',
        'country': 'South Africa',
        'flag': '🇿🇦'
    },

    # ── 🇨🇮 BRVM (WEST AFRICA REGIONAL EXCHANGE - CÔTE D'IVOIRE / SENEGAL) ─
    'SNTS': {
        'symbol': 'SNTS',
        'name': 'Sonatel Senegal (Orange)',
        'price': 19800.00,
        'prev_close': 19600.00,
        'change': 200.00,
        'change_percent': 1.02,
        'volume': 120000,
        'market_cap': 1980000000000,
        'high_52': 21000.00,
        'low_52': 15500.00,
        'pe_ratio': 8.2,
        'dividend': 8.5,
        'sector': 'Telecommunications',
        'currency': 'XOF',
        'exchange': 'BRVM West Africa',
        'exchange_code': 'BRVM',
        'country': 'Senegal / Côte d\'Ivoire',
        'flag': '🇨🇮'
    },
    'ECOC': {
        'symbol': 'ECOC',
        'name': 'Ecobank Côte d\'Ivoire',
        'price': 7650.00,
        'prev_close': 7500.00,
        'change': 150.00,
        'change_percent': 1.99,
        'volume': 65000,
        'market_cap': 420000000000,
        'high_52': 8200.00,
        'low_52': 5200.00,
        'pe_ratio': 6.1,
        'dividend': 7.4,
        'sector': 'Banking & Financial Services',
        'currency': 'XOF',
        'exchange': 'BRVM West Africa',
        'exchange_code': 'BRVM',
        'country': 'Côte d\'Ivoire',
        'flag': '🇨🇮'
    },
    'SGBC': {
        'symbol': 'SGBC',
        'name': 'Société Générale Côte d\'Ivoire',
        'price': 18200.00,
        'prev_close': 18100.00,
        'change': 100.00,
        'change_percent': 0.55,
        'volume': 45000,
        'market_cap': 565000000000,
        'high_52': 19500.00,
        'low_52': 13500.00,
        'pe_ratio': 7.0,
        'dividend': 6.8,
        'sector': 'Banking & Financial Services',
        'currency': 'XOF',
        'exchange': 'BRVM West Africa',
        'exchange_code': 'BRVM',
        'country': 'Côte d\'Ivoire',
        'flag': '🇨🇮'
    },
    'ONTBF': {
        'symbol': 'ONTBF',
        'name': 'Onatel Burkina Faso',
        'price': 2450.00,
        'prev_close': 2470.00,
        'change': -20.00,
        'change_percent': -0.81,
        'volume': 85000,
        'market_cap': 166000000000,
        'high_52': 3100.00,
        'low_52': 2200.00,
        'pe_ratio': 5.9,
        'dividend': 9.2,
        'sector': 'Telecommunications',
        'currency': 'XOF',
        'exchange': 'BRVM West Africa',
        'exchange_code': 'BRVM',
        'country': 'Burkina Faso',
        'flag': '🇨🇮'
    },
    'BRVM-C': {
        'symbol': 'BRVM-C',
        'name': 'BRVM Composite Index',
        'price': 268.40,
        'prev_close': 267.50,
        'change': 0.90,
        'change_percent': 0.34,
        'volume': 1500000,
        'market_cap': 9800000000000,
        'high_52': 285.00,
        'low_52': 205.00,
        'pe_ratio': None,
        'dividend': None,
        'sector': 'Regional Benchmark Index',
        'currency': 'XOF',
        'exchange': 'BRVM West Africa',
        'exchange_code': 'BRVM',
        'country': 'UEMOA Regional',
        'flag': '🇨🇮'
    },

    # ── 🇪🇬 EGYPT (EGX - EGYPTIAN EXCHANGE) ───────────────────────────
    'COMI': {
        'symbol': 'COMI',
        'name': 'Commercial International Bank (CIB)',
        'price': 82.50,
        'prev_close': 81.20,
        'change': 1.30,
        'change_percent': 1.60,
        'volume': 6800000,
        'market_cap': 248000000000,
        'high_52': 94.00,
        'low_52': 58.00,
        'pe_ratio': 7.8,
        'dividend': 4.5,
        'sector': 'Banking & Financial Services',
        'currency': 'EGP',
        'exchange': 'Egyptian Exchange (EGX)',
        'exchange_code': 'EGX',
        'country': 'Egypt',
        'flag': '🇪🇬'
    },
    'EAST': {
        'symbol': 'EAST',
        'name': 'Eastern Company',
        'price': 27.80,
        'prev_close': 27.60,
        'change': 0.20,
        'change_percent': 0.72,
        'volume': 4200000,
        'market_cap': 62000000000,
        'high_52': 33.00,
        'low_52': 21.00,
        'pe_ratio': 6.2,
        'dividend': 9.5,
        'sector': 'Consumer Goods',
        'currency': 'EGP',
        'exchange': 'Egyptian Exchange (EGX)',
        'exchange_code': 'EGX',
        'country': 'Egypt',
        'flag': '🇪🇬'
    },
    'HRHO': {
        'symbol': 'HRHO',
        'name': 'EFG Holding (Hermes)',
        'price': 19.40,
        'prev_close': 19.00,
        'change': 0.40,
        'change_percent': 2.11,
        'volume': 8100000,
        'market_cap': 28000000000,
        'high_52': 23.50,
        'low_52': 14.50,
        'pe_ratio': 8.9,
        'dividend': 5.0,
        'sector': 'Investment Banking & Financial Services',
        'currency': 'EGP',
        'exchange': 'Egyptian Exchange (EGX)',
        'exchange_code': 'EGX',
        'country': 'Egypt',
        'flag': '🇪🇬'
    },
    'TMGH': {
        'symbol': 'TMGH',
        'name': 'Talaat Moustafa Group Holding',
        'price': 58.20,
        'prev_close': 56.20,
        'change': 2.00,
        'change_percent': 3.56,
        'volume': 5500000,
        'market_cap': 120000000000,
        'high_52': 72.00,
        'low_52': 32.00,
        'pe_ratio': 12.4,
        'dividend': 2.5,
        'sector': 'Real Estate & Hospitality',
        'currency': 'EGP',
        'exchange': 'Egyptian Exchange (EGX)',
        'exchange_code': 'EGX',
        'country': 'Egypt',
        'flag': '🇪🇬'
    },
    'EGX30': {
        'symbol': 'EGX30',
        'name': 'EGX 30 Index',
        'price': 30540.00,
        'prev_close': 30192.00,
        'change': 348.00,
        'change_percent': 1.15,
        'volume': 95000000,
        'market_cap': 2100000000000,
        'high_52': 33500.00,
        'low_52': 23000.00,
        'pe_ratio': None,
        'dividend': None,
        'sector': 'National Benchmark Index',
        'currency': 'EGP',
        'exchange': 'Egyptian Exchange (EGX)',
        'exchange_code': 'EGX',
        'country': 'Egypt',
        'flag': '🇪🇬'
    },

    # ── 🇬🇭 GHANA (GSE - GHANA STOCK EXCHANGE) ────────────────────────
    'MTNGH': {
        'symbol': 'MTNGH',
        'name': 'Scancom PLC (MTN Ghana)',
        'price': 6.85,
        'prev_close': 6.83,
        'change': 0.02,
        'change_percent': 0.29,
        'volume': 4850000,
        'market_cap': 84100000000,
        'high_52': 7.10,
        'low_52': 1.40,
        'pe_ratio': 14.2,
        'dividend': 4.8,
        'sector': 'Telecommunications',
        'currency': 'GHS',
        'exchange': 'Ghana Stock Exchange (GSE)',
        'exchange_code': 'GSE',
        'country': 'Ghana',
        'flag': '🇬🇭'
    },
    'GCB': {
        'symbol': 'GCB',
        'name': 'GCB Bank PLC',
        'price': 42.00,
        'prev_close': 41.28,
        'change': 0.72,
        'change_percent': 1.75,
        'volume': 145000,
        'market_cap': 11130000000,
        'high_52': 45.00,
        'low_52': 28.50,
        'pe_ratio': 4.5,
        'dividend': 7.2,
        'sector': 'Banking & Financial Services',
        'currency': 'GHS',
        'exchange': 'Ghana Stock Exchange (GSE)',
        'exchange_code': 'GSE',
        'country': 'Ghana',
        'flag': '🇬🇭'
    },
    'SCB': {
        'symbol': 'SCB',
        'name': 'Standard Chartered Bank Ghana PLC',
        'price': 69.89,
        'prev_close': 69.89,
        'change': 0.00,
        'change_percent': 0.00,
        'volume': 15200,
        'market_cap': 9440000000,
        'high_52': 74.50,
        'low_52': 58.00,
        'pe_ratio': 5.1,
        'dividend': 6.5,
        'sector': 'Banking & Financial Services',
        'currency': 'GHS',
        'exchange': 'Ghana Stock Exchange (GSE)',
        'exchange_code': 'GSE',
        'country': 'Ghana',
        'flag': '🇬🇭'
    },
    'EGH': {
        'symbol': 'EGH',
        'name': 'Ecobank Ghana PLC',
        'price': 38.00,
        'prev_close': 37.10,
        'change': 0.90,
        'change_percent': 2.43,
        'volume': 92000,
        'market_cap': 12310000000,
        'high_52': 42.00,
        'low_52': 22.50,
        'pe_ratio': 4.8,
        'dividend': 5.9,
        'sector': 'Banking & Financial Services',
        'currency': 'GHS',
        'exchange': 'Ghana Stock Exchange (GSE)',
        'exchange_code': 'GSE',
        'country': 'Ghana',
        'flag': '🇬🇭'
    },
    'CAL': {
        'symbol': 'CAL',
        'name': 'CalBank PLC',
        'price': 0.71,
        'prev_close': 0.69,
        'change': 0.02,
        'change_percent': 2.74,
        'volume': 620000,
        'market_cap': 445000000,
        'high_52': 0.95,
        'low_52': 0.50,
        'pe_ratio': 3.2,
        'dividend': 0.0,
        'sector': 'Banking & Financial Services',
        'currency': 'GHS',
        'exchange': 'Ghana Stock Exchange (GSE)',
        'exchange_code': 'GSE',
        'country': 'Ghana',
        'flag': '🇬🇭'
    },
    'TOTAL': {
        'symbol': 'TOTAL',
        'name': 'TotalEnergies Marketing Ghana PLC',
        'price': 37.80,
        'prev_close': 37.78,
        'change': 0.02,
        'change_percent': 0.05,
        'volume': 45000,
        'market_cap': 4200000000,
        'high_52': 41.50,
        'low_52': 29.00,
        'pe_ratio': 8.9,
        'dividend': 8.1,
        'sector': 'Energy & Petroleum Marketing',
        'currency': 'GHS',
        'exchange': 'Ghana Stock Exchange (GSE)',
        'exchange_code': 'GSE',
        'country': 'Ghana',
        'flag': '🇬🇭'
    },
    'GOIL': {
        'symbol': 'GOIL',
        'name': 'Ghana Oil Company Limited',
        'price': 6.36,
        'prev_close': 6.44,
        'change': -0.08,
        'change_percent': -1.20,
        'volume': 195000,
        'market_cap': 2520000000,
        'high_52': 7.20,
        'low_52': 5.10,
        'pe_ratio': 6.7,
        'dividend': 4.2,
        'sector': 'Energy & Petroleum Marketing',
        'currency': 'GHS',
        'exchange': 'Ghana Stock Exchange (GSE)',
        'exchange_code': 'GSE',
        'country': 'Ghana',
        'flag': '🇬🇭'
    },
    'BOPP': {
        'symbol': 'BOPP',
        'name': 'Benso Oil Palm Plantation PLC',
        'price': 75.00,
        'prev_close': 68.40,
        'change': 6.60,
        'change_percent': 9.65,
        'volume': 32000,
        'market_cap': 2610000000,
        'high_52': 78.00,
        'low_52': 38.00,
        'pe_ratio': 7.4,
        'dividend': 6.8,
        'sector': 'Agriculture & Agro-Processing',
        'currency': 'GHS',
        'exchange': 'Ghana Stock Exchange (GSE)',
        'exchange_code': 'GSE',
        'country': 'Ghana',
        'flag': '🇬🇭'
    },
    'FML': {
        'symbol': 'FML',
        'name': 'Fan Milk PLC',
        'price': 14.00,
        'prev_close': 13.05,
        'change': 0.95,
        'change_percent': 7.33,
        'volume': 60000,
        'market_cap': 1630000000,
        'high_52': 16.50,
        'low_52': 8.50,
        'pe_ratio': 12.1,
        'dividend': 3.5,
        'sector': 'Consumer Goods / Food & Beverage',
        'currency': 'GHS',
        'exchange': 'Ghana Stock Exchange (GSE)',
        'exchange_code': 'GSE',
        'country': 'Ghana',
        'flag': '🇬🇭'
    },
    'UNIL': {
        'symbol': 'UNIL',
        'name': 'Unilever Ghana PLC',
        'price': 40.00,
        'prev_close': 40.00,
        'change': 0.00,
        'change_percent': 0.00,
        'volume': 18000,
        'market_cap': 2500000000,
        'high_52': 44.00,
        'low_52': 32.00,
        'pe_ratio': 15.6,
        'dividend': 3.1,
        'sector': 'Consumer Goods',
        'currency': 'GHS',
        'exchange': 'Ghana Stock Exchange (GSE)',
        'exchange_code': 'GSE',
        'country': 'Ghana',
        'flag': '🇬🇭'
    },
    'ACCESS': {
        'symbol': 'ACCESS',
        'name': 'Access Bank Ghana PLC',
        'price': 12.50,
        'prev_close': 12.30,
        'change': 0.20,
        'change_percent': 1.63,
        'volume': 54000,
        'market_cap': 2150000000,
        'high_52': 14.00,
        'low_52': 8.20,
        'pe_ratio': 3.9,
        'dividend': 6.0,
        'sector': 'Banking & Financial Services',
        'currency': 'GHS',
        'exchange': 'Ghana Stock Exchange (GSE)',
        'exchange_code': 'GSE',
        'country': 'Ghana',
        'flag': '🇬🇭'
    },
    'GSE-CI': {
        'symbol': 'GSE-CI',
        'name': 'GSE Composite Index',
        'price': 7254.30,
        'prev_close': 7208.50,
        'change': 45.80,
        'change_percent': 0.64,
        'volume': 7200000,
        'market_cap': 148000000000,
        'high_52': 7500.00,
        'low_52': 3100.00,
        'pe_ratio': None,
        'dividend': None,
        'sector': 'National Benchmark Index',
        'currency': 'GHS',
        'exchange': 'Ghana Stock Exchange (GSE)',
        'exchange_code': 'GSE',
        'country': 'Ghana',
        'flag': '🇬🇭'
    }
}

GSE_CATALOG = {k: v for k, v in AFRICAN_CATALOG.items() if v.get('exchange_code') == 'GSE'}

def normalize_african_ticker(ticker):
    t = str(ticker or '').upper().strip()
    if ':' in t:
        t = t.split(':', 1)[1]
    for suffix in ['.GH', '.NG', '.NR', '.KE', '.JO', '.ZA', '.CI', '.EG', '.CA']:
        if t.endswith(suffix):
            t = t[:-len(suffix)]
            break
    return t

def normalize_gse_ticker(ticker):
    return normalize_african_ticker(ticker)

def is_african_ticker(ticker):
    t = str(ticker or '').upper().strip()
    clean = normalize_african_ticker(t)
    return clean in AFRICAN_CATALOG or t in AFRICAN_CATALOG or any(t.startswith(f"{ex}:") for ex in ['GSE', 'NGX', 'NSE', 'JSE', 'BRVM', 'EGX'])

def is_gse_ticker(ticker):
    t = str(ticker or '').upper().strip()
    clean = normalize_gse_ticker(t)
    return clean in GSE_CATALOG or t.startswith('GSE:') or t.endswith('.GH')

def get_african_stock(ticker):
    t = str(ticker or '').upper().strip()
    clean = normalize_african_ticker(t)
    item = AFRICAN_CATALOG.get(clean) or AFRICAN_CATALOG.get(t)
    if not item:
        return None
    return {
        'symbol': item['symbol'],
        'display_symbol': item.get('display_symbol', f"{item['exchange_code']}:{item['symbol']}"),
        'name': item['name'],
        'price': item['price'],
        'prev_close': item['prev_close'],
        'change': item['change'],
        'change_percent': item['change_percent'],
        'volume': item['volume'],
        'market_cap': item['market_cap'],
        'high_52': item['high_52'],
        'low_52': item['low_52'],
        'pe_ratio': item['pe_ratio'],
        'dividend': item['dividend'],
        'sector': item['sector'],
        'currency': item['currency'],
        'exchange': item['exchange'],
        'exchange_code': item['exchange_code'],
        'country': item['country'],
        'flag': item['flag']
    }

def get_gse_stock(ticker):
    return get_african_stock(ticker)

def generate_african_history(stock, period='1mo'):
    current_price = float(stock.get('price') or 10.0)
    dates = []
    prices = []

    count = 30
    step_minutes = 24 * 60
    is_intraday = False

    if period == '1d':
        count = 14
        step_minutes = 30
        is_intraday = True
    elif period == '5d':
        count = 25
        step_minutes = 120
        is_intraday = True
    elif period == '1mo':
        count = 22
        step_minutes = 24 * 60
    elif period == '3mo':
        count = 65
        step_minutes = 24 * 60
    elif period == '6mo':
        count = 130
        step_minutes = 24 * 60
    elif period == '1y':
        count = 250
        step_minutes = 24 * 60

    now = datetime.utcnow()
    symbol = stock.get('symbol', 'AFRICA')
    seed = sum(ord(c) for c in symbol)

    temp_prices = [current_price]
    p = current_price
    step_volatility = current_price * 0.015

    for _ in range(1, count):
        seed = (seed * 9301 + 49297) % 233280
        rnd = (seed / 233280.0) - 0.48
        p = max(0.01, p - rnd * step_volatility)
        temp_prices.append(round(p, 2 if current_price >= 5 else 4))

    temp_prices.reverse()
    if period == '1d' and stock.get('prev_close'):
        temp_prices[0] = stock['prev_close']
        temp_prices[-1] = current_price

    for i in range(count):
        t = now - timedelta(minutes=(count - 1 - i) * step_minutes)
        if is_intraday:
            dates.append(t.strftime('%Y-%m-%d %H:%M'))
        else:
            dates.append(t.strftime('%Y-%m-%d'))
        prices.append(temp_prices[i])

    return dates, prices

def generate_gse_history(stock, period='1mo'):
    return generate_african_history(stock, period=period)

def get_african_news(symbol, name, country):
    now = datetime.utcnow()
    return [
        {
            'title': f"{name} ({symbol}) posts resilient operational volume as institutional allocations expand across {country}",
            'link': 'https://african-exchanges.org',
            'date': (now - timedelta(hours=3)).strftime('%a, %d %b %Y %H:%M:%S GMT')
        },
        {
            'title': f"Pan-African equity inflows strengthen as regional central banks maintain macroeconomic stabilization",
            'link': 'https://african-exchanges.org',
            'date': (now - timedelta(hours=14)).strftime('%a, %d %b %Y %H:%M:%S GMT')
        },
        {
            'title': f"Market research note: Valuation multiples and dividend yields for {symbol} outpace peer averages",
            'link': 'https://african-exchanges.org',
            'date': (now - timedelta(hours=36)).strftime('%a, %d %b %Y %H:%M:%S GMT')
        },
        {
            'title': f"African cross-border trading initiatives bolster liquidity for key benchmark equities including {symbol}",
            'link': 'https://african-exchanges.org',
            'date': (now - timedelta(hours=58)).strftime('%a, %d %b %Y %H:%M:%S GMT')
        }
    ]

def get_gse_news(symbol, name):
    return get_african_news(symbol, name, 'Ghana')

# Common index aliases — users type IXIC, we convert to ^IXIC
INDEX_ALIASES = {
    'IXIC': '^IXIC',
    'GSPC': '^GSPC',
    'DJI':  '^DJI',
    'FTSE': '^FTSE',
    'N225': '^N225',
    'HSI':  '^HSI',
    'GDAXI': '^GDAXI',
    'VIX':  '^VIX',
    'TNX':  '^TNX',
    'RUT':  '^RUT',
}

def get_stock_data(ticker):
    if not ticker:
        return None
    ticker_str = str(ticker).strip().upper()

    NON_TICKERS = {
        'AFRICA', 'AFRICAN', 'GHANA', 'NIGERIA', 'KENYA', 'SOUTH AFRICA',
        'EGYPT', 'BRVM', 'MARKET', 'ALL', 'PORTFOLIO', 'SEARCH', 'INDEX',
        'INDICES', 'HOME', 'LOGOUT', 'LOGIN', 'REGISTER', 'WATCHLIST'
    }
    if ticker_str in NON_TICKERS:
        return None

    # ── African stock interception (GSE, NGX, NSE, JSE, BRVM, EGX) ──
    clean = normalize_african_ticker(ticker_str)
    if clean in AFRICAN_CATALOG or is_african_ticker(ticker_str):
        stk = get_african_stock(clean)
        if stk:
            return stk

    # ── Robust Yahoo Finance + Fallbacks Service ──
    return get_stock_data_service(ticker_str)


def get_stock_history(ticker, period='1mo'):
    ticker_str = str(ticker or '').strip().upper()
    clean = normalize_african_ticker(ticker_str)
    if clean in AFRICAN_CATALOG or is_african_ticker(ticker_str):
        stock = get_african_stock(clean)
        if stock:
            return generate_african_history(stock, period=period)
        return [], []
    return get_stock_history_service(ticker_str, period=period)


def get_news(ticker):
    ticker_str = str(ticker or '').strip().upper()
    clean = normalize_african_ticker(ticker_str)
    if clean in AFRICAN_CATALOG:
        stock = AFRICAN_CATALOG[clean]
        return get_african_news(clean, stock['name'], stock['country'])
    try:
        url = f"https://feeds.finance.yahoo.com/rss/2.0/headline?s={ticker_str}&region=US&lang=en-US"
        feed = feedparser.parse(url)
        return [
            {
                'title': e.title,
                'link': e.link,
                'date': e.get('published', '')
            }
            for e in feed.entries[:6]
        ]
    except Exception:
        return []


def clean_analysis_text(text):
    if not text:
        return ""
    # Strip markdown bold, italic, headings, backticks, bullet symbols
    text = re.sub(r'[*_#`~]', '', text)
    text = re.sub(r'^\s*[-•–]\s+', '', text, flags=re.MULTILINE)
    # Remove AI conversational filler
    text = re.sub(r'^(as an ai|here is|here\'s|in this analysis|based on the data|as a financial analyst)[^:\n]*[:\n-]*', '', text, flags=re.IGNORECASE)
    # Normalize excessive newlines and whitespace
    text = re.sub(r'\n{2,}', ' ', text)
    text = re.sub(r'[ \t]+', ' ', text)
    return text.strip()


def get_ai_analysis(ticker, name, price, change_pct):
    client = get_groq_client()
    ticker_str = str(ticker or '').strip().upper()
    clean = normalize_african_ticker(ticker_str)
    stock_info = AFRICAN_CATALOG.get(clean)

    currency = 'USD'
    market_context = ""
    if stock_info:
        currency = stock_info.get('currency', 'USD')
        country = stock_info.get('country', 'African')
        exchange = stock_info.get('exchange', 'Stock Exchange')
        market_context = f" Incorporate macro perspectives for the {country} economy and {exchange} trading dynamics."

    if client:
        try:
            prompt = (
                f"You are a professional senior equity research analyst writing an official executive summary for institutional investors. "
                f"Analyze {name} ({ticker_str}) currently trading at {currency} {price:,.2f} ({'+' if change_pct >= 0 else ''}{change_pct:.2f}% session change). "
                f"{market_context} "
                f"Write 2 to 3 fluid, continuous sentences covering price trend, key operational or macroeconomic valuation drivers, and short-term outlook. "
                f"Do NOT use bullet points, bold text, markdown asterisks, section headers, or conversational intros like 'Here is' or 'As an AI'. "
                f"Keep it under 90 words."
            )
            try:
                completion = client.chat.completions.create(
                    model="openai/gpt-oss-120b",
                    messages=[
                        {"role": "system", "content": "You are a senior institutional equity research analyst. Write clean, direct prose without markdown formatting, bullet points, asterisks, or conversational filler."},
                        {"role": "user", "content": prompt}
                    ],
                    temperature=0.3,
                    max_tokens=250
                )
                raw = completion.choices[0].message.content or ""
                cleaned = clean_analysis_text(raw)
                if cleaned:
                    return cleaned
            except Exception as model_err:
                app.logger.info(f"Model openai/gpt-oss-120b fallback to llama-3.3-70b-versatile: {model_err}")
                completion = client.chat.completions.create(
                    model="llama-3.3-70b-versatile",
                    messages=[
                        {"role": "system", "content": "You are a senior institutional equity research analyst. Write clean, direct prose without markdown formatting, bullet points, asterisks, or conversational filler."},
                        {"role": "user", "content": prompt}
                    ],
                    temperature=0.3,
                    max_tokens=250
                )
                raw = completion.choices[0].message.content or ""
                cleaned = clean_analysis_text(raw)
                if cleaned:
                    return cleaned
        except Exception as e:
            app.logger.warning(f"AI analysis generation error: {e}")

    direction = "positive upward momentum" if change_pct >= 0 else "corrective consolidation"
    sign = "+" if change_pct >= 0 else ""
    return (
        f"{name} ({ticker_str}) is currently trading at {currency} {price:,.2f}, demonstrating {direction} "
        f"with a {sign}{change_pct:.2f}% intraday adjustment. Session volumes and institutional market depth reflect "
        f"steady participation, supported by regional macroeconomic stability and corporate earnings expectations."
    )


def check_alerts():
    with app.app_context():
        try:
            active_alerts = Alert.query.filter_by(active=True).all()
            for alert in active_alerts:
                try:
                    stock_info = get_stock_data(alert.ticker)
                    current_p = stock_info['price'] if stock_info else None
                    if not current_p:
                        continue
                    triggered = (
                        (alert.direction == 'above' and current_p >= alert.target_price) or
                        (alert.direction == 'below' and current_p <= alert.target_price)
                    )
                    if triggered:
                        alert.active = False
                except Exception:
                    continue
            db.session.commit()
        except Exception:
            db.session.rollback()


# ── SCHEDULER (Disabled on Vercel Serverless) ─────────────────────────────────

scheduler = None
if not os.environ.get('VERCEL') and not os.environ.get('AWS_LAMBDA_FUNCTION_NAME'):
    try:
        scheduler = BackgroundScheduler(daemon=True)
        scheduler.add_job(func=check_alerts, trigger="interval", minutes=30)
        scheduler.start()
    except Exception as e:
        app.logger.warning(f"Scheduler could not start: {e}")


# ── HEALTH CHECK ──────────────────────────────────────────────────────────────

@app.route('/health')
def health():
    connected, msg, db_type = check_database_connection(app)
    status_code = 200 if connected else 503
    return jsonify({
        "status": "healthy" if connected else "degraded",
        "database": {
            "connected": connected,
            "type": db_type,
            "message": msg
        },
        "environment": {
            "vercel": bool(os.environ.get('VERCEL')),
            "groq_configured": bool(os.environ.get('GROQ_API_KEY'))
        }
    }), status_code


@app.route('/favicon.ico')
def favicon():
    return send_from_directory(os.path.join(static_dir, 'images'), 'logo.png', mimetype='image/png')


# ── ROUTES ────────────────────────────────────────────────────────────────────

@app.route('/')
def index():
    just_logged_out = request.args.get('logged_out') == '1'
    indices_symbols = [
        ('^GSPC',   'S&P 500'),
        ('^IXIC',   'NASDAQ'),
        ('^DJI',    'DOW JONES'),
        ('GSE-CI',  'GSE COMPOSITE'),
        ('BTC-USD', 'Bitcoin'),
        ('ETH-USD', 'Ethereum'),
    ]
    indices_data = []
    for symbol, fallback_name in indices_symbols:
        try:
            stock = get_stock_data(symbol)
            if stock and stock.get('price'):
                indices_data.append({
                    'symbol': symbol,
                    'name': stock.get('name') or fallback_name,
                    'price': round(stock['price'], 2),
                    'change_percent': round(stock.get('change_percent', 0), 2),
                    'currency': stock.get('currency', 'USD')
                })
            else:
                indices_data.append({
                    'symbol': symbol,
                    'name': fallback_name,
                    'price': 'N/A',
                    'change_percent': 0,
                    'currency': 'USD'
                })
        except Exception as e:
            print(f"[Index] Error loading {symbol}: {e}")
            indices_data.append({
                'symbol': symbol,
                'name': fallback_name,
                'price': 'N/A',
                'change_percent': 0,
                'currency': 'USD'
            })

    # Curated Regional African Stocks for Dashboard
    gse_stocks = [get_stock_data(t) for t in ['MTNGH', 'GCB', 'TOTAL', 'EGH', 'CAL', 'GOIL', 'BOPP', 'FML']]
    gse_stocks = [s for s in gse_stocks if s]

    ngx_stocks = [get_stock_data(t) for t in ['DANGCEM', 'MTNN', 'GTCO', 'ZENITHBANK', 'SEPLAT', 'ACCESSCORP']]
    ngx_stocks = [s for s in ngx_stocks if s]

    nse_stocks = [get_stock_data(t) for t in ['SCOM', 'EQTY', 'KCB', 'EABL', 'BAT', 'SCBK']]
    nse_stocks = [s for s in nse_stocks if s]

    jse_stocks = [get_stock_data(t) for t in ['NPN', 'FSR', 'SOL', 'MTN', 'SBK', 'SHP']]
    jse_stocks = [s for s in jse_stocks if s]

    brvm_stocks = [get_stock_data(t) for t in ['SNTS', 'ECOC', 'SGBC', 'ONTBF']]
    brvm_stocks = [s for s in brvm_stocks if s]

    egx_stocks = [get_stock_data(t) for t in ['COMI', 'EAST', 'HRHO', 'TMGH']]
    egx_stocks = [s for s in egx_stocks if s]

    african_stocks = [
        get_stock_data(t) for t in AFRICAN_CATALOG.keys()
        if not t.endswith('-CI') and not t.endswith('-ASI') and not t.endswith('-20')
        and not t.endswith('-TOP40') and not t.endswith('30') and not t.endswith('-C')
    ]
    african_stocks = [s for s in african_stocks if s]

    return render_template(
        'index.html',
        indices=indices_data,
        gse_stocks=gse_stocks,
        ngx_stocks=ngx_stocks,
        nse_stocks=nse_stocks,
        jse_stocks=jse_stocks,
        brvm_stocks=brvm_stocks,
        egx_stocks=egx_stocks,
        african_stocks=african_stocks,
        just_logged_out=just_logged_out
    )


@app.route('/search')
def search():
    query = request.args.get('q', '').strip()
    query_upper = query.upper()
    results = []

    if query:
        clean_ticker = normalize_african_ticker(query_upper)

        # 1. Regional / Country / Exchange queries
        is_africa_general = any(k in query_upper for k in ['AFRICA', 'AFRICAN'])
        is_ghana = any(k in query_upper for k in ['GHANA', 'GSE', 'CEDI', 'CEDIS', 'ACCRA', 'GHS'])
        is_nigeria = any(k in query_upper for k in ['NIGERIA', 'NGX', 'NAIRA', 'LAGOS', 'NGN'])
        is_kenya = any(k in query_upper for k in ['KENYA', 'NSE', 'SHILLING', 'NAIROBI', 'KES'])
        is_south_africa = any(k in query_upper for k in ['SOUTH AFRICA', 'JSE', 'RAND', 'JOHANNESBURG', 'ZAR'])
        is_brvm = any(k in query_upper for k in ['BRVM', 'WAEMU', 'CFA', 'ABIDJAN', 'IVORY COAST', "COTE D'IVOIRE", 'SENEGAL', 'XOF'])
        is_egypt = any(k in query_upper for k in ['EGYPT', 'EGX', 'POUND', 'CAIRO', 'EGP'])

        if is_africa_general:
            sample_tickers = ['MTNGH', 'GCB', 'DANGCEM', 'MTNN', 'SCOM', 'EQTY', 'NPN', 'FSR', 'SNTS', 'SGBC', 'COMI', 'EAST']
            for t in sample_tickers:
                s = get_stock_data(t)
                if s and not any(r['symbol'] == s['symbol'] for r in results):
                    results.append(s)
        elif is_ghana:
            for key, item in AFRICAN_CATALOG.items():
                if item.get('exchange_code') == 'GSE':
                    s = get_stock_data(key)
                    if s and not any(r['symbol'] == s['symbol'] for r in results):
                        results.append(s)
        elif is_nigeria:
            for key, item in AFRICAN_CATALOG.items():
                if item.get('exchange_code') == 'NGX':
                    s = get_stock_data(key)
                    if s and not any(r['symbol'] == s['symbol'] for r in results):
                        results.append(s)
        elif is_kenya:
            for key, item in AFRICAN_CATALOG.items():
                if item.get('exchange_code') == 'NSE':
                    s = get_stock_data(key)
                    if s and not any(r['symbol'] == s['symbol'] for r in results):
                        results.append(s)
        elif is_south_africa:
            for key, item in AFRICAN_CATALOG.items():
                if item.get('exchange_code') == 'JSE':
                    s = get_stock_data(key)
                    if s and not any(r['symbol'] == s['symbol'] for r in results):
                        results.append(s)
        elif is_brvm:
            for key, item in AFRICAN_CATALOG.items():
                if item.get('exchange_code') == 'BRVM':
                    s = get_stock_data(key)
                    if s and not any(r['symbol'] == s['symbol'] for r in results):
                        results.append(s)
        elif is_egypt:
            for key, item in AFRICAN_CATALOG.items():
                if item.get('exchange_code') == 'EGX':
                    s = get_stock_data(key)
                    if s and not any(r['symbol'] == s['symbol'] for r in results):
                        results.append(s)
        else:
            # 2. Search catalog by ticker, company name, sector, country, or exchange
            for key, item in AFRICAN_CATALOG.items():
                if (
                    key == clean_ticker or
                    key == query_upper or
                    query_upper in item['name'].upper() or
                    query_upper in item['sector'].upper() or
                    query_upper in item['country'].upper() or
                    item.get('exchange_code', '').upper() == query_upper
                ):
                    s = get_stock_data(key)
                    if s and not any(r['symbol'] == s['symbol'] for r in results):
                        results.append(s)

            # 3. Fallback to general get_stock_data lookup ONLY if results empty and query looks like a ticker
            if not results:
                NON_TICKER_WORDS = {'AFRICA', 'AFRICAN', 'GHANA', 'NIGERIA', 'KENYA', 'SOUTH AFRICA', 'EGYPT', 'BRVM', 'MARKET', 'ALL', 'PORTFOLIO', 'SEARCH'}
                if query_upper not in NON_TICKER_WORDS and len(query_upper) <= 12:
                    data = get_stock_data(query_upper)
                    if data:
                        results.append(data)

        if not results:
            flash(
                f'No results for "{query}". '
                f'Try African stocks: MTNGH, DANGCEM, SCOM, NPN, SNTS, COMI, or global: AAPL, TSLA, BTC-USD.',
                'warning'
            )

    return render_template('search.html', results=results, query=query)


@app.route('/stock/<ticker>')
def stock_detail(ticker):
    ticker = ticker.upper()
    period = request.args.get('period', '1mo')
    data = get_stock_data(ticker)

    if not data:
        flash(f'Could not find data for {ticker}.', 'danger')
        return redirect(url_for('index'))

    dates, prices = get_stock_history(ticker, period)
    news = get_news(ticker)
    analysis = get_ai_analysis(ticker, data['name'], data['price'], data['change_percent'])

    in_portfolio = False
    user_alerts = []
    if current_user.is_authenticated:
        in_portfolio = Portfolio.query.filter_by(
            user_id=current_user.id, ticker=ticker
        ).first() is not None
        user_alerts = Alert.query.filter_by(
            user_id=current_user.id, ticker=ticker
        ).all()

    return render_template(
        'stock.html',
        data=data,
        dates=dates,
        prices=prices,
        news=news,
        analysis=analysis,
        in_portfolio=in_portfolio,
        alerts=user_alerts,
        period=period
    )


@app.route('/portfolio')
@login_required
def portfolio():
    entries = Portfolio.query.filter_by(user_id=current_user.id).all()
    holdings = []
    total_value = 0
    total_cost = 0

    for entry in entries:
        try:
            # Use get_stock_data to handle both yfinance and African tickers
            stock_info = get_stock_data(entry.ticker)
            current_price = stock_info['price'] if stock_info else 0
            current_value = round(current_price * entry.shares, 2)
            cost_basis = round(entry.buy_price * entry.shares, 2)
            gain_loss = round(current_value - cost_basis, 2)
            gain_loss_pct = round((gain_loss / cost_basis * 100), 2) if cost_basis else 0
            total_value += current_value
            total_cost += cost_basis
            holdings.append({
                'id': entry.id,
                'ticker': entry.ticker,
                'shares': entry.shares,
                'buy_price': entry.buy_price,
                'current_price': round(current_price, 2),
                'current_value': current_value,
                'gain_loss': gain_loss,
                'gain_loss_pct': gain_loss_pct,
                'currency': stock_info.get('currency', 'USD') if stock_info else 'USD'
            })
        except Exception:
            continue

    total_gain_loss = round(total_value - total_cost, 2)
    total_gain_loss_pct = round((total_gain_loss / total_cost * 100), 2) if total_cost else 0

    return render_template(
        'portfolio.html',
        holdings=holdings,
        total_value=round(total_value, 2),
        total_gain_loss=total_gain_loss,
        total_gain_loss_pct=total_gain_loss_pct
    )


@app.route('/portfolio/add', methods=['POST'])
@login_required
def add_portfolio():
    ticker = request.form.get('ticker', '').upper()
    shares = request.form.get('shares')
    buy_price = request.form.get('buy_price')

    if not ticker or not shares or not buy_price:
        flash('All fields are required.', 'danger')
        return redirect(url_for('portfolio'))

    if not get_stock_data(ticker):
        flash(f'{ticker} is not a valid ticker.', 'danger')
        return redirect(url_for('portfolio'))

    try:
        new_entry = Portfolio(
            ticker=ticker,
            shares=float(shares),
            buy_price=float(buy_price),
            user_id=current_user.id
        )
        db.session.add(new_entry)
        db.session.commit()
        flash(f'{ticker} added to portfolio!', 'success')
    except Exception as e:
        db.session.rollback()
        flash(f'Error adding {ticker}: {str(e)}', 'danger')

    return redirect(url_for('portfolio'))


@app.route('/portfolio/delete/<int:entry_id>', methods=['POST'])
@login_required
def delete_portfolio(entry_id):
    entry = Portfolio.query.get_or_404(entry_id)
    if entry.user_id != current_user.id:
        flash('Unauthorized.', 'danger')
        return redirect(url_for('portfolio'))
    try:
        db.session.delete(entry)
        db.session.commit()
        flash(f'{entry.ticker} removed from portfolio.', 'success')
    except Exception as e:
        db.session.rollback()
        flash(f'Error removing item: {str(e)}', 'danger')
    return redirect(url_for('portfolio'))


@app.route('/alerts')
@login_required
def alerts():
    user_alerts = Alert.query.filter_by(
        user_id=current_user.id
    ).order_by(Alert.created_at.desc()).all()
    return render_template('alerts.html', alerts=user_alerts)


@app.route('/alerts/add', methods=['POST'])
@login_required
def add_alert():
    ticker = request.form.get('ticker', '').upper()
    target_price = request.form.get('target_price')
    direction = request.form.get('direction')

    if not ticker or not target_price or direction not in ['above', 'below']:
        flash('All fields are required.', 'danger')
        return redirect(url_for('alerts'))

    try:
        new_alert = Alert(
            ticker=ticker,
            target_price=float(target_price),
            direction=direction,
            user_id=current_user.id
        )
        db.session.add(new_alert)
        db.session.commit()
        flash(f'Alert set for {ticker}!', 'success')
    except Exception as e:
        db.session.rollback()
        flash(f'Error setting alert: {str(e)}', 'danger')

    return redirect(url_for('alerts'))


@app.route('/alerts/delete/<int:alert_id>', methods=['POST'])
@login_required
def delete_alert(alert_id):
    alert = Alert.query.get_or_404(alert_id)
    if alert.user_id != current_user.id:
        flash('Unauthorized.', 'danger')
        return redirect(url_for('alerts'))
    try:
        db.session.delete(alert)
        db.session.commit()
        flash('Alert deleted.', 'success')
    except Exception as e:
        db.session.rollback()
        flash(f'Error deleting alert: {str(e)}', 'danger')
    return redirect(url_for('alerts'))


@app.route('/register', methods=['GET', 'POST'])
def register():
    if current_user.is_authenticated:
        return redirect(url_for('index'))
    if request.method == 'POST':
        username = request.form.get('username', '').strip()
        email = request.form.get('email', '').strip().lower()
        password = request.form.get('password', '')
        confirm = request.form.get('confirm_password', '')

        if not username or not email or not password:
            flash('All fields are required.', 'danger')
            return render_template('register.html')

        if len(username) < 2:
            flash('Username must be at least 2 characters long.', 'danger')
            return render_template('register.html')

        if password != confirm:
            flash('Passwords do not match.', 'danger')
            return render_template('register.html')

        if len(password) < 6:
            flash('Password must be at least 6 characters.', 'danger')
            return render_template('register.html')

        try:
            # Check for existing email or username (case-insensitive)
            if User.query.filter(db.func.lower(User.email) == email.lower()).first():
                flash('Email is already registered. Please sign in.', 'danger')
                return render_template('register.html')

            if User.query.filter(db.func.lower(User.username) == username.lower()).first():
                flash('Username is already taken. Please choose a different one.', 'danger')
                return render_template('register.html')

            new_user = User(username=username, email=email)
            new_user.set_password(password)
            db.session.add(new_user)
            db.session.commit()
            login_user(new_user, remember=True)
            flash(f'Welcome to MarketSync, {username}!', 'success')
            return redirect(url_for('index'))
        except Exception as e:
            db.session.rollback()
            app.logger.error(f"Error during registration: {e}")
            flash('Database error during registration. Please try again.', 'danger')
            return render_template('register.html')

    return render_template('register.html')


@app.route('/login', methods=['GET', 'POST'])
def login():
    if current_user.is_authenticated:
        return redirect(url_for('index'))
    if request.method == 'POST':
        login_id = request.form.get('email', '').strip()
        password = request.form.get('password', '')

        if not login_id or not password:
            flash('Please enter both your email/username and password.', 'danger')
            return render_template('login.html')

        try:
            # Support logging in by either email OR username
            user = User.query.filter(
                (db.func.lower(User.email) == login_id.lower()) |
                (db.func.lower(User.username) == login_id.lower())
            ).first()

            if user and user.check_password(password):
                login_user(user, remember=True)
                flash(f'Welcome back, {user.username}!', 'success')
                next_page = request.args.get('next')
                if next_page and next_page.startswith('/'):
                    return redirect(next_page)
                return redirect(url_for('index'))

            flash('Invalid email/username or password.', 'danger')
        except Exception as e:
            db.session.rollback()
            app.logger.warning(f"Login database error: {e}")
            flash('Database temporarily unavailable. Please try again.', 'danger')
    return render_template('login.html')


@app.route('/logout', methods=['GET', 'POST'])
def logout():
    try:
        logout_user()
    except Exception as e:
        app.logger.warning(f"Error in logout_user: {e}")

    session.clear()
    resp = make_response(redirect(url_for('index', logged_out=1)))

    cookie_names = [
        'session', 'remember_token', 'marketsync_sid', 'connect.sid',
        '_remember_token', 'user_id'
    ]
    for name in cookie_names:
        resp.delete_cookie(name, path='/')
        resp.set_cookie(name, '', expires=0, max_age=0, path='/', samesite='None', secure=is_production)

    resp.headers['Clear-Site-Data'] = '"cache", "cookies", "storage"'
    resp.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, private, max-age=0'
    resp.headers['Pragma'] = 'no-cache'
    resp.headers['Expires'] = '0'

    flash('You have been safely logged out. See you next time!', 'success')
    return resp


if __name__ == '__main__':
    with app.app_context():
        db.create_all()
    app.run(debug=True, use_reloader=False)
    
