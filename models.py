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

    if not database_url:
        # Check if running in Vercel serverless environment (filesystem is read-only except /tmp)
        if os.environ.get('VERCEL') or os.environ.get('AWS_LAMBDA_FUNCTION_NAME'):
            database_url = 'sqlite:////tmp/marketsync.db'
        else:
            database_url = 'sqlite:///marketsync.db'
    elif database_url.startswith('postgres://'):
        # Render/Heroku use postgres:// — SQLAlchemy requires postgresql://
        database_url = database_url.replace('postgres://', 'postgresql://', 1)

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
        if 'localhost' not in database_url and '127.0.0.1' not in database_url and 'sslmode' not in database_url:
            engine_options['connect_args'] = {'sslmode': 'prefer'}
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
    """
    with app.app_context():
        try:
            db.create_all()
            return True, "Tables verified/created successfully"
        except Exception as e:
            app.logger.error(f"Error initializing database tables: {e}")
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
        self.password = bcrypt.generate_password_hash(password).decode('utf-8')

    def check_password(self, password):
        return bcrypt.check_password_hash(self.password, password)

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
        return User.query.get(int(user_id))
