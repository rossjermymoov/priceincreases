const path = require('path');
const fs = require('fs');

let dbDriver = null; // 'postgres' or 'json-store'
let pool = null;

const isPostgres = Boolean(process.env.DATABASE_URL);

// In-Memory & File Store for local / offline fallback
class JsonStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = {
      customers: [],
      couriers: [],
      courier_services: [],
      customer_rates: [],
      pricing_rules: [],
      campaign_settings: {},
      audit_logs: []
    };
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.filePath)) {
        this.data = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      }
      if (!this.data.customers || this.data.customers.length === 0) {
        const seedPath = path.join(path.dirname(this.filePath), 'seed.json');
        if (fs.existsSync(seedPath)) {
          this.data = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
          this.save();
        }
      }
    } catch (e) {
      console.warn('[JsonStore] Failed to read store file, using in-memory default:', e.message);
    }
  }

  save() {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
    } catch (e) {
      console.warn('[JsonStore] Failed to save store file:', e.message);
    }
  }
}

let store = null;

if (isPostgres) {
  const { Pool } = require('pg');
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }
  });
  dbDriver = 'postgres';
} else {
  const dataDir = path.join(__dirname, '../data');
  store = new JsonStore(path.join(dataDir, 'store.json'));
  dbDriver = 'json-store';
}

