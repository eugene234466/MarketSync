import os
import yfinance as yf
import feedparser
import requests
from bs4 import BeautifulSoup
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

db.init_app(app)
bcrypt.init_app(app)
login_manager.init_app(app)
login_manager.login_view = 'login'

with app.app_context():
  db.create_all()

groq_client = Groq(api_key=os.getenv('GROQ_API_KEY'))

# ── GSE TICKERS ───────────────────────────────────────────────
GSE_TICKERS = {
    "MTNGH", "GCB", "EGH", "ETI", "SCB", "CAL", "ACCESS", "RBGH",
    "TOTAL", "GOIL", "TLW",
    "GGBL", "UNIL", "FML",
    "BOPP", "CPC",
    "EGL", "SIC", "DASPHARMA"
}

# ── AFRICAN STOCK FUNCTIONS ───────────────────────────────────

AFRICAN_EXCHANGES = {
    'GSE': 'Ghana Stock Exchange (GHS)',
    'NGX': 'Nigerian Exchange (NGN)',
    'BRVM': 'BRVM West Africa (XOF)'
}

def get_gse_stock(ticker):
    try:
        ticker = ticker.upper()
        url = f"https://dev.kwayisi.org/apis/gse/equities/{ticker}"
        res = requests.get(url, timeout=10)
        if res.status_code == 404:
            return None
        data = res.json()

        price = data.get('price', 0)
        prev = data.get('prev', price)
        change = round(price - prev, 4)
        change_pct = round((change / prev * 100), 2) if prev else 0

        return {
            'symbol': f"GSE:{ticker}",
            'name': data.get('name', ticker),
            'price': price,
            'prev_close': prev,
            'change': change,
            'change_percent': change_pct,
            'volume': data.get('volume'),
            'market_cap': None,
            'high_52': None,
            'low_52': None,
            'pe_ratio': None,
            'dividend': None,
            'currency': 'GHS',
            'exchange': 'Ghana Stock Exchange'
        }
    except Exception:
        return None


def get_african_stock_afx(ticker, exchange):
    try:
        exchange_map = {
            'NGX': 'ngx',
            'BRVM': 'brvm'
        }
        ex = exchange_map.get(exchange.upper())
        if not ex:
            return None

        ticker = ticker.lower()
        url = f"https://afx.kwayisi.org/{ex}/{ticker}.html"
        headers = {'User-Agent': 'Mozilla/5.0'}
        res = requests.get(url, headers=headers, timeout=10)
        if res.status_code != 200:
            return None

        soup = BeautifulSoup(res.text, 'html.parser')

        price_el = soup.find('span', class_='price')
        change_el = soup.find('span', class_='chg')
        name_el = soup.find('h1')

        if not price_el:
            return None

        price = float(price_el.text.strip().replace(',', ''))
        change_text = change_el.text.strip() if change_el else '0'
        change_pct = float(change_text.replace('%', '').strip())

        change = round(price * change_pct / 100, 4)
        prev = round(price - change, 4)
        name = name_el.text.strip() if name_el else ticker.upper()

        currency = 'NGN' if exchange == 'NGX' else 'XOF'
        exchange_name = 'Nigerian Exchange' if exchange == 'NGX' else 'BRVM West Africa'

        return {
            'symbol': f"{exchange.upper()}:{ticker.upper()}",
            'name': name,
            'price': price,
            'prev_close': prev,
            'change': change,
            'change_percent': change_pct,
            'volume': None,
            'market_cap': None,
            'high_52': None,
            'low_52': None,
            'pe_ratio': None,
            'dividend': None,
            'currency': currency,
            'exchange': exchange_name
        }
    except Exception:
        return None


def get_african_stock(ticker_str):
    try:
        if ':' not in ticker_str:
            return None

        exchange, ticker = ticker_str.upper().split(':', 1)

        if exchange == 'GSE':
            return get_gse_stock(ticker)
        elif exchange in ['NGX', 'BRVM']:
            return get_african_stock_afx(ticker, exchange)

        return None
    except Exception:
        return None


