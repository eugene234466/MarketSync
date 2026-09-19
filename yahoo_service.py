"""
Yahoo Finance Data Service & Session Manager
Handles robust data fetching with rotating user agents, cookie/crumb session management,
direct v8 chart API access (bypassing 401 Invalid Crumb errors), crypto fallbacks, and in-memory caching.
"""

import time
import random
import threading
import requests
from datetime import datetime, timedelta

# Rotating modern desktop browser User-Agents
USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36 Edg/123.0.0.0',
]

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

# Cache containers: {key: (data, timestamp)}
_quote_cache = {}
_history_cache = {}
CACHE_LOCK = threading.Lock()
QUOTE_CACHE_TTL = 120    # 2 minutes
HISTORY_CACHE_TTL = 600  # 10 minutes


class YahooSessionManager:
    """
    Manages HTTP sessions, cookies, and crumb pairs with retries and automatic invalidation.
    """
    _instance = None
    _lock = threading.Lock()

    def __new__(cls):
        with cls._lock:
            if cls._instance is None:
                cls._instance = super(YahooSessionManager, cls).__new__(cls)
                cls._instance._init_manager()
            return cls._instance

    def _init_manager(self):
        self.session = None
        self.crumb = None
        self.last_crumb_time = 0
        self.current_ua = random.choice(USER_AGENTS)
        self.refresh_session()

    def get_headers(self):
        return {
            'User-Agent': self.current_ua,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Sec-Fetch-User': '?1',
        }

    def refresh_session(self):
        """Builds a fresh requests.Session and attempts to acquire cookies and a valid crumb."""
        self.current_ua = random.choice(USER_AGENTS)
        new_session = requests.Session()
        new_session.headers.update(self.get_headers())

        crumb = None
        try:
            # 1. Warm up cookies on Yahoo consent/finance page
            for warmup_url in ['https://fc.yahoo.com', 'https://finance.yahoo.com']:
                try:
                    new_session.get(warmup_url, timeout=5, allow_redirects=True)
                    if new_session.cookies:
                        break
                except Exception:
                    continue

            # 2. Try fetching a fresh crumb
            for crumb_url in [
                'https://query1.finance.yahoo.com/v1/test/getcrumb',
                'https://query2.finance.yahoo.com/v1/test/getcrumb'
            ]:
                try:
                    res = new_session.get(crumb_url, timeout=5)
                    if res.status_code == 200 and res.text and len(res.text) < 50 and '<' not in res.text:
                        crumb = res.text.strip()
                        break
                except Exception:
                    continue

            self.session = new_session
            self.crumb = crumb
            self.last_crumb_time = time.time()
            if crumb:
                print(f"[YahooSessionManager] Acquired fresh crumb: {crumb[:4]}***")
            else:
                print("[YahooSessionManager] Session cookies refreshed (v8 direct chart mode active)")
        except Exception as e:
            print(f"[YahooSessionManager] Warning during session refresh: {e}")
            self.session = new_session

    def get_session_and_crumb(self, force_refresh=False):
        """Returns the active (session, crumb) pair, refreshing if expired."""
        with self._lock:
            now = time.time()
            if force_refresh or self.session is None or (now - self.last_crumb_time > 1800):
                self.refresh_session()
            return self.session, self.crumb


# Global singleton
session_manager = YahooSessionManager()


def _get_from_cache(cache_dict, key, ttl):
    with CACHE_LOCK:
        if key in cache_dict:
            data, timestamp = cache_dict[key]
            if time.time() - timestamp < ttl:
                return data
    return None


def _save_to_cache(cache_dict, key, data):
    with CACHE_LOCK:
        cache_dict[key] = (data, time.time())


