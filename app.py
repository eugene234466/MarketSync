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
# Supported prefixes:
#   GSE:MTNGH    → Ghana Stock Exchange  (dev.kwayisi.org JSON API)
#   NGX:DANGCEM  → Nigerian Exchange     (afx.kwayisi.org scraper)
#   BRVM:SNTS    → BRVM West Africa      (afx.kwayisi.org scraper)

AFRICAN_EXCHANGES = {
    'GSE':  'Ghana Stock Exchange (GHS)',
    'NGX':  'Nigerian Exchange (NGN)',
    'BRVM': 'BRVM West Africa (XOF)'
}

HEADERS = {
    'User-Agent': (
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
        'AppleWebKit/537.36 (KHTML, like Gecko) '
        'Chrome/120.0.0.0 Safari/537.36'
    )
}


def _parse_number(text):
    """Safely parse a number string — strips commas, spaces."""
    try:
        return float(str(text).replace(',', '').replace(' ', '').strip())
    except Exception:
        return None


def get_gse_stock(ticker):
    """
    Fetch GSE stock via dev.kwayisi.org free JSON API.
    API returns: { name, price, change, volume, ... }
    change field is already the % change value.
    """
    try:
        ticker = ticker.upper()
        # Try individual equity endpoint
        url = f"https://dev.kwayisi.org/apis/gse/equities/{ticker}"
        res = requests.get(url, headers=HEADERS, timeout=12)
        if res.status_code == 404:
            return None
        if res.status_code != 200:
            return None
        data = res.json()
        price = _parse_number(data.get('price', 0)) or 0
        # API returns 'change' as percent change
        change_pct = _parse_number(data.get('change', 0)) or 0
        change = round(price * change_pct / 100, 4)
        prev = round(price - change, 4) if change else price
        return {
            'symbol': f"GSE:{ticker}",
            'name': data.get('name', ticker),
            'price': round(price, 4),
            'prev_close': round(prev, 4),
            'change': round(change, 4),
            'change_percent': round(change_pct, 2),
            'volume': data.get('volume'),
            'market_cap': None,
            'high_52': None,
            'low_52': None,
            'pe_ratio': None,
            'dividend': None,
            'currency': 'GHS',
            'exchange': 'Ghana Stock Exchange'
        }
    except Exception as e:
        print(f"[GSE] Error fetching {ticker}: {e}")
        return None


def get_gse_all():
    """Fetch all live GSE stocks — used for search."""
    try:
        res = requests.get(
            "https://dev.kwayisi.org/apis/gse/live",
            headers=HEADERS, timeout=12
        )
        if res.status_code != 200:
            return []
        return res.json()  # list of {name, price, change, volume}
    except Exception as e:
        print(f"[GSE] Error fetching all: {e}")
        return []


def get_african_stock_afx(ticker, exchange):
    """
    Scrape NGX or BRVM stock data from afx.kwayisi.org.
    Page structure: table with rows of label/value pairs.
    """
    try:
        ex_slug = {'NGX': 'ngx', 'BRVM': 'brvm'}.get(exchange.upper())
        if not ex_slug:
            return None

        ticker_lower = ticker.lower()
        url = f"https://afx.kwayisi.org/{ex_slug}/{ticker_lower}.html"
        res = requests.get(url, headers=HEADERS, timeout=12)
        if res.status_code != 200:
            print(f"[AFX] {url} returned {res.status_code}")
            return None

        soup = BeautifulSoup(res.text, 'html.parser')

        # ── Extract company name from <h2> or <title> ──
        name = ticker.upper()
        h2 = soup.find('h2')
        if h2:
            name = h2.text.strip().split('(')[0].strip()
        elif soup.title:
            name = soup.title.text.strip().split('|')[0].strip()

        # ── Extract price and change from the data table ──
        # AFX uses a <table> with rows: label | value
        price = None
        change_pct = None

        tables = soup.find_all('table')
        for table in tables:
            rows = table.find_all('tr')
            for row in rows:
                cells = row.find_all('td')
                if len(cells) >= 2:
                    label = cells[0].text.strip().lower()
                    value = cells[1].text.strip()
                    if 'price' in label or 'last' in label or 'close' in label:
                        price = _parse_number(value)
                    if 'change' in label and '%' in value:
                        change_pct = _parse_number(value.replace('%', ''))

        # Fallback: look for price in any <strong> or <b> tag
        if price is None:
            for tag in soup.find_all(['strong', 'b', 'span']):
                val = _parse_number(tag.text)
                if val and val > 0.01:
                    price = val
                    break

        if price is None:
            print(f"[AFX] Could not find price for {ticker} on {exchange}")
            return None

        change_pct = change_pct or 0
        change = round(price * change_pct / 100, 4)
        prev = round(price - change, 4)
        currency = 'NGN' if exchange == 'NGX' else 'XOF'
        exchange_name = 'Nigerian Exchange' if exchange == 'NGX' else 'BRVM West Africa'

        return {
            'symbol': f"{exchange.upper()}:{ticker.upper()}",
            'name': name,
            'price': round(price, 4),
            'prev_close': round(prev, 4),
            'change': round(change, 4),
            'change_percent': round(change_pct, 2),
            'volume': None,
            'market_cap': None,
            'high_52': None,
            'low_52': None,
            'pe_ratio': None,
            'dividend': None,
            'currency': currency,
            'exchange': exchange_name
        }
    except Exception as e:
        print(f"[AFX] Error fetching {ticker} on {exchange}: {e}")
        return None


def get_african_stock(ticker_str):
    """
    Route African ticker to the correct data source.
    Format: EXCHANGE:TICKER  e.g. GSE:MTNGH
    """
    try:
        if ':' not in ticker_str:
            return None
        parts = ticker_str.upper().split(':', 1)
        exchange, ticker = parts[0], parts[1]
        if exchange == 'GSE':
            return get_gse_stock(ticker)
        elif exchange in ['NGX', 'BRVM']:
            return get_african_stock_afx(ticker, exchange)
        return None
    except Exception as e:
        print(f"[African] Routing error: {e}")
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
    # African exchange tickers have no Yahoo Finance history
    if ':' in ticker:
        return [], []
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
        # For African tickers, use company name as search query
        if ':' in ticker:
            search_term = ticker.split(':')[1]
        else:
            search_term = ticker
        url = f"https://feeds.finance.yahoo.com/rss/2.0/headline?s={search_term}&region=US&lang=en-US"
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
    exchange_hint = None

    if query:
        # Detect African exchange prefix
        if ':' in query:
            exchange_hint = query.split(':')[0]
            data = get_stock_data(query)
            if data:
                results.append(data)
            else:
                flash(
                    f'Could not find {query}. '
                    f'Check the ticker format e.g. GSE:MTNGH, NGX:DANGCEM, BRVM:SNTS',
                    'danger'
                )
        else:
            # Try Yahoo Finance
            data = get_stock_data(query)
            if data:
                results.append(data)
            else:
                flash(
                    f'No results for "{query}". '
                    f'For West African stocks use: GSE:MTNGH, NGX:DANGCEM, BRVM:SNTS',
                    'warning'
                )

    return render_template(
        'search.html',
        results=results,
        query=query,
        exchange_hint=exchange_hint
    )


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
