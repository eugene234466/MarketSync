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


# ── HELPER FUNCTIONS ──────────────────────────────────────────────────────────

# ── AFRICAN STOCK FUNCTIONS ───────────────────────────────────────────────────

# Exchange prefixes users can type
# GSE:MTNGH  → Ghana Stock Exchange
# NGX:DANGCEM → Nigerian Exchange
# BRVM:SNTS  → BRVM (West Africa)

AFRICAN_EXCHANGES = {
    'GSE': 'Ghana Stock Exchange (GHS)',
    'NGX': 'Nigerian Exchange (NGN)',
    'BRVM': 'BRVM West Africa (XOF)'
}

def get_gse_stock(ticker):
    """Fetch GSE stock from free dev.kwayisi.org API"""
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
    """Scrape NGX or BRVM stock from afx.kwayisi.org"""
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

        # Extract price from page
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
    """
    Parse African exchange prefix and fetch data.
    Accepts: GSE:MTNGH, NGX:DANGCEM, BRVM:SNTS
    """
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
    # ── Try African exchange prefix first (GSE:, NGX:, BRVM:) ──
    if ':' in ticker:
        african_data = get_african_stock(ticker)
        if african_data:
            return african_data
        return None

    # ── Try Yahoo Finance ──
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
            f"Cover: current trend, key factors affecting price, and short-term outlook. "
            f"Keep it concise, clear and under 150 words."
        )
        completion = groq_client.chat.completions.create(
            model="llama-3.3-70b-versatile",
            messages=[
                {
                    "role": "system",
                    "content": "You are a professional financial analyst. Be concise, factual and clear."
                },
                {
                    "role": "user",
                    "content": prompt
                }
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
                try:
                    info = yf.Ticker(alert.ticker).info
                    current_p = info.get('currentPrice') or info.get('regularMarketPrice')
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
            pass


# ── SCHEDULER ─────────────────────────────────────────────────────────────────

scheduler = BackgroundScheduler(daemon=True)
scheduler.add_job(func=check_alerts, trigger="interval", minutes=30)
scheduler.start()


# ── ROUTES ────────────────────────────────────────────────────────────────────

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
            info = yf.Ticker(entry.ticker).info
            current_price = info.get('currentPrice') or info.get('regularMarketPrice', 0)
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
        flash(f'Error adding {ticker}: {str(e)}', 'danger')

    return redirect(url_for('portfolio'))


@app.route('/portfolio/delete/<int:entry_id>', methods=['POST'])
@login_required
def delete_portfolio(entry_id):
    entry = Portfolio.query.get_or_404(entry_id)
    if entry.user_id != current_user.id:
        flash('Unauthorized.', 'danger')
        return redirect(url_for('portfolio'))
    db.session.delete(entry)
    db.session.commit()
    flash(f'{entry.ticker} removed from portfolio.', 'success')
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
        flash(f'Error setting alert: {str(e)}', 'danger')

    return redirect(url_for('alerts'))


@app.route('/alerts/delete/<int:alert_id>', methods=['POST'])
@login_required
def delete_alert(alert_id):
    alert = Alert.query.get_or_404(alert_id)
    if alert.user_id != current_user.id:
        flash('Unauthorized.', 'danger')
        return redirect(url_for('alerts'))
    db.session.delete(alert)
    db.session.commit()
    flash('Alert deleted.', 'success')
    return redirect(url_for('alerts'))


@app.route('/register', methods=['GET', 'POST'])
def register():
    if current_user.is_authenticated:
        return redirect(url_for('index'))
    if request.method == 'POST':
        username = request.form.get('username', '').strip()
        email = request.form.get('email', '').strip().lower()
        password = request.form.get('password', '')

        if User.query.filter_by(email=email).first():
            flash('Email already registered.', 'danger')
            return render_template('register.html')
        if User.query.filter_by(username=username).first():
            flash('Username already taken.', 'danger')
            return render_template('register.html')

        new_user = User(username=username, email=email)
        new_user.set_password(password)
        db.session.add(new_user)
        db.session.commit()
        login_user(new_user)
        flash(f'Welcome to MarketSync, {username}!', 'success')
        return redirect(url_for('index'))

    return render_template('register.html')


@app.route('/login', methods=['GET', 'POST'])
def login():
    if current_user.is_authenticated:
        return redirect(url_for('index'))
    if request.method == 'POST':
        email = request.form.get('email', '').strip().lower()
        password = request.form.get('password', '')
        user = User.query.filter_by(email=email).first()
        if user and user.check_password(password):
            login_user(user, remember=True)
            flash(f'Welcome back, {user.username}!', 'success')
            next_page = request.args.get('next')
            return redirect(next_page or url_for('index'))
        flash('Invalid email or password.', 'danger')
    return render_template('login.html')


@app.route('/logout')
@login_required
def logout():
    logout_user()
    flash('Logged out successfully.', 'success')
    return redirect(url_for('index'))


if __name__ == '__main__':
    app.run(debug=True)