def get_stock_data(ticker):
    ticker = ticker.upper()

    # ✅ Auto-detect Ghana stocks
    if ticker in GSE_TICKERS:
        return get_gse_stock(ticker)

    # ── African prefixed tickers ──
    if ':' in ticker:
        african_data = get_african_stock(ticker)
        if african_data:
            return african_data
        return None

    # ── Yahoo fallback ──
    try:
        stock = yf.Ticker(ticker)
        info = stock.info

        if not info or not info.get('currentPrice') and not info.get('regularMarketPrice'):
            return None

        price = info.get('currentPrice') or info.get('regularMarketPrice', 0)
        prev_close = info.get('previousClose') or info.get('regularMarketPreviousClose', 0)

        change = price - prev_close
        change_percent = (change / prev_close * 100) if prev_close else 0

        return {
            'symbol': ticker.upper(),
            'name': info.get('longName') or info.get('shortName', ticker),
            'price': round(price, 2),
            'prev_close': round(prev_close, 2),
            'change': round(change, 2),
            'change_percent': round(change_percent, 2),
            'volume': info.get('volume'),
            'market_cap': info.get('marketCap'),
            'high_52': info.get('fiftyTwoWeekHigh'),
            'low_52': info.get('fiftyTwoWeekLow'),
            'pe_ratio': info.get('trailingPE'),
            'dividend': info.get('dividendYield'),
            'currency': 'USD',
            'exchange': info.get('exchange', 'Yahoo Finance')
        }
    except Exception:
        return None


def get_stock_history(ticker, period='1mo'):
    try:
        df = yf.download(ticker, period=period, auto_adjust=True, progress=False)
        if df.empty:
            return [], []
        dates = df.index.strftime('%Y-%m-%d').tolist()
        prices = df['Close'].squeeze().round(2).tolist()
        return dates, prices
    except Exception:
        return [], []


def get_news(ticker):
    try:
        url = f"https://feeds.finance.yahoo.com/rss/2.0/headline?s={ticker}&region=US&lang=en-US"
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


def get_ai_analysis(ticker, name, price, change_pct):
    try:
        prompt = (
            f"You are a financial analyst. Give a brief analysis of {name} ({ticker}). "
            f"Current price: ${price}. Change today: {change_pct:.2f}%. "
            f"Keep it under 150 words."
        )

        completion = groq_client.chat.completions.create(
            model="llama-3.3-70b-versatile",
            messages=[
                {"role": "system", "content": "Be concise and clear."},
                {"role": "user", "content": prompt}
            ],
            temperature=0.3,
            max_tokens=300
        )

        return completion.choices[0].message.content
    except Exception as e:
        return f"AI analysis unavailable: {str(e)}"


def check_alerts():
    with app.app_context():
        try:
            active_alerts = Alert.query.filter_by(active=True).all()

            for alert in active_alerts:
                data = get_stock_data(alert.ticker)
                if not data:
                    continue

                current_p = data['price']

                triggered = (
                    (alert.direction == 'above' and current_p >= alert.target_price) or
                    (alert.direction == 'below' and current_p <= alert.target_price)
                )

                if triggered:
                    alert.active = False

            db.session.commit()
        except Exception:
            pass


# ── SCHEDULER ─────────────────────────────────────────────────

scheduler = BackgroundScheduler(daemon=True)
scheduler.add_job(func=check_alerts, trigger="interval", minutes=30)
scheduler.start()

# ── ROUTES ────────────────────────────────────────────────────

@app.route('/')
def index():
    indices_symbols = ['^GSPC', '^IXIC', '^DJI', 'BTC-USD', 'ETH-USD']
    indices_data = []

    for symbol in indices_symbols:
        try:
            info = yf.Ticker(symbol).info
            price = info.get('currentPrice') or info.get('regularMarketPrice')
            prev = info.get('previousClose') or info.get('regularMarketPreviousClose', 0)
            change_pct = round(((price - prev) / prev * 100), 2) if prev else 0

            indices_data.append({
                'symbol': symbol,
                'name': info.get('shortName', symbol),
                'price': round(price, 2) if price else 'N/A',
                'change_percent': change_pct
            })
        except Exception:
            continue

    return render_template('index.html', indices=indices_data)


@app.route('/search')
def search():
    query = request.args.get('q', '').strip().upper()
    results = []

    if query:
        data = get_stock_data(query)
        if data:
            results.append(data)

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

    return render_template(
        'stock.html',
        data=data,
        dates=dates,
        prices=prices,
        news=news,
        analysis=analysis,
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
        data = get_stock_data(entry.ticker)
        if not data:
            continue

        current_price = data['price']

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
            'gain_loss_pct': gain_loss_pct
        })

    total_gain_loss = round(total_value - total_cost, 2)
    total_gain_loss_pct = round((total_gain_loss / total_cost * 100), 2) if total_cost else 0

    return render_template(
        'portfolio.html',
        holdings=holdings,
        total_value=round(total_value, 2),
        total_gain_loss=total_gain_loss,
        total_gain_loss_pct=total_gain_loss_pct
    )


if __name__ == '__main__':
    app.run(debug=True)
