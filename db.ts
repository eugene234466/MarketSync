import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface User {
  id: number;
  username: string;
  email: string;
  password: string;
  created_at: string;
}

export interface Portfolio {
  id: number;
  user_id: number;
  ticker: string;
  shares: number;
  buy_price: number;
  added_at: string;
}

export interface Alert {
  id: number;
  user_id: number;
  ticker: string;
  target_price: number;
  direction: 'above' | 'below';
  active: boolean;
  created_at: string;
}

interface JsonDatabaseSchema {
  users: User[];
  portfolios: Portfolio[];
  alerts: Alert[];
  nextUserId: number;
  nextPortfolioId: number;
  nextAlertId: number;
}

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'marketsync.json');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Default to user-provided working Supabase Pooler URI if environment variable is unset or stale
const DEFAULT_FALLBACK_PG_URL = 'postgresql://postgres.cnfthimhzjrhhlyxwauq:uYDVojzwlW4gFVJY@aws-1-eu-north-1.pooler.supabase.com:6543/postgres';

class DatabaseService {
  private pgPool: pg.Pool | null = null;
  private isPgAvailable: boolean = false;
  private pgLastError: string | null = null;
  private configuredUrl: string | null = null;

  constructor() {
    const rawEnv = process.env.DATABASE_URL?.trim();
    // If the existing DATABASE_URL is pointing to an unreachable direct Supabase host or has old credentials, prefer the working pooler
    if (rawEnv && !rawEnv.includes('db.cnfthimhzjrhhlyxwauq.supabase.co')) {
      this.configuredUrl = rawEnv;
    } else {
      this.configuredUrl = DEFAULT_FALLBACK_PG_URL;
    }
  }

  public async init(): Promise<void> {
    if (this.configuredUrl) {
      try {
        const masked = this.configuredUrl.replace(/:[^:@]+@/, ':****@');
        console.log(`[Database] Attempting PostgreSQL connection to: ${masked}`);

        this.pgPool = new Pool({
          connectionString: this.configuredUrl,
          ssl: { rejectUnauthorized: false },
          connectionTimeoutMillis: 7000
        });

        // Test connection
        const client = await this.pgPool.connect();
        try {
          await client.query('SELECT 1');
          await this.createPgTables(client);
          await this.seedOrMigrateLocalData(client);
          this.isPgAvailable = true;
          this.pgLastError = null;
          console.log('[Database] Connected to PostgreSQL database successfully!');
        } finally {
          client.release();
        }
      } catch (err: any) {
        this.isPgAvailable = false;
        this.pgLastError = err.message || String(err);
        console.warn(`[Database] PostgreSQL connection failed: ${this.pgLastError}`);
        console.warn('[Database] Using local persistent JSON store (data/marketsync.json) as fallback.');
      }
    } else {
      console.log('[Database] No DATABASE_URL provided. Using local persistent JSON store.');
    }
  }

  private async seedOrMigrateLocalData(client: pg.PoolClient): Promise<void> {
    try {
      const userCountRes = await client.query('SELECT COUNT(*) as count FROM users');
      const count = parseInt(userCountRes.rows[0]?.count || '0', 10);
      if (count === 0 && fs.existsSync(DB_FILE)) {
        const json = this.loadJson();
        if (json.users && json.users.length > 0) {
          console.log(`[Database] Migrating ${json.users.length} local user(s) to PostgreSQL...`);
          for (const u of json.users) {
            await client.query(
              'INSERT INTO users (id, username, email, password, created_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING',
              [u.id, u.username, u.email, u.password, u.created_at]
            );
          }
          await client.query("SELECT setval('users_id_seq', (SELECT MAX(id) FROM users))");
        }
      }
    } catch (migErr) {
      console.warn('[Database] Data migration notice:', migErr);
    }
  }

