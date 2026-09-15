#!/usr/bin/env python3
"""
Diagnostic utility to verify database connectivity and table schemas.
Usage:
    python3 check_db.py
"""
import os
import sys
from dotenv import load_dotenv

load_dotenv()

def run_db_check():
    print("=" * 60)
    print("MarketSync Database Connection & Schema Diagnostic")
    print("=" * 60)

    raw_db_url = os.environ.get('DATABASE_URL', '').strip()
    if raw_db_url:
        # Mask credentials in output
        safe_url = raw_db_url
        if '@' in safe_url and '://' in safe_url:
            proto, rest = safe_url.split('://', 1)
            creds, host_part = rest.split('@', 1)
            user = creds.split(':')[0] if ':' in creds else creds
            safe_url = f"{proto}://{user}:****@{host_part}"
        print(f"[Config] DATABASE_URL provided: {safe_url}")
    else:
        print("[Config] No DATABASE_URL set. Using default SQLite storage.")

    try:
        from app import app
        from models import db, User, Portfolio, Alert, check_database_connection, create_tables
    except Exception as import_err:
        print(f"[FAIL] Could not import application models: {import_err}")
        sys.exit(1)

    with app.app_context():
        # 1. Test ping
        connected, msg, db_type = check_database_connection(app)
        uri = app.config.get('SQLALCHEMY_DATABASE_URI', '')
        print(f"[Connection] Database Type: {db_type.upper()}")
        if not connected:
            print(f"[FAIL] Connection test failed: {msg}")
            sys.exit(1)
        print(f"[PASS] Connection test succeeded: {msg}")

        # 2. Verify / Create Tables
        success, table_msg = create_tables(app)
        if not success:
            print(f"[FAIL] Table creation error: {table_msg}")
            sys.exit(1)
        print(f"[PASS] {table_msg}")

        # 3. Inspect Table Counts
        try:
            user_count = User.query.count()
            portfolio_count = Portfolio.query.count()
            alert_count = Alert.query.count()
            print(f"[Schema] Tables verified:")
            print(f"         - users:       {user_count} record(s)")
            print(f"         - portfolios:  {portfolio_count} record(s)")
            print(f"         - alerts:      {alert_count} record(s)")
        except Exception as query_err:
            print(f"[FAIL] Error querying table metadata: {query_err}")
            sys.exit(1)

    print("=" * 60)
    print("[STATUS] All database checks passed successfully!")
    print("=" * 60)
    sys.exit(0)

if __name__ == '__main__':
    run_db_check()
