from flask_sqlalchemy import SQLAlchemy
from flask_login import UserMixin, LoginManager
from flask_bcrypt import Bcrypt
from datetime import datetime
from sqlalchemy import text
import os

db = SQLAlchemy()
bcrypt = Bcrypt()
login_manager = LoginManager()


def init_db(app):
    """
    Configures and initializes the SQLAlchemy database connection.
    Supports PostgreSQL (Render, Supabase, Neon, AWS RDS) and SQLite.
    Automatically handles Vercel read-only filesystem constraint by using /tmp.
    """
    database_url = os.environ.get('DATABASE_URL', '').strip()

    # If database_url points to the direct IPv6-only Supabase host with connection errors, use the working Supabase pooler
    if not database_url or 'db.cnfthimhzjrhhlyxwauq.supabase.co' in database_url:
        database_url = 'postgresql://postgres.cnfthimhzjrhhlyxwauq:uYDVojzwlW4gFVJY@aws-1-eu-north-1.pooler.supabase.com:6543/postgres'
    elif database_url.startswith('postgres://'):
        # Render/Heroku use postgres:// — SQLAlchemy requires postgresql://
        database_url = database_url.replace('postgres://', 'postgresql://', 1)

    # Detect direct Supabase connection string on IPv4-only platforms (like Render)
    if 'supabase.co' in database_url and 'pooler.supabase.com' not in database_url:
        import re
        ref_match = re.search(r'@db\.([a-z0-9]+)\.supabase\.co', database_url)
        ref = ref_match.group(1) if ref_match else '<project-ref>'
        print("\n" + "=" * 72, flush=True)
        print("[MarketSync Alert] Direct Supabase host detected: db." + ref + ".supabase.co", flush=True)
        print("Note: Render free tier only supports IPv4. Direct Supabase uses IPv6 and fails with:", flush=True)
        print("  'OperationalError: Network is unreachable'", flush=True)
        print("To connect directly from Render, use the Supabase Connection Pooler URI (IPv4 compatible):", flush=True)
        print(f"  postgresql://postgres.{ref}:[YOUR-PASSWORD]@aws-0-[REGION].pooler.supabase.com:6543/postgres?sslmode=require", flush=True)
        print("=" * 72 + "\n", flush=True)

    # If remote PostgreSQL host is configured, perform a quick pre-flight TCP check.
    # On Render, connecting to IPv6-only hosts fails with "Network is unreachable", which
    # crashes all user registration and login requests if SQLAlchemy binds to it.
    if not database_url.startswith('sqlite'):
        is_reachable = True
        try:
            import urllib.parse
            import socket
            parsed = urllib.parse.urlparse(database_url)
            host = parsed.hostname
            port = parsed.port or 5432
            if host and host not in ('localhost', '127.0.0.1'):
                s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                s.settimeout(2.5)
                try:
                    s.connect((host, port))
                    s.close()
                except Exception as net_err:
                    print(f"[MarketSync] Remote database {host}:{port} unreachable ({net_err}).", flush=True)
                    print("[MarketSync] Falling back to SQLite so registration and login succeed.", flush=True)
                    is_reachable = False
        except Exception:
            pass

        if not is_reachable:
            if os.environ.get('VERCEL') or os.environ.get('AWS_LAMBDA_FUNCTION_NAME'):
                database_url = 'sqlite:////tmp/marketsync.db'
            else:
                database_url = 'sqlite:///marketsync.db'

    app.config['SQLALCHEMY_DATABASE_URI'] = database_url
    app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False

    # Configure pooling and SSL for PostgreSQL
    if not database_url.startswith('sqlite'):
        engine_options = {
            'pool_pre_ping': True,
            'pool_recycle': 300,
            'pool_size': 5,
            'max_overflow': 10,
        }
        # For remote Postgres (Render, Neon, Supabase), enable SSL if not specified in URL
        connect_args = {'connect_timeout': 5}
        if 'localhost' not in database_url and '127.0.0.1' not in database_url and 'sslmode' not in database_url:
            connect_args['sslmode'] = 'prefer'
        engine_options['connect_args'] = connect_args
        app.config['SQLALCHEMY_ENGINE_OPTIONS'] = engine_options

    db.init_app(app)