def fetch_crypto_fallback(ticker):
    """
    Fallback data provider for cryptocurrencies (BTC-USD, ETH-USD, etc.)
    using Binance / CoinGecko public APIs.
    """
    try:
        clean = ticker.upper().replace('^', '')
        if clean.endswith('-USD'):
            base = clean.split('-')[0]
        else:
            base = clean

        # Binance public ticker (zero auth needed)
        url = f"https://api.binance.com/api/v3/ticker/24hr?symbol={base}USDT"
        res = requests.get(url, timeout=4)
        if res.status_code == 200:
            d = res.json()
            last_price = float(d.get('lastPrice', 0))
            change = float(d.get('priceChange', 0))
            change_pct = float(d.get('priceChangePercent', 0))
            prev_close = float(d.get('prevClosePrice', last_price))
            high_24 = float(d.get('highPrice', last_price))
            low_24 = float(d.get('lowPrice', last_price))
            volume = float(d.get('volume', 0))

            name_map = {
                'BTC': 'Bitcoin',
                'ETH': 'Ethereum',
                'SOL': 'Solana',
                'BNB': 'Binance Coin',
                'XRP': 'XRP',
                'DOGE': 'Dogecoin',
                'ADA': 'Cardano'
            }

            return {
                'symbol': ticker.upper(),
                'name': name_map.get(base, f"{base} Cryptocurrency"),
                'price': round(last_price, 2),
                'prev_close': round(prev_close, 2),
                'change': round(change, 2),
                'change_percent': round(change_pct, 2),
                'volume': int(volume) if volume else None,
                'market_cap': None,
                'high_52': round(high_24, 2),
                'low_52': round(low_24, 2),
                'pe_ratio': None,
                'dividend': None,
                'currency': 'USD',
                'exchange': 'Crypto Global'
            }
    except Exception as e:
        print(f"[Crypto Fallback] Error for {ticker}: {e}")
    return None


def fetch_yahoo_v8_chart(ticker, range_str='5d'):
    """
    Directly fetches quote and chart data from Yahoo Finance v8 chart API.
    This endpoint does not require a crumb and bypasses 401 Unauthorized errors.
    """
    session, _ = session_manager.get_session_and_crumb()
    encoded = requests.utils.quote(ticker)
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{encoded}?interval=1d&range={range_str}"

    headers = session_manager.get_headers()
    for attempt in range(2):
        try:
            res = session.get(url, headers=headers, timeout=6)
            if res.status_code == 401 or res.status_code == 403:
                # Refresh session and retry once
                session, _ = session_manager.get_session_and_crumb(force_refresh=True)
                headers = session_manager.get_headers()
                continue
            if res.status_code == 200:
                json_data = res.json()
                results = json_data.get('chart', {}).get('result', [])
                if results and len(results) > 0:
                    return results[0]
        except Exception:
            pass
    return None


def fetch_yahoo_quote_v7(ticker):
    """
    Fetches quote data using the v7 quote API with session crumb.
    """
    session, crumb = session_manager.get_session_and_crumb()
    encoded = requests.utils.quote(ticker)
    crumb_param = f"&crumb={crumb}" if crumb else ""
    url = f"https://query1.finance.yahoo.com/v7/finance/quote?symbols={encoded}{crumb_param}"

    try:
        res = session.get(url, headers=session_manager.get_headers(), timeout=5)
        if res.status_code == 200:
            data = res.json()
            quotes = data.get('quoteResponse', {}).get('result', [])
            if quotes:
                return quotes[0]
        elif res.status_code == 401:
            # Crumb was rejected, force refresh
            session_manager.get_session_and_crumb(force_refresh=True)
    except Exception:
        pass
    return None