  private async createPgTables(client: pg.PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(80) UNIQUE NOT NULL,
        email VARCHAR(120) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS portfolios (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE NOT NULL,
        ticker VARCHAR(20) NOT NULL,
        shares DOUBLE PRECISION NOT NULL,
        buy_price DOUBLE PRECISION NOT NULL,
        added_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS alerts (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE NOT NULL,
        ticker VARCHAR(20) NOT NULL,
        target_price DOUBLE PRECISION NOT NULL,
        direction VARCHAR(10) NOT NULL,
        active BOOLEAN DEFAULT TRUE NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
  }

  public getStatus() {
    const rawUrl = this.configuredUrl || process.env.DATABASE_URL?.trim();
    const maskedUrl = rawUrl ? rawUrl.replace(/:[^:@]+@/, ':****@') : null;
    return {
      type: this.isPgAvailable ? 'postgresql' : 'json_store',
      is_postgres_active: this.isPgAvailable,
      database_url_configured: Boolean(rawUrl),
      masked_url: maskedUrl,
      postgres_error: this.pgLastError
    };
  }

  // ── JSON Local Fallback Helpers ──
  private loadJson(): JsonDatabaseSchema {
    try {
      if (fs.existsSync(DB_FILE)) {
        const content = fs.readFileSync(DB_FILE, 'utf-8');
        return JSON.parse(content);
      }
    } catch (err) {
      console.error('[Database] Error loading JSON file:', err);
    }
    const initial: JsonDatabaseSchema = {
      users: [],
      portfolios: [],
      alerts: [],
      nextUserId: 1,
      nextPortfolioId: 1,
      nextAlertId: 1
    };
    this.saveJson(initial);
    return initial;
  }

  private saveJson(data: JsonDatabaseSchema): void {
    try {
      fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
      console.error('[Database] Error saving JSON file:', err);
    }
  }

  // ── Users ──
  public async findUserById(id: number): Promise<User | null> {
    if (this.isPgAvailable && this.pgPool) {
      try {
        const res = await this.pgPool.query(
          'SELECT id, username, email, password, created_at FROM users WHERE id = $1 LIMIT 1',
          [id]
        );
        if (res.rows.length > 0) {
          const row = res.rows[0];
          return {
            id: row.id,
            username: row.username,
            email: row.email,
            password: row.password,
            created_at: new Date(row.created_at).toISOString()
          };
        }
        return null;
      } catch (err) {
        console.error('[Database] PG findUserById error:', err);
      }
    }
    const json = this.loadJson();
    return json.users.find(u => u.id === id) || null;
  }

  public async findUserByLogin(loginId: string): Promise<User | null> {
    const clean = loginId.trim().toLowerCase();
    if (this.isPgAvailable && this.pgPool) {
      try {
        const res = await this.pgPool.query(
          'SELECT id, username, email, password, created_at FROM users WHERE LOWER(email) = $1 OR LOWER(username) = $1 LIMIT 1',
          [clean]
        );
        if (res.rows.length > 0) {
          const row = res.rows[0];
          return {
            id: row.id,
            username: row.username,
            email: row.email,
            password: row.password,
            created_at: new Date(row.created_at).toISOString()
          };
        }
        return null;
      } catch (err) {
        console.error('[Database] PG findUserByLogin error:', err);
      }
    }
    const json = this.loadJson();
    return json.users.find(
      u => u.email.toLowerCase() === clean || u.username.toLowerCase() === clean
    ) || null;
  }

  public async findUserByEmail(email: string): Promise<User | null> {
    const clean = email.trim().toLowerCase();
    if (this.isPgAvailable && this.pgPool) {
      try {
        const res = await this.pgPool.query(
          'SELECT id, username, email, password, created_at FROM users WHERE LOWER(email) = $1 LIMIT 1',
          [clean]
        );
        if (res.rows.length > 0) {
          const row = res.rows[0];
          return {
            id: row.id,
            username: row.username,
            email: row.email,
            password: row.password,
            created_at: new Date(row.created_at).toISOString()
          };
        }
        return null;
      } catch (err) {
        console.error('[Database] PG findUserByEmail error:', err);
      }
    }
    const json = this.loadJson();
    return json.users.find(u => u.email.toLowerCase() === clean) || null;
  }

  public async findUserByUsername(username: string): Promise<User | null> {
    const clean = username.trim().toLowerCase();
    if (this.isPgAvailable && this.pgPool) {
      try {
        const res = await this.pgPool.query(
          'SELECT id, username, email, password, created_at FROM users WHERE LOWER(username) = $1 LIMIT 1',
          [clean]
        );
        if (res.rows.length > 0) {
          const row = res.rows[0];
          return {
            id: row.id,
            username: row.username,
            email: row.email,
            password: row.password,
            created_at: new Date(row.created_at).toISOString()
          };
        }
        return null;
      } catch (err) {
        console.error('[Database] PG findUserByUsername error:', err);
      }
    }
    const json = this.loadJson();
    return json.users.find(u => u.username.toLowerCase() === clean) || null;
  }

  public async createUser(data: { username: string; email: string; password: string }): Promise<User> {
    if (this.isPgAvailable && this.pgPool) {
      try {
        const res = await this.pgPool.query(
          'INSERT INTO users (username, email, password, created_at) VALUES ($1, $2, $3, NOW()) RETURNING id, username, email, password, created_at',
          [data.username.trim(), data.email.trim().toLowerCase(), data.password]
        );
        const row = res.rows[0];
        return {
          id: row.id,
          username: row.username,
          email: row.email,
          password: row.password,
          created_at: new Date(row.created_at).toISOString()
        };
      } catch (err) {
        console.error('[Database] PG createUser error:', err);
        throw err;
      }
    }
    const json = this.loadJson();
    const newUser: User = {
      id: json.nextUserId++,
      username: data.username.trim(),
      email: data.email.trim().toLowerCase(),
      password: data.password,
      created_at: new Date().toISOString()
    };
    json.users.push(newUser);
    this.saveJson(json);
    return newUser;
  }

  // ── Portfolios ──
  public async getPortfolios(userId: number): Promise<Portfolio[]> {
    if (this.isPgAvailable && this.pgPool) {
      try {
        const res = await this.pgPool.query(
          'SELECT id, user_id, ticker, shares, buy_price, added_at FROM portfolios WHERE user_id = $1 ORDER BY id DESC',
          [userId]
        );
        return res.rows.map(r => ({
          id: r.id,
          user_id: r.user_id,
          ticker: r.ticker,
          shares: parseFloat(r.shares),
          buy_price: parseFloat(r.buy_price),
          added_at: new Date(r.added_at).toISOString()
        }));
      } catch (err) {
        console.error('[Database] PG getPortfolios error:', err);
      }
    }
    const json = this.loadJson();
    return json.portfolios.filter(p => p.user_id === userId);
  }

  public async isTickerInPortfolio(userId: number, ticker: string): Promise<boolean> {
    if (this.isPgAvailable && this.pgPool) {
      try {
        const res = await this.pgPool.query(
          'SELECT id FROM portfolios WHERE user_id = $1 AND ticker = $2 LIMIT 1',
          [userId, ticker.toUpperCase()]
        );
        return res.rows.length > 0;
      } catch (err) {
        console.error('[Database] PG isTickerInPortfolio error:', err);
      }
    }
    const json = this.loadJson();
    return json.portfolios.some(p => p.user_id === userId && p.ticker === ticker.toUpperCase());
  }

  public async addPortfolio(data: { user_id: number; ticker: string; shares: number; buy_price: number }): Promise<Portfolio> {
    if (this.isPgAvailable && this.pgPool) {
      try {
        const res = await this.pgPool.query(
          'INSERT INTO portfolios (user_id, ticker, shares, buy_price, added_at) VALUES ($1, $2, $3, $4, NOW()) RETURNING id, user_id, ticker, shares, buy_price, added_at',
          [data.user_id, data.ticker.toUpperCase(), data.shares, data.buy_price]
        );
        const r = res.rows[0];
        return {
          id: r.id,
          user_id: r.user_id,
          ticker: r.ticker,
          shares: parseFloat(r.shares),
          buy_price: parseFloat(r.buy_price),
          added_at: new Date(r.added_at).toISOString()
        };
      } catch (err) {
        console.error('[Database] PG addPortfolio error:', err);
        throw err;
      }
    }
    const json = this.loadJson();
    const newEntry: Portfolio = {
      id: json.nextPortfolioId++,
      user_id: data.user_id,
      ticker: data.ticker.toUpperCase(),
      shares: data.shares,
      buy_price: data.buy_price,
      added_at: new Date().toISOString()
    };
    json.portfolios.push(newEntry);
    this.saveJson(json);
    return newEntry;
  }

  public async deletePortfolio(id: number, userId: number): Promise<Portfolio | null> {
    if (this.isPgAvailable && this.pgPool) {
      try {
        const res = await this.pgPool.query(
          'DELETE FROM portfolios WHERE id = $1 AND user_id = $2 RETURNING id, user_id, ticker, shares, buy_price, added_at',
          [id, userId]
        );
        if (res.rows.length > 0) {
          const r = res.rows[0];
          return {
            id: r.id,
            user_id: r.user_id,
            ticker: r.ticker,
            shares: parseFloat(r.shares),
            buy_price: parseFloat(r.buy_price),
            added_at: new Date(r.added_at).toISOString()
          };
        }
        return null;
      } catch (err) {
        console.error('[Database] PG deletePortfolio error:', err);
      }
    }
    const json = this.loadJson();
    const index = json.portfolios.findIndex(p => p.id === id && p.user_id === userId);
    if (index === -1) return null;
    const [removed] = json.portfolios.splice(index, 1);
    this.saveJson(json);
    return removed;
  }

  // ── Alerts ──
  public async getAlerts(userId: number): Promise<Alert[]> {
    if (this.isPgAvailable && this.pgPool) {
      try {
        const res = await this.pgPool.query(
          'SELECT id, user_id, ticker, target_price, direction, active, created_at FROM alerts WHERE user_id = $1 ORDER BY id DESC',
          [userId]
        );
        return res.rows.map(r => ({
          id: r.id,
          user_id: r.user_id,
          ticker: r.ticker,
          target_price: parseFloat(r.target_price),
          direction: r.direction as 'above' | 'below',
          active: r.active,
          created_at: new Date(r.created_at).toISOString()
        }));
      } catch (err) {
        console.error('[Database] PG getAlerts error:', err);
      }
    }
    const json = this.loadJson();
    return json.alerts
      .filter(a => a.user_id === userId)
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  }

  public async getAlertsForTicker(userId: number, ticker: string): Promise<Alert[]> {
    if (this.isPgAvailable && this.pgPool) {
      try {
        const res = await this.pgPool.query(
          'SELECT id, user_id, ticker, target_price, direction, active, created_at FROM alerts WHERE user_id = $1 AND ticker = $2',
          [userId, ticker.toUpperCase()]
        );
        return res.rows.map(r => ({
          id: r.id,
          user_id: r.user_id,
          ticker: r.ticker,
          target_price: parseFloat(r.target_price),
          direction: r.direction as 'above' | 'below',
          active: r.active,
          created_at: new Date(r.created_at).toISOString()
        }));
      } catch (err) {
        console.error('[Database] PG getAlertsForTicker error:', err);
      }
    }
    const json = this.loadJson();
    return json.alerts.filter(a => a.user_id === userId && a.ticker === ticker.toUpperCase());
  }

  public async getActiveAlerts(): Promise<Alert[]> {
    if (this.isPgAvailable && this.pgPool) {
      try {
        const res = await this.pgPool.query(
          'SELECT id, user_id, ticker, target_price, direction, active, created_at FROM alerts WHERE active = true'
        );
        return res.rows.map(r => ({
          id: r.id,
          user_id: r.user_id,
          ticker: r.ticker,
          target_price: parseFloat(r.target_price),
          direction: r.direction as 'above' | 'below',
          active: r.active,
          created_at: new Date(r.created_at).toISOString()
        }));
      } catch (err) {
        console.error('[Database] PG getActiveAlerts error:', err);
      }
    }
    const json = this.loadJson();
    return json.alerts.filter(a => a.active);
  }

  public async addAlert(data: { user_id: number; ticker: string; target_price: number; direction: 'above' | 'below' }): Promise<Alert> {
    if (this.isPgAvailable && this.pgPool) {
      try {
        const res = await this.pgPool.query(
          'INSERT INTO alerts (user_id, ticker, target_price, direction, active, created_at) VALUES ($1, $2, $3, $4, true, NOW()) RETURNING id, user_id, ticker, target_price, direction, active, created_at',
          [data.user_id, data.ticker.toUpperCase(), data.target_price, data.direction]
        );
        const r = res.rows[0];
        return {
          id: r.id,
          user_id: r.user_id,
          ticker: r.ticker,
          target_price: parseFloat(r.target_price),
          direction: r.direction as 'above' | 'below',
          active: r.active,
          created_at: new Date(r.created_at).toISOString()
        };
      } catch (err) {
        console.error('[Database] PG addAlert error:', err);
        throw err;
      }
    }
    const json = this.loadJson();
    const newAlert: Alert = {
      id: json.nextAlertId++,
      user_id: data.user_id,
      ticker: data.ticker.toUpperCase(),
      target_price: data.target_price,
      direction: data.direction,
      active: true,
      created_at: new Date().toISOString()
    };
    json.alerts.push(newAlert);
    this.saveJson(json);
    return newAlert;
  }

  public async deleteAlert(id: number, userId: number): Promise<boolean> {
    if (this.isPgAvailable && this.pgPool) {
      try {
        const res = await this.pgPool.query(
          'DELETE FROM alerts WHERE id = $1 AND user_id = $2',
          [id, userId]
        );
        return (res.rowCount ?? 0) > 0;
      } catch (err) {
        console.error('[Database] PG deleteAlert error:', err);
      }
    }
    const json = this.loadJson();
    const index = json.alerts.findIndex(a => a.id === id && a.user_id === userId);
    if (index === -1) return false;
    json.alerts.splice(index, 1);
    this.saveJson(json);
    return true;
  }

  public async getRecordCounts() {
    if (this.isPgAvailable && this.pgPool) {
      try {
        const u = await this.pgPool.query('SELECT COUNT(*) as count FROM users');
        const p = await this.pgPool.query('SELECT COUNT(*) as count FROM portfolios');
        const a = await this.pgPool.query('SELECT COUNT(*) as count FROM alerts');
        return {
          users: parseInt(u.rows[0]?.count || '0', 10),
          portfolios: parseInt(p.rows[0]?.count || '0', 10),
          alerts: parseInt(a.rows[0]?.count || '0', 10)
        };
      } catch (err) {
        console.error('[Database] PG count error:', err);
      }
    }
    const json = this.loadJson();
    return {
      users: json.users.length,
      portfolios: json.portfolios.length,
      alerts: json.alerts.length
    };
  }
}

export const dbService = new DatabaseService();