async function query(sql, params = []) {
  if (dbDriver === 'postgres') {
    let paramIndex = 1;
    const pgSql = sql.replace(/\?/g, () => `$${paramIndex++}`);
    return pool.query(pgSql, params).then(res => res.rows);
  }

  // JSON-Store Driver simulation
  const s = sql.trim();
  const lower = s.toLowerCase();

  if (lower.startsWith('select count(*) as count from customers')) {
    return [{ count: store.data.customers.length }];
  }
  if (lower.startsWith('select count(*) as count from couriers')) {
    return [{ count: store.data.couriers.length }];
  }
  if (lower.startsWith('select count(*) as count from customer_rates')) {
    return [{ count: store.data.customer_rates.length }];
  }
  if (lower.startsWith('select count(*) as count from pricing_rules')) {
    return [{ count: store.data.pricing_rules.length }];
  }

  if (lower.startsWith('select * from customers')) {
    let list = [...store.data.customers];
    if (lower.includes('is_inactive_excluded = 0') || lower.includes('is_inactive_excluded is null')) {
      list = list.filter(c => !c.is_inactive_excluded || c.is_inactive_excluded === 0);
    }
    if (params.length > 0) {
      list = list.filter(c => c.dc_id === params[0]);
    }
    return list;
  }

  if (lower.startsWith('select * from couriers')) {
    return [...store.data.couriers];
  }

  if (lower.startsWith('select * from courier_services')) {
    return [...store.data.courier_services];
  }

  if (lower.startsWith('select * from customer_rates')) {
    if (params.length > 0) {
      return store.data.customer_rates.filter(r => r.customer_dc_id === params[0]);
    }
    return [...store.data.customer_rates];
  }

  if (lower.startsWith('select * from pricing_rules')) {
    return [...store.data.pricing_rules];
  }

  if (lower.includes("from campaign_settings where key =")) {
    const key = params[0] || (
      lower.includes("'campaign_status'") ? 'campaign_status' :
      (lower.includes("'cutoff_date'") ? 'cutoff_date' :
      (lower.includes("'exclude_no_invoice_12m'") ? 'exclude_no_invoice_12m' : 'scheduled_date'))
    );
    const val = store.data.campaign_settings[key];
    return val !== undefined ? [{ value: val }] : [];
  }

  if (lower.startsWith('select * from audit_logs')) {
    return [...store.data.audit_logs].reverse().slice(0, 50);
  }

  // Inserts / Updates
  if (lower.includes('insert') && lower.includes('customers')) {
    let id, dc_id, name, email, created_at, billing_period;
    if (params.length >= 6) {
      [id, dc_id, name, email, created_at, billing_period] = params;
    } else {
      [dc_id, name, email, created_at] = params;
      id = Date.now();
      billing_period = 'weekly';
    }
    const existingIdx = store.data.customers.findIndex(c => c.dc_id === dc_id);
    const rec = { id: id || Date.now(), dc_id, name, email, created_at, billing_period, is_exempt: 0, is_inactive_excluded: 0, custom_increase_pct: null };
    if (existingIdx >= 0) {
      store.data.customers[existingIdx] = { ...store.data.customers[existingIdx], ...rec, is_inactive_excluded: 0 };
    } else {
      store.data.customers.push(rec);
    }
    store.save();
    return [];
  }

  if (lower.includes('insert') && lower.includes('couriers')) {
    const [id, name, code] = params;
    const idx = store.data.couriers.findIndex(c => c.id === id);
    if (idx >= 0) store.data.couriers[idx] = { id, name, code };
    else store.data.couriers.push({ id, name, code });
    store.save();
    return [];
  }

  if (lower.includes('insert') && lower.includes('courier_services')) {
    const [id, courier_id, name, code] = params;
    const idx = store.data.courier_services.findIndex(s => s.id === id);
    if (idx >= 0) store.data.courier_services[idx] = { id, courier_id, name, code };
    else store.data.courier_services.push({ id, courier_id, name, code });
    store.save();
    return [];
  }

  if (lower.includes('insert') && lower.includes('customer_rates')) {
    const [customer_dc_id, courier_code, service_id, service_name, zone_id, zone_name, weight_class_id, weight_band, current_price_pence, current_sub_price_pence] = params;
    const exists = store.data.customer_rates.some(
      r => r.customer_dc_id === customer_dc_id && r.service_id === service_id && r.zone_id === zone_id && r.weight_class_id === weight_class_id
    );
    if (!exists) {
      store.data.customer_rates.push({
        id: store.data.customer_rates.length + 1,
        customer_dc_id,
        courier_code,
        service_id,
        service_name,
        zone_id,
        zone_name,
        weight_class_id,
        weight_band,
        current_price_pence,
        current_sub_price_pence
      });
      store.save();
    }
    return [];
  }

  if (lower.includes('insert') && lower.includes('pricing_rules')) {
    const [carrier_name, carrier_code, increase_percent] = params;
    store.data.pricing_rules.push({ id: store.data.pricing_rules.length + 1, carrier_name, carrier_code, increase_percent, active: 1 });
    store.save();
    return [];
  }

  if (lower.includes('insert') && lower.includes('campaign_settings')) {
    const [key, value] = params;
    store.data.campaign_settings[key] = value;
    store.save();
    return [];
  }

  if (lower.includes('insert into audit_logs')) {
    const [event_type, customer_dc_id, details, status, created_at] = params;
    store.data.audit_logs.push({ id: store.data.audit_logs.length + 1, event_type, customer_dc_id, details, status, created_at });
    store.save();
    return [];
  }

  if (lower.startsWith('update pricing_rules')) {
    if (params.length === 4) {
      const [increase_percent, fixed_markup_pence, active, carrier_name] = params;
      const r = store.data.pricing_rules.find(x => x.carrier_name === carrier_name);
      if (r) {
        r.increase_percent = Number(increase_percent || 0);
        r.fixed_markup_pence = Number(fixed_markup_pence || 0);
        r.active = active;
        store.save();
      }
    } else {
      const [increase_percent, active, carrier_name] = params;
      const r = store.data.pricing_rules.find(x => x.carrier_name === carrier_name);
      if (r) {
        r.increase_percent = Number(increase_percent || 0);
        r.active = active;
        store.save();
      }
    }
    return [];
  }

  if (lower.startsWith('update customers set is_exempt')) {
    const [is_exempt, custom_increase_pct, dc_id] = params;
    const c = store.data.customers.find(x => x.dc_id === dc_id);
    if (c) {
      c.is_exempt = is_exempt;
      c.custom_increase_pct = custom_increase_pct;
      store.save();
    }
    return [];
  }

  if (lower.startsWith('update customers set last_pushed_at')) {
    const [last_pushed_at, last_pushed_status, dc_id] = params;
    const c = store.data.customers.find(x => x.dc_id === dc_id);
    if (c) {
      c.last_pushed_at = last_pushed_at;
      c.last_pushed_status = last_pushed_status;
      c.is_new_customer = 0;
      store.save();
    }
    return [];
  }

  if (lower.startsWith('update customers set last_invoice_date')) {
    const [last_invoice_date, total_invoices, is_inactive_excluded, dc_id] = params;
    const c = store.data.customers.find(x => x.dc_id === dc_id);
    if (c) {
      c.last_invoice_date = last_invoice_date;
      c.total_invoices = total_invoices;
      c.is_inactive_excluded = is_inactive_excluded;
      store.save();
    }
    return [];
  }

  if (lower.startsWith('update customer_rates set current_price_pence')) {
    const [newPrice, newSub, dcId, sId, zId, wId] = params;
    const r = store.data.customer_rates.find(
      x => x.customer_dc_id === dcId && x.service_id === sId && x.zone_id === zId && x.weight_class_id === wId
    );
    if (r) {
      r.current_price_pence = newPrice;
      r.current_sub_price_pence = newSub;
      store.save();
    }
    return [];
  }

  return [];
}