def get_stock_data_service(ticker):
    """
    Main entrypoint to fetch stock/crypto/index quote data.
    Uses multi-tier fetching with in-memory caching and fallback providers.
    """
    if not ticker:
        return None

    raw_ticker = ticker.strip().upper()

    # Reject non-ticker keywords that are countries, search filters, or navigation terms
    # to avoid unnecessary Yahoo Finance queries and 401 crumb / symbol delisted errors.
    NON_TICKERS = {
        'AFRICA', 'AFRICAN', 'GHANA', 'NIGERIA', 'KENYA', 'SOUTH AFRICA',
        'EGYPT', 'BRVM', 'MARKET', 'ALL', 'PORTFOLIO', 'SEARCH', 'INDEX',
        'INDICES', 'HOME', 'LOGOUT', 'LOGIN', 'REGISTER', 'WATCHLIST'
    }
    if raw_ticker in NON_TICKERS or len(raw_ticker) > 14:
        return None

    yf_ticker = INDEX_ALIASES.get(raw_ticker, raw_ticker)

    # Check cache first
    cached = _get_from_cache(_quote_cache, yf_ticker, QUOTE_CACHE_TTL)
    if cached:
        return cached

    # Tier 1: Try Direct Yahoo v8 Chart API (bypasses 401 crumb requirement)
    chart_res = fetch_yahoo_v8_chart(yf_ticker, range_str='5d')
    if chart_res:
        meta = chart_res.get('meta', {})
        price = (
            meta.get('regularMarketPrice') or
            meta.get('chartPreviousClose') or
            meta.get('previousClose')
        )
        if price:
            prev_close = (
                meta.get('chartPreviousClose') or
                meta.get('previousClose') or
                price
            )
            change = price - prev_close
            change_percent = (change / prev_close * 100) if prev_close else 0

            name = (
                meta.get('shortName') or
                meta.get('longName') or
                meta.get('symbol') or
                yf_ticker
            )

            result = {
                'symbol': yf_ticker.upper(),
                'name': name,
                'price': round(price, 4),
                'prev_close': round(prev_close, 4),
                'change': round(change, 4),
                'change_percent': round(change_percent, 2),
                'volume': meta.get('regularMarketVolume'),
                'market_cap': None,
                'high_52': meta.get('fiftyTwoWeekHigh'),
                'low_52': meta.get('fiftyTwoWeekLow'),
                'pe_ratio': None,
                'dividend': None,
                'currency': meta.get('currency', 'USD'),
                'exchange': meta.get('exchangeName', 'Global Market')
            }
            _save_to_cache(_quote_cache, yf_ticker, result)
            return result

    # Tier 2: Try Yahoo v7 quote API with crumb
    quote_res = fetch_yahoo_quote_v7(yf_ticker)
    if quote_res:
        price = quote_res.get('regularMarketPrice') or quote_res.get('previousClose')
        if price:
            prev_close = quote_res.get('regularMarketPreviousClose') or price
            change = quote_res.get('regularMarketChange') or (price - prev_close)
            change_pct = quote_res.get('regularMarketChangePercent') or ((change / prev_close * 100) if prev_close else 0)

            result = {
                'symbol': yf_ticker.upper(),
                'name': quote_res.get('longName') or quote_res.get('shortName') or yf_ticker,
                'price': round(price, 4),
                'prev_close': round(prev_close, 4),
                'change': round(change, 4),
                'change_percent': round(change_pct, 2),
                'volume': quote_res.get('regularMarketVolume'),
                'market_cap': quote_res.get('marketCap'),
                'high_52': quote_res.get('fiftyTwoWeekHigh'),
                'low_52': quote_res.get('fiftyTwoWeekLow'),
                'pe_ratio': quote_res.get('trailingPE'),
                'dividend': quote_res.get('dividendYield'),
                'currency': quote_res.get('currency', 'USD'),
                'exchange': quote_res.get('fullExchangeName') or quote_res.get('exchange', 'Yahoo Finance')
            }
            _save_to_cache(_quote_cache, yf_ticker, result)
            return result

    # Tier 3: Crypto fallback (Binance / public crypto endpoints)
    if 'BTC' in yf_ticker or 'ETH' in yf_ticker or '-USD' in yf_ticker:
        crypto_res = fetch_crypto_fallback(yf_ticker)
        if crypto_res:
            _save_to_cache(_quote_cache, yf_ticker, crypto_res)
            return crypto_res

    # Tier 4: Native yfinance fallback (with custom headers)
    if yf_ticker.replace('.', '').replace('-', '').replace('^', '').replace('=', '').isalnum():
        try:
            import yfinance as yf
            import logging
            yf_logger = logging.getLogger('yfinance')
            prev_level = yf_logger.level
            yf_logger.setLevel(logging.CRITICAL)
            try:
                stock = yf.Ticker(yf_ticker)
                info = getattr(stock, 'fast_info', None)
                if info and hasattr(info, 'last_price') and info.last_price:
                    price = info.last_price
                    prev_close = getattr(info, 'previous_close', price) or price
                    change = price - prev_close
                    change_percent = (change / prev_close * 100) if prev_close else 0
                    result = {
                        'symbol': yf_ticker.upper(),
                        'name': getattr(stock, 'ticker', yf_ticker),
                        'price': round(price, 4),
                        'prev_close': round(prev_close, 4),
                        'change': round(change, 4),
                        'change_percent': round(change_percent, 2),
                        'volume': None,
                        'market_cap': None,
                        'high_52': getattr(info, 'year_high', None),
                        'low_52': getattr(info, 'year_low', None),
                        'pe_ratio': None,
                        'dividend': None,
                        'currency': getattr(info, 'currency', 'USD'),
                        'exchange': 'Yahoo Finance'
                    }
                    _save_to_cache(_quote_cache, yf_ticker, result)
                    return result
            finally:
                yf_logger.setLevel(prev_level)
        except Exception:
            pass

    return None


