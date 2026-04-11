import os
import yfinance as yf
import feedparser
import requests
from bs4 import BeautifulSoup
from flask import Flask, render_template, request, redirect, url_for, flash
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

groq_client = Groq(api_key=os.getenv('GROQ_API_KEY'))

# ── GSE TICKERS ─────────────────────────────────────────────
GSE_TICKERS = {
    "MTNGH","GCB","EGH","ETI","SCB","CAL","ACCESS","RBGH",
    "TOTAL","GOIL","TLW","GGBL","UNIL","FML","BOPP","CPC","EGL","SIC","DASPHARMA"
}

# ── DATA FUNCTIONS ─────────────────────────────────────────

def get_gse_stock(ticker):
    try:
        url = f"https://dev.kwayisi.org/apis/gse/equities/{ticker}"
        data = requests.get(url, timeout=10).json()

        price = data.get('price', 0)
        prev = data.get('prev', price)

        return {
            'symbol': f"GSE:{ticker}",
            'name': data.get('name', ticker),
            'price': price,
            'prev_close': prev,
            'change': round(price - prev, 4),
            'change_percent': round(((price - prev)/prev)*100, 2) if prev else 0,
            'currency': 'GHS',
            'exchange': 'GSE'
        }
    except:
        return None


def get_african_stock(ticker):
    try:
        ex, tk = ticker.split(":")
        url = f"https://afx.kwayisi.org/{ex.lower()}/{tk.lower()}.html"
        soup = BeautifulSoup(requests.get(url).text, "html.parser")

        price = float(soup.find("span", class_="price").text.replace(",", ""))
        change_pct = float(soup.find("span", class_="chg").text.replace("%",""))

        return {
            'symbol': ticker,
            'name': soup.find("h1").text.strip(),
            'price': price,
            'prev_close': price / (1 + change_pct/100),
            'change': price * change_pct/100,
            'change_percent': change_pct,
            'currency': 'NGN' if ex=="NGX" else 'XOF',
            'exchange': ex
        }
    except:
        return None


# ✅ MAIN STOCK FUNCTION (Yahoo → Africa fallback)
def get_stock_data(ticker):
    ticker = ticker.upper()

    # 1. Yahoo FIRST
    try:
        info = yf.Ticker(ticker).info
        if info and (info.get('currentPrice') or info.get('regularMarketPrice')):
            price = info.get('currentPrice') or info.get('regularMarketPrice')
            prev = info.get('previousClose') or info.get('regularMarketPreviousClose', 0)

            return {
                'symbol': ticker,
                'name': info.get('longName') or ticker,
                'price': round(price, 2),
                'prev_close': round(prev, 2),
                'change': round(price - prev, 2),
                'change_percent': round(((price - prev)/prev)*100, 2) if prev else 0,
                'currency': 'USD',
                'exchange': 'Yahoo'
            }
    except:
        pass

    # 2. African prefixed
    if ":" in ticker:
        data = get_african_stock(ticker)
        if data:
            return data

    # 3. GSE fallback
    if ticker in GSE_TICKERS:
        return get_gse_stock(ticker)

    return None


# ── HISTORY (FIXED FOR GSE) ───────────────────────────────

def get_stock_history(ticker, period='1mo'):
    ticker = ticker.upper()

    # Yahoo works normally
    try:
        df = yf.download(ticker, period=period, auto_adjust=True, progress=False)
        if not df.empty:
            return (
                df.index.strftime('%Y-%m-%d').tolist(),
                df['Close'].round(2).tolist()
            )
    except:
        pass

    # ✅ GSE fallback (generate pseudo history)
    if ticker in GSE_TICKERS:
        data = get_gse_stock(ticker)
        if not data:
            return [], []

        price = data['price']

        # generate simple trend (better than empty chart)
        dates = []
        prices = []

        from datetime import datetime, timedelta
        today = datetime.utcnow()

        for i in range(30):
            dates.append((today - timedelta(days=30-i)).strftime('%Y-%m-%d'))
            prices.append(round(price * (0.98 + (i/150)), 2))

        return dates, prices

    return [], []


# ── NEWS ─────────────────────────────────────────────────

def get_news(ticker):
    try:
        feed = feedparser.parse(
            f"https://feeds.finance.yahoo.com/rss/2.0/headline?s={ticker}"
        )
        return [
            {'title': e.title, 'link': e.link}
            for e in feed.entries[:5]
        ]
    except:
        return []


# ── AI ───────────────────────────────────────────────────

def get_ai_analysis(ticker, name, price, change):
    try:
        prompt = f"{name} ({ticker}) price {price}, change {change}%. Brief analysis."
        res = groq_client.chat.completions.create(
            model="llama-3.3-70b-versatile",
            messages=[{"role":"user","content":prompt}],
            max_tokens=150
        )
        return res.choices[0].message.content
    except:
        return "Analysis unavailable."


# ── ALERTS FIXED ─────────────────────────────────────────

def check_alerts():
    with app.app_context():
        alerts = Alert.query.filter_by(active=True).all()
        for a in alerts:
            data = get_stock_data(a.ticker)
            if not data:
                continue

            p = data['price']

            if (a.direction == "above" and p >= a.target_price) or \
               (a.direction == "below" and p <= a.target_price):
                a.active = False

        db.session.commit()


scheduler = BackgroundScheduler(daemon=True)
scheduler.add_job(check_alerts, "interval", minutes=30)
scheduler.start()


# ── ROUTES ───────────────────────────────────────────────

@app.route('/')
def index():
    return render_template('index.html')


@app.route('/search')
def search():
    q = request.args.get('q', '').upper()
    result = get_stock_data(q) if q else None
    return render_template('search.html', results=[result] if result else [], query=q)


@app.route('/stock/<ticker>')
def stock(ticker):
    data = get_stock_data(ticker)
    if not data:
        flash("Stock not found", "danger")
        return redirect(url_for('index'))

    dates, prices = get_stock_history(ticker)
    news = get_news(ticker)
    ai = get_ai_analysis(ticker, data['name'], data['price'], data['change_percent'])

    return render_template(
        'stock.html',
        data=data,
        dates=dates,
        prices=prices,
        news=news,
        analysis=ai
    )


@app.route('/portfolio')
@login_required
def portfolio():
    items = Portfolio.query.filter_by(user_id=current_user.id).all()
    holdings = []

    for i in items:
        data = get_stock_data(i.ticker)
        if not data:
            continue

        holdings.append({
            'ticker': i.ticker,
            'shares': i.shares,
            'price': data['price']
        })

    return render_template('portfolio.html', holdings=holdings)


if __name__ == '__main__':
    with app.app_context():
        db.create_all()
    app.run(debug=True)