async function initDb() {
  if (dbDriver === 'postgres') {
    await query(`
      CREATE TABLE IF NOT EXISTS customers (
        id SERIAL PRIMARY KEY,
        dc_id TEXT UNIQUE,
        name TEXT,
        email TEXT,
        created_at TEXT,
        billing_period TEXT,
        is_exempt INTEGER DEFAULT 0,
        custom_increase_pct REAL DEFAULT NULL,
        last_invoice_date TEXT,
        total_invoices INTEGER DEFAULT 0,
        is_inactive_excluded INTEGER DEFAULT 0
      );
      ALTER TABLE customers ADD COLUMN IF NOT EXISTS last_invoice_date TEXT;
      ALTER TABLE customers ADD COLUMN IF NOT EXISTS total_invoices INTEGER DEFAULT 0;
      ALTER TABLE customers ADD COLUMN IF NOT EXISTS is_inactive_excluded INTEGER DEFAULT 0;
      CREATE TABLE IF NOT EXISTS couriers (
        id INTEGER PRIMARY KEY,
        name TEXT,
        code TEXT
      );
      CREATE TABLE IF NOT EXISTS courier_services (
        id INTEGER PRIMARY KEY,
        courier_id INTEGER,
        name TEXT,
        code TEXT
      );
      CREATE TABLE IF NOT EXISTS customer_rates (
        id SERIAL PRIMARY KEY,
        customer_dc_id TEXT,
        courier_code TEXT,
        service_id INTEGER,
        service_name TEXT,
        zone_id INTEGER,
        zone_name TEXT,
        weight_class_id INTEGER,
        weight_band TEXT,
        current_price_pence INTEGER,
        current_sub_price_pence INTEGER,
        UNIQUE(customer_dc_id, service_id, zone_id, weight_class_id)
      );
      CREATE TABLE IF NOT EXISTS pricing_rules (
        id SERIAL PRIMARY KEY,
        carrier_name TEXT UNIQUE,
        carrier_code TEXT,
        increase_percent REAL DEFAULT 0.0,
        fixed_markup_pence REAL DEFAULT 0.0,
        active INTEGER DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS campaign_settings (
        key TEXT PRIMARY KEY,
        value TEXT
      );
      CREATE TABLE IF NOT EXISTS audit_logs (
        id SERIAL PRIMARY KEY,
        event_type TEXT,
        customer_dc_id TEXT,
        details TEXT,
        status TEXT,
        created_at TEXT
      );
      ALTER TABLE pricing_rules ADD COLUMN IF NOT EXISTS fixed_markup_pence REAL DEFAULT 0.0;
      ALTER TABLE customers ADD COLUMN IF NOT EXISTS last_pushed_at TEXT;
      ALTER TABLE customers ADD COLUMN IF NOT EXISTS last_pushed_status TEXT;
      ALTER TABLE customers ADD COLUMN IF NOT EXISTS is_new_customer INTEGER DEFAULT 0;
    `);
  }

  // Seed default pricing rules if empty
  const rules = await query('SELECT count(*) as count FROM pricing_rules');
  const count = rules[0]?.count || 0;
  if (Number(count) === 0) {
    const defaults = [
      ['DPD', 'DPD', 3.9],
      ['Yodel C2C', 'YODC2C', 2.0],
      ['Royal Mail', 'RM', 3.5],
      ['EvRi', 'EvRi', 2.5],
      ['DHL Ecommerce', 'DHL', 4.0],
      ['DHL Ecom C2C', 'DHLC2C', 4.0],
      ['UPS', 'UPS', 3.0],
      ['InPost', 'INPOST', 3.0],
      ['Pro Carrier', 'PC', 3.5],
      ['AGL', 'AGL', 3.0],
      ['PPI', 'PPI', 3.0],
      ['API TEST', 'API TEST', 0.0]
    ];
    for (const [name, code, pct] of defaults) {
      await query('INSERT INTO pricing_rules (carrier_name, carrier_code, increase_percent) VALUES (?, ?, ?)', [name, code, pct]);
    }
    await query('INSERT INTO campaign_settings (key, value) VALUES (?, ?)', ['cutoff_date', '2026-09-01']);
    await query('INSERT INTO campaign_settings (key, value) VALUES (?, ?)', ['scheduled_date', '2027-01-01T00:01:00Z']);
    await query('INSERT INTO campaign_settings (key, value) VALUES (?, ?)', ['campaign_status', 'DRAFT']);
    await query('INSERT INTO campaign_settings (key, value) VALUES (?, ?)', ['exclude_no_invoice_12m', '1']);
  }

  console.log(`[DB] Storage engine initialized: ${dbDriver.toUpperCase()}`);
}

module.exports = {
  dbDriver,
  query,
  initDb
};
