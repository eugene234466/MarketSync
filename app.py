import os
import yfinance as yf
import feedparser
import requests
from bs4 import BeautifulSoup
from datetime import datetime, timedelta
from flask import Flask, render_template, request, jsonify, redirect, url_for, flash
from flask_login import login_user, logout_user, login_required, current_user
from groq import Groq
from dotenv import load_dotenv
from apscheduler.schedulers.background import BackgroundScheduler
from models import db, bcrypt, login_manager, User, Portfolio, Alert

load_dotenv()

app = Flask(__name__)
app.config['SECRET_KEY'] = os.getenv('SECRET_KEY', 'dev_key_123')
app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///marketsync.db'
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
# Added timeout for SQLite to prevent locking issues with background threads
app.config['SQLALCHEMY_ENGINE_OPTIONS'] = {'connect_args': {'timeout': 15}}

db.init_app(app)
bcrypt.init_app(app)
login_manager.init_app(app)
login_manager.login_view = 'login'

with app.app.context():
   db.create_all()

groq_client = Groq(api_key=os.getenv('GROQ_API_KEY'))

# ── HELPER FUNCTIONS ──────────────────────────────────────────────────────────

HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
}

_african_cache = {}
CACHE_TTL = timedelta(minutes=15)

def _get_cached(ticker):
    if ticker in _african_cache:
        data, ts = _african_cache[ticker]
        if datetime.now() - ts < CACHE_TTL:
            return data
    return None

def _set_cached(ticker, data):
    _african_cache[ticker] = (data, datetime.now())

def _parse_number(text):
    try:
        return float(str(text).replace(',', '').replace(' ', '').strip())
    except:
        return None

# ── AFRICAN STOCK SCRAPERS ───────────────────────────────────────────────────

def get_gse_stock(ticker):
    ticker = ticker.upper()
    cache_key = f"GSE:{ticker}"
    cached = _get_cached(cache_key)
    if cached: return cached

    try:
        url = f"https://dev.kwayisi.org/apis/gse/equities/{ticker}"
        res = requests.get(url, headers=HEADERS, timeout=6)
        if res.status_code != 200: return None
        data = res.json()
        price = _parse_number(data.get('price', 0)) or 0
        change_pct = _parse_number(data.get('change', 0)) or 0
        change = round(price * change_pct / 100, 4)
        prev = round(price - change, 4)
        result = {
            'symbol': cache_key, 'name': data.get('name', ticker), 'price': round(price, 4),
            'prev_close': round(prev, 4), 'change': round(change, 4), 'change_percent': round(change_pct, 2),
            'currency': 'GHS', 'exchange': 'Ghana Stock Exchange'
        }
        _set_cached(cache_key, result)
        return result
    except: return None

def get_african_stock_afx(ticker, exchange):
    cache_key = f"{exchange.upper()}:{ticker.upper()}"
    cached = _get_cached(cache_key)
    if cached: return cached

    try:
        ex_slug = {'NGX': 'ngx', 'BRVM': 'brvm'}.get(exchange.upper())
        url = f"https://afx.kwayisi.org/{ex_slug}/{ticker.lower()}.html"
        res = requests.get(url, headers=HEADERS, timeout=6)
        if res.status_code != 200: return None
        soup = BeautifulSoup(res.text, 'html.parser')
        
        price = None
        for table in soup.find_all('table'):
            for row in table.find_all('tr'):
                cells = row.find_all('td')
                if len(cells) >= 2 and any(k in cells[0].text.lower() for k in ['price', 'last']):
                    price = _parse_number(cells[1].text)
        
        if not price: return None
        result = {
            'symbol': cache_key, 'name': ticker.upper(), 'price': round(price, 4),
            'prev_close': 0, 'change': 0, 'change_percent': 0,
            'currency': 'NGN' if exchange == 'NGX' else 'XOF', 'exchange': exchange
        }
        _set_cached(cache_key, result)
        return result
    except: return None

# ── CORE DATA ENGINE ─────────────────────────────────────────────────────────

def get_stock_data(ticker):
    """Primary: Yahoo Finance, Fallback: African Scrapers."""
    ticker = ticker.upper()
    
    # 1. Try Yahoo Finance
    try:
        stock = yf.Ticker(ticker)
        # Use fast_info for performance
        f_info = stock.fast_info
        if f_info.get('last_price'):
            prev = f_info.get('previous_close', 0)
            price = f_info['last_price']
            return {
                'symbol': ticker,
                'name': stock.info.get('longName', ticker),
                'price': round(price, 2),
                'prev_close': round(prev, 2),
                'change': round(price - prev, 2),
                'change_percent': round(((price - prev) / prev * 100), 2) if prev else 0,
                'currency': 'USD',
                'exchange': 'Yahoo Finance'
            }
    except:
        pass

    # 2. Fallback for African exchanges
    if ':' in ticker:
        parts = ticker.split(':')
        if parts[0] == 'GSE': return get_gse_stock(parts[1])
        if parts[0] in ['NGX', 'BRVM']: return get_african_stock_afx(parts[1], parts[0])
        
    return None

def get_stock_history(ticker, period='1mo'):
    if ':' in ticker: return [], []
    try:
        df = yf.download(ticker, period=period, progress=False)
        return df.index.strftime('%Y-%m-%d').tolist(), df['Close'].squeeze().round(2).tolist()
    except: return [], []

def get_news(ticker):
    try:
        url = f"https://feeds.finance.yahoo.com/rss/2.0/headline?s={ticker.split(':')[-1]}&region=US&lang=en-US"
        return [{'title': e.title, 'link': e.link, 'date': e.get('published', '')} for e in feedparser.parse(url).entries[:6]]
    except: return []

def get_ai_analysis(ticker, name, price, change_pct):
    try:
        completion = groq_client.chat.completions.create(
            model="llama-3.3-70b-versatile",
            messages=[{"role": "user", "content": f"Brief analysis of {name} ({ticker}). Price: {price}, Change: {change_pct}%."}],
            temperature=0.3, max_tokens=300
        )
        return completion.choices[0].message.content
    except: return "AI analysis unavailable."

def check_alerts():
    with app.app_context():
        for alert in Alert.query.filter_by(active=True).all():
            data = get_stock_data(alert.ticker)
            if data and data.get('price'):
                triggered = (alert.direction == 'above' and data['price'] >= alert.target_price) or \
                            (alert.direction == 'below' and data['price'] <= alert.target_price)
                if triggered: alert.active = False
        db.session.commit()

scheduler = BackgroundScheduler(daemon=True)
scheduler.add_job(func=check_alerts, trigger="interval", minutes=30)
scheduler.start()

# ── ROUTES ────────────────────────────────────────────────────────────────────

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/portfolio')
@login_required
def portfolio():
    holdings = []
    for entry in Portfolio.query.filter_by(user_id=current_user.id).all():
        data = get_stock_data(entry.ticker)
        if data:
            curr = data['price']
            holdings.append({'ticker': entry.ticker, 'shares': entry.shares, 'current_price': curr, 'gain': (curr - entry.buy_price) * entry.shares})
    return render_template('portfolio.html', holdings=holdings)

# ... (Include your existing search, stock_detail, login/register routes here)

if __name__ == '__main__':
    app.run(debug=True)
