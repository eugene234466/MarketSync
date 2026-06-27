from flask_sqlalchemy import SQLAlchemy
from flask_login import UserMixin, LoginManager
from flask_bcrypt import Bcrypt
from datetime import datetime
import os

db = SQLAlchemy()
bcrypt = Bcrypt()
login_manager = LoginManager()

def init_db(app):
    database_url = os.environ.get('DATABASE_URL', '')
    # Supabase/SQLAlchemy requires postgresql:// not postgres://
    if database_url.startswith('postgres://'):
        database_url = database_url.replace('postgres://', 'postgresql://', 1)
    app.config['SQLALCHEMY_DATABASE_URI'] = database_url
    app.config['SQLALCHEMY_ENGINE_OPTIONS'] = {
        'pool_pre_ping': True,      # Detects stale connections
        'pool_recycle': 300,        # Recycle connections every 5 min
    }
    db.init_app(app)

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
    return User.query.get(int(user_id))