def check_database_connection(app):
    """
    Tests the database connectivity and returns a status tuple: (connected, message, db_type).
    """
    with app.app_context():
        try:
            db_uri = app.config.get('SQLALCHEMY_DATABASE_URI', '')
            db_type = 'postgresql' if db_uri.startswith('postgresql') else 'sqlite' if db_uri.startswith('sqlite') else 'other'
            # Execute ping
            db.session.execute(text('SELECT 1'))
            return True, "Database connection successful", db_type
        except Exception as e:
            return False, f"Database connection failed: {str(e)}", "unknown"


def create_tables(app):
    """
    Creates tables if they do not already exist. Safe to call multiple times.
    If remote PostgreSQL fails due to network unreachability (e.g. Render IPv6 limitation),
    safely falls back to local SQLite so the web service remains operational.
    """
    with app.app_context():
        try:
            db.create_all()
            return True, "Tables verified/created successfully"
        except Exception as e:
            app.logger.error(f"Error initializing database tables: {e}")
            err_str = str(e).lower()
            # If remote database is unreachable (e.g. Supabase IPv6 on Render), fall back to SQLite
            if 'network is unreachable' in err_str or 'could not connect' in err_str or 'connection refused' in err_str:
                app.logger.warning("Remote database unreachable. Falling back to local SQLite storage to keep app operational.")
                fallback = 'sqlite:////tmp/marketsync.db' if (os.environ.get('VERCEL') or os.environ.get('AWS_LAMBDA_FUNCTION_NAME')) else 'sqlite:///marketsync.db'
                try:
                    app.config['SQLALCHEMY_DATABASE_URI'] = fallback
                    app.config.pop('SQLALCHEMY_ENGINE_OPTIONS', None)
                    db.engine.dispose()
                    db.init_app(app)
                    db.create_all()
                    app.logger.info(f"Fallback SQLite database initialized successfully at {fallback}")
                    return True, f"Fell back to SQLite: {fallback}"
                except Exception as fallback_err:
                    app.logger.error(f"Fallback SQLite error: {fallback_err}")
            return False, str(e)


class User(UserMixin, db.Model):
    __tablename__ = 'users'

    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(80), unique=True, nullable=False)
    email = db.Column(db.String(120), unique=True, nullable=False)
    password = db.Column(db.String(255), nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow, nullable=False)
    portfolios = db.relationship('Portfolio', backref='user', lazy=True)
    alerts = db.relationship('Alert', backref='user', lazy=True)

    def set_password(self, password):
        if isinstance(password, str):
            password = password.strip()
        self.password = bcrypt.generate_password_hash(password).decode('utf-8')

    def check_password(self, password):
        if not self.password or not password:
            return False
        try:
            return bcrypt.check_password_hash(self.password, password.strip())
        except Exception:
            return False

    def __repr__(self):
        return f'<User {self.username}>'


class Portfolio(db.Model):
    __tablename__ = 'portfolios'

    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('users.id'), nullable=False)
    ticker = db.Column(db.String(20), nullable=False)
    shares = db.Column(db.Float, nullable=False)
    buy_price = db.Column(db.Float, nullable=False)
    added_at = db.Column(db.DateTime, default=datetime.utcnow, nullable=False)

    def __repr__(self):
        return f'<Portfolio {self.ticker}>'


class Alert(db.Model):
    __tablename__ = 'alerts'

    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('users.id'), nullable=False)
    ticker = db.Column(db.String(20), nullable=False)
    target_price = db.Column(db.Float, nullable=False)
    direction = db.Column(db.String(10), nullable=False)
    active = db.Column(db.Boolean, default=True, nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow, nullable=False)

    def __repr__(self):
        return f'<Alert {self.ticker} {self.direction} {self.target_price}>'


@login_manager.user_loader
def load_user(user_id):
    try:
        return db.session.get(User, int(user_id))
    except Exception:
        try:
            db.session.rollback()
        except Exception:
            pass
        return None
