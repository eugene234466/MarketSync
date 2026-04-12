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
# Fix for SQLite database locking during background scheduler tasks
app.config['SQLALCHEMY_ENGINE_OPTIONS'] = {'connect_args': {'timeout': 20}}

db.init_app(app)
bcrypt.init_app(app)
login_manager.init_app(app)
login_manager.login_view = 'login'

with app.app_context():
   db.create_all()

groq_client = Groq(api_key=os.getenv('GROQ_API_KEY'))

# ── HELPER FUNCTIONS & SCRAPERS ──────────────────────────────────────────────
HEADERS = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'}
_african_cache = {}
CACHE_TTL = timedelta(minutes=15)

def _get_cached(ticker):
    if ticker in _african_cache:
        data, ts = _african_cache[ticker]
        if datetime.now() - ts < CACHE_TTL: return data
    return None

def _set_cached(ticker, data): _african_cache[ticker] = (data, datetime.now())

def _parse_number(text):
    try: return float(str(text).replace(',', '').replace(' ', '').strip())
    except: return None

def get_gse_stock(ticker):
    cache_key = f"GSE:{ticker.upper()}"
    cached = _get_cached(cache_key)
    if cached: return cached
    try:
        url = f"https://dev.kwayisi.org/apis/gse/equities/{ticker.upper()}"
        res = requests.get(url, headers=HEADERS, timeout=6)
        if res.status_code != 200: return None
        data = res.json()
        price = _parse_number(data.get('price', 0)) or 0
        result = {'symbol': cache_key, 'name': data.get('name', ticker), 'price': round(price, 4), 'currency': 'GHS', 'exchange': 'Ghana Stock Exchange'}
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
        soup = BeautifulSoup(res.text, 'html.parser')
        price = None
        for table in soup.find_all('table'):
            for row in table.find_all('tr'):
                cells = row.find_all('td')
                if len(cells) >= 2 and 'price' in cells[0].text.lower(): price = _parse_number(cells[1].text)
        if not price: return None
        result = {'symbol': cache_key, 'name': ticker.upper(), 'price': round(price, 4), 'currency': 'NGN' if exchange=='NGX' else 'XOF', 'exchange': exchange}
        _set_cached(cache_key, result)
        return result
    except: return None

# ── CORE DATA ENGINE ─────────────────────────────────────────────────────────

def get_stock_data(ticker):
    """Primary: Yahoo Finance, Backup: African Scrapers."""
    ticker = ticker.upper()
    
    # 1. Try Yahoo Finance
    try:
        stock = yf.Ticker(ticker)
        last_price = stock.fast_info.get('last_price')
        if last_price:
            prev = stock.fast_info.get('previous_close', 0)
            return {
                'symbol': ticker, 'name': stock.info.get('longName', ticker),
                'price': round(last_price, 2), 'change': round(last_price - prev, 2),
                'change_percent': round(((last_price - prev) / prev * 100), 2) if prev else 0,
                'exchange': 'Yahoo Finance'
            }
    except: pass

    # 2. Backup: African Scrapers
    if ':' in ticker:
        parts = ticker.split(':')
        if parts[0] == 'GSE': return get_gse_stock(parts[1])
        if parts[0] in ['NGX', 'BRVM']: return get_african_stock_afx(parts[1], parts[0])
    return None

# ── ROUTES ────────────────────────────────────────────────────────────────────

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/search')
def search():
    query = request.args.get('q', '').strip().upper()
    data = get_stock_data(query) if query else None
    return render_template('search.html', results=[data] if data else [], query=query)

@app.route('/stock/<ticker>')
def stock_detail(ticker):
    data = get_stock_data(ticker)
    if not data: flash('Ticker not found', 'danger'); return redirect(url_for('index'))
    return render_template('stock.html', data=data)

@app.route('/portfolio')
@login_required
def portfolio():
    holdings = []
    for entry in Portfolio.query.filter_by(user_id=current_user.id).all():
        data = get_stock_data(entry.ticker)
        if data:
            holdings.append({'ticker': entry.ticker, 'shares': entry.shares, 'price': data['price']})
    return render_template('portfolio.html', holdings=holdings)

# ... (Add your remaining routes: /register, /login, /alerts, /portfolio/add, /delete, etc. here)

# ── SCHEDULER ─────────────────────────────────────────────────────────────────
def check_alerts():
    with app.app_context():
        for alert in Alert.query.filter_by(active=True).all():
            data = get_stock_data(alert.ticker)
            if data and ((alert.direction == 'above' and data['price'] >= alert.target_price) or 
                         (alert.direction == 'below' and data['price'] <= alert.target_price)):
                alert.active = False
        db.session.commit()

scheduler = BackgroundScheduler(daemon=True)
scheduler.add_job(func=check_alerts, trigger="interval", minutes=30)
scheduler.start()

if __name__ == '__main__':
    app.run(debug=True)
