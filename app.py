import os
import yfinance as yf
import feedparser
import requests
from bs4 import BeautifulSoup
from datetime import datetime, timedelta
from flask import Flask, render_template, request, jsonify, redirect, url_for, flash, send_from_directory
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
    ),
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
    'Connection': 'keep-alive',
}

# Simple in-memory cache — stores {ticker: (data, timestamp)}
_african_cache = {}
CACHE_TTL = timedelta(minutes=15)

def _get_cached(ticker):
    """Return cached data if still fresh."""
    if ticker in _african_cache:
        data, ts = _african_cache[ticker]
        if datetime.now() - ts < CACHE_TTL:
            return data
    return None

def _set_cached(ticker, data):
    """Store data in cache with current timestamp."""
    _african_cache[ticker] = (data, datetime.now())


def _parse_number(text):
    """Safely parse a number string — strips commas, spaces."""
    try:
        return float(str(text).replace(',', '').replace(' ', '').strip())
    except Exception:
        return None


def get_gse_stock(ticker):
    """
    Fetch GSE stock via dev.kwayisi.org free JSON API.
    Uses 15-minute cache to avoid repeated slow calls.
    """
    ticker = ticker.upper()
    cache_key = f"GSE:{ticker}"

    # Return cached result if fresh
    cached = _get_cached(cache_key)
    if cached:
        return cached

    try:
        url = f"https://dev.kwayisi.org/apis/gse/equities/{ticker}"
        res = requests.get(url, headers=HEADERS, timeout=6)
        if res.status_code != 200:
            return None
        data = res.json()
        price = _parse_number(data.get('price', 0)) or 0
        change_pct = _parse_number(data.get('change', 0)) or 0
        change = round(price * change_pct / 100, 4)
        prev = round(price - change, 4) if change else price
        result = {
            'symbol': cache_key,
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
        _set_cached(cache_key, result)
        return result
    except requests.Timeout:
        print(f"[GSE] Timeout fetching {ticker}")
        return None
    except Exception as e:
        print(f"[GSE] Error fetching {ticker}: {e}")
        return None


def get_african_stock_afx(ticker, exchange):
    """
    Scrape NGX or BRVM stock data from afx.kwayisi.org.
    Uses 15-minute cache to avoid repeated slow scrape calls.
    """
    cache_key = f"{exchange.upper()}:{ticker.upper()}"

    cached = _get_cached(cache_key)
    if cached:
        return cached

    try:
        ex_slug = {'NGX': 'ngx', 'BRVM': 'brvm'}.get(exchange.upper())
        if not ex_slug:
            return None

        ticker_lower = ticker.lower()
        url = f"https://afx.kwayisi.org/{ex_slug}/{ticker_lower}.html"
        res = requests.get(url, headers=HEADERS, timeout=6)
        if res.status_code != 200:
            print(f"[AFX] {url} returned {res.status_code}")
            return None

        soup = BeautifulSoup(res.text, 'html.parser')

        # Extract company name
        name = ticker.upper()
        h2 = soup.find('h2')
        if h2:
            name = h2.text.strip().split('(')[0].strip()
        elif soup.title:
            name = soup.title.text.strip().split('|')[0].strip()

        # Extract price and change from tables
        price = None
        change_pct = None

        for table in soup.find_all('table'):
            for row in table.find_all('tr'):
                cells = row.find_all('td')
                if len(cells) >= 2:
                    label = cells[0].text.strip().lower()
                    value = cells[1].text.strip()
                    if any(k in label for k in ['price', 'last', 'close']):
                        price = _parse_number(value)
                    if 'change' in label and '%' in value:
                        change_pct = _parse_number(value.replace('%', ''))

        # Fallback to first large number found
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

        result = {
            'symbol': cache_key,
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
        _set_cached(cache_key, result)
        return result

    except requests.Timeout:
        print(f"[AFX] Timeout fetching {ticker} on {exchange}")
        return None
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
    ticker = ticker.strip().upper()

    # ── African exchange prefix (GSE:, NGX:, BRVM:) ──
    if ':' in ticker:
        prefix = ticker.split(':')[0]
        if prefix in AFRICAN_EXCHANGES:
            african_data = get_african_stock(ticker)
            if african_data:
                return african_data
            return None

    # ── Robust Yahoo Finance + Fallbacks Service ──
    return get_stock_data_service(ticker)


def get_stock_history(ticker, period='1mo'):
    # African exchange tickers have no Yahoo Finance history
    if ':' in ticker:
        return [], []
    return get_stock_history_service(ticker, period=period)


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
    client = get_groq_client()
    currency = 'GHS' if ticker.startswith('GSE:') else \
               'NGN' if ticker.startswith('NGX:') else \
               'XOF' if ticker.startswith('BRVM:') else 'USD'

    if client:
        try:
            prompt = (
                f"You are a financial analyst. Give a brief analysis of {name} ({ticker}). "
                f"Current price: {currency} {price}. Change today: {change_pct:.2f}%. "
                f"Cover: current trend, key factors affecting price, and short-term outlook. "
                f"Keep it concise, clear and under 150 words."
            )
            try:
                completion = client.chat.completions.create(
                    model="openai/gpt-oss-120b",
                    messages=[
                        {"role": "system", "content": "You are a professional financial analyst. Be concise, factual and clear."},
                        {"role": "user", "content": prompt}
                    ],
                    temperature=0.3,
                    max_tokens=300
                )
                return completion.choices[0].message.content
            except Exception as model_err:
                app.logger.info(f"Model openai/gpt-oss-120b fallback to llama-3.3-70b-versatile: {model_err}")
                completion = client.chat.completions.create(
                    model="llama-3.3-70b-versatile",
                    messages=[
                        {"role": "system", "content": "You are a professional financial analyst. Be concise, factual and clear."},
                        {"role": "user", "content": prompt}
                    ],
                    temperature=0.3,
                    max_tokens=300
                )
                return completion.choices[0].message.content
        except Exception as e:
            app.logger.warning(f"AI analysis generation error: {e}")

    direction = "bullish momentum" if change_pct >= 0 else "bearish pressure"
    sign = "+" if change_pct >= 0 else ""
    return (
        f"{name} ({ticker}) is currently trading at {currency} {price:,.2f}, reflecting {direction} "
        f"with a {sign}{change_pct:.2f}% session change. Trading volumes and market sentiment indicate "
        f"active market participation. Key drivers include macroeconomic updates and quarterly performance expectations."
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


# ── ROUTES ────────────────────────────────────────────────────────────────────

@app.route('/')
def index():
    indices_symbols = [
        ('^GSPC',   'S&P 500'),
        ('^IXIC',   'NASDAQ'),
        ('^DJI',    'DOW JONES'),
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
                    'change_percent': round(stock.get('change_percent', 0), 2)
                })
            else:
                indices_data.append({
                    'symbol': symbol,
                    'name': fallback_name,
                    'price': 'N/A',
                    'change_percent': 0
                })
        except Exception as e:
            print(f"[Index] Error loading {symbol}: {e}")
            indices_data.append({
                'symbol': symbol,
                'name': fallback_name,
                'price': 'N/A',
                'change_percent': 0
            })
    return render_template('index.html', indices=indices_data)


@app.route('/search')
def search():
    query = request.args.get('q', '').strip().upper()
    results = []

    if query:
        data = get_stock_data(query)
        if data:
            results.append(data)
        else:
            # Give helpful hint based on what they typed
            if ':' in query and query.split(':')[0] in AFRICAN_EXCHANGES:
                flash(
                    f'Could not find {query}. '
                    f'Check the ticker — e.g. GSE:MTNGH, NGX:DANGCEM, BRVM:SNTS',
                    'danger'
                )
            else:
                flash(
                    f'No results for "{query}". '
                    f'Try: AAPL, TSLA, BTC-USD. '
                    f'For West Africa use: GSE:MTNGH, NGX:DANGCEM, BRVM:SNTS',
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


@app.route('/logout')
@login_required
def logout():
    logout_user()
    flash('Logged out successfully.', 'success')
    return redirect(url_for('index'))


if __name__ == '__main__':
    with app.app_context():
        db.create_all()
    app.run(debug=True, use_reloader=False)
    