def get_stock_history_service(ticker, period='1mo'):
    """
    Fetches historical stock prices using direct v8 chart API.
    Bypasses yfinance.download and eliminates 401 Unauthorized errors.
    """
    if not ticker or ':' in ticker:
        return [], []

    raw_ticker = ticker.strip().upper()
    yf_ticker = INDEX_ALIASES.get(raw_ticker, raw_ticker)
    cache_key = f"{yf_ticker}:{period}"

    cached = _get_from_cache(_history_cache, cache_key, HISTORY_CACHE_TTL)
    if cached:
        return cached

    # Map periods to Yahoo range
    period_map = {
        '1d': ('1d', '5m'),
        '5d': ('5d', '15m'),
        '1mo': ('1mo', '1d'),
        '3mo': ('3mo', '1d'),
        '6mo': ('6mo', '1d'),
        '1y': ('1y', '1d'),
        '5y': ('5y', '1wk'),
        'max': ('max', '1mo')
    }
    range_str, interval_str = period_map.get(period, ('1mo', '1d'))

    session, _ = session_manager.get_session_and_crumb()
    encoded = requests.utils.quote(yf_ticker)
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{encoded}?interval={interval_str}&range={range_str}"

    try:
        res = session.get(url, headers=session_manager.get_headers(), timeout=7)
        if res.status_code == 200:
            data = res.json()
            chart_obj = data.get('chart', {}).get('result', [])[0]
            timestamps = chart_obj.get('timestamp', [])
            indicators = chart_obj.get('indicators', {}).get('quote', [{}])[0]
            closes = indicators.get('close', [])

            dates = []
            prices = []
            for t, c in zip(timestamps, closes):
                if c is not None:
                    dt = datetime.utcfromtimestamp(t)
                    dates.append(dt.strftime('%Y-%m-%d' if interval_str == '1d' else '%Y-%m-%d %H:%M'))
                    prices.append(round(float(c), 2))

            if dates and prices:
                result = (dates, prices)
                _save_to_cache(_history_cache, cache_key, result)
                return result
    except Exception as e:
        print(f"[History Service] Error fetching {yf_ticker}: {e}")

    # Fallback to yf.download if available
    try:
        import yfinance as yf
        df = yf.download(yf_ticker, period=period, auto_adjust=True, progress=False)
        if not df.empty:
            dates = df.index.strftime('%Y-%m-%d').tolist()
            prices = df['Close'].squeeze().round(2).tolist()
            result = (dates, prices)
            _save_to_cache(_history_cache, cache_key, result)
            return result
    except Exception:
        pass

    return [], []
