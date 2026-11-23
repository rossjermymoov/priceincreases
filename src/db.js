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
  const dbUrl = process.env.DATABASE_URL;
  const isLocal = dbUrl.includes('localhost') || dbUrl.includes('127.0.0.1');
  const isInternal = dbUrl.includes('.railway.internal') || dbUrl.includes('railway.internal');
  const useSsl = !isLocal && !isInternal && !dbUrl.includes('sslmode=disable');

  pool = new Pool({
    connectionString: dbUrl,
    ssl: useSsl ? { rejectUnauthorized: false } : false
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
    if (lower.includes('active = 1')) {
      return store.data.pricing_rules.filter(r => r.active !== 0);
    }
    return [...store.data.pricing_rules];
  }

  if (lower.startsWith('select * from staged_rates')) {
    let list = store.data.staged_rates || [];
    if (lower.includes('where customer_dc_id =')) {
      const targetDcId = params[0];
      list = list.filter(r => r.customer_dc_id === targetDcId);
    }
    return list;
  }

  if (lower.startsWith('delete from staged_rates')) {
    store.data.staged_rates = [];
    store.save();
    return [];
  }

  if (lower.startsWith('insert into staged_rates')) {
    if (!store.data.staged_rates) store.data.staged_rates = [];
    if (Array.isArray(params[0])) {
      store.data.staged_rates = [...params[0]];
    } else if (params[0]) {
      store.data.staged_rates.push(params[0]);
    }
    store.save();
    return [];
  }

  if (lower.includes("from campaign_settings where key =")) {
    let key = params[0];
    if (!key) {
      const match = sql.match(/key\s*=\s*['"]([^'"]+)['"]/i);
      key = match ? match[1] : null;
    }
    const val = store.data.campaign_settings ? store.data.campaign_settings[key] : undefined;
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
    const existingIdx = store.data.customer_rates.findIndex(
      r => r.customer_dc_id === customer_dc_id && r.service_id === service_id && r.zone_id === zone_id && r.weight_class_id === weight_class_id
    );
    if (existingIdx >= 0) {
      store.data.customer_rates[existingIdx] = {
        ...store.data.customer_rates[existingIdx],
        courier_code: courier_code || store.data.customer_rates[existingIdx].courier_code,
        service_name: service_name || store.data.customer_rates[existingIdx].service_name,
        zone_name: zone_name || store.data.customer_rates[existingIdx].zone_name,
        weight_band: weight_band || store.data.customer_rates[existingIdx].weight_band,
        current_price_pence,
        current_sub_price_pence
      };
    } else {
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
    }
    store.save();
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
    const identifier = params[params.length - 1];
    const r = store.data.pricing_rules.find(x => x.carrier_name === identifier || x.carrier_code === identifier || x.id === identifier);
    if (r) {
      if (params.length >= 4) {
        const [increase_percent, fixed_markup_pence, active] = params;
        r.increase_percent = Number(increase_percent || 0);
        r.fixed_markup_pence = Number(fixed_markup_pence || 0);
        r.active = active;
      } else if (params.length === 3) {
        const [increase_percent, active] = params;
        r.increase_percent = Number(increase_percent || 0);
        r.active = active;
      } else if (params.length === 2) {
        const [increase_percent] = params;
        r.increase_percent = Number(increase_percent || 0);
        r.fixed_markup_pence = 0;
      }
      store.save();
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
    try {
      console.log('[DB-PostgreSQL] Connecting to PostgreSQL database...');
      await pool.query('SELECT 1');
      console.log('[DB-PostgreSQL] Connection confirmed. Creating schema and indexes...');
      await query(`
      CREATE TABLE IF NOT EXISTS customers (
        id BIGSERIAL PRIMARY KEY,
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
      ALTER TABLE customers ALTER COLUMN id TYPE BIGINT;
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
      CREATE TABLE IF NOT EXISTS staged_rates (
        id SERIAL PRIMARY KEY,
        customer_dc_id TEXT,
        customer_name TEXT,
        service_id INTEGER,
        service_name TEXT,
        courier_code TEXT,
        zone_id INTEGER,
        zone_name TEXT,
        weight_class_id INTEGER,
        weight_band TEXT,
        current_price INTEGER,
        staged_price INTEGER,
        diff_pence INTEGER,
        current_sub_price INTEGER,
        staged_sub_price INTEGER,
        diff_sub_pence INTEGER,
        applied_percent REAL,
        is_exempt INTEGER DEFAULT 0,
        exemption_reason TEXT
      );
      ALTER TABLE staged_rates ADD COLUMN IF NOT EXISTS current_sub_price INTEGER;
      ALTER TABLE staged_rates ADD COLUMN IF NOT EXISTS staged_sub_price INTEGER;
      ALTER TABLE staged_rates ADD COLUMN IF NOT EXISTS diff_sub_pence INTEGER;
      CREATE INDEX IF NOT EXISTS idx_customer_rates_dc ON customer_rates (customer_dc_id);
      CREATE INDEX IF NOT EXISTS idx_customer_rates_svc ON customer_rates (service_id);
      CREATE INDEX IF NOT EXISTS idx_customers_dc ON customers (dc_id);
      CREATE INDEX IF NOT EXISTS idx_staged_rates_dc ON staged_rates (customer_dc_id);
    `);

    // Auto-seed PostgreSQL on fresh or partially-seeded creation (check customers AND customer_rates independently!)
    const custCountRow = await pool.query('SELECT count(*) as count FROM customers');
    const rateCountRow = await pool.query('SELECT count(*) as count FROM customer_rates');
    const needsCustomers = Number(custCountRow.rows[0]?.count || 0) === 0;
    const needsRates = Number(rateCountRow.rows[0]?.count || 0) === 0;

    if (needsCustomers || needsRates) {
      const seedPath = path.join(__dirname, '../data/seed.json');
      if (fs.existsSync(seedPath)) {
        console.log(`[DB-PostgreSQL] Seeding missing data from seed.json (needsCustomers=${needsCustomers}, needsRates=${needsRates})...`);
        const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
        if (seed.couriers && seed.couriers.length > 0) {
          for (const cr of seed.couriers) {
            await pool.query('INSERT INTO couriers (id, name, code) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING', [cr.id, cr.name, cr.code]);
          }
        }
        if (seed.courier_services && seed.courier_services.length > 0) {
          for (const s of seed.courier_services) {
            await pool.query('INSERT INTO courier_services (id, courier_id, name, code) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING', [s.id, s.courier_id, s.name, s.code]);
          }
        }
        if (seed.customers && seed.customers.length > 0) {
          for (const c of seed.customers) {
            await pool.query(
              'INSERT INTO customers (dc_id, name, email, created_at, billing_period, is_exempt, custom_increase_pct, last_invoice_date, total_invoices, is_inactive_excluded) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (dc_id) DO NOTHING',
              [c.dc_id, c.name, c.email, c.created_at, c.billing_period || 'weekly', c.is_exempt || 0, c.custom_increase_pct || null, c.last_invoice_date || null, c.total_invoices || 0, c.is_inactive_excluded || 0]
            );
          }
        }
        if (needsRates && seed.customer_rates && seed.customer_rates.length > 0) {
          const chunkSize = 500;
          for (let i = 0; i < seed.customer_rates.length; i += chunkSize) {
            const chunk = seed.customer_rates.slice(i, i + chunkSize);
            const values = [];
            const params = [];
            let pIdx = 1;
            for (const r of chunk) {
              values.push(`($${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++})`);
              params.push(r.customer_dc_id, r.courier_code, r.service_id, r.service_name, r.zone_id, r.zone_name, r.weight_class_id, r.weight_band, r.current_price_pence, r.current_sub_price_pence);
            }
            await pool.query(`INSERT INTO customer_rates (customer_dc_id, courier_code, service_id, service_name, zone_id, zone_name, weight_class_id, weight_band, current_price_pence, current_sub_price_pence) VALUES ${values.join(', ')} ON CONFLICT (customer_dc_id, service_id, zone_id, weight_class_id) DO NOTHING`, params);
          }
        }
        console.log(`[DB-PostgreSQL] Successfully verified/seeded ${seed.customers?.length || 0} customers and ${seed.customer_rates?.length || 0} rate cards into indexed PostgreSQL tables!`);
      }
    }
    } catch (err) {
      console.error('[DB-PostgreSQL] Initialization error:', err.message);
    }
  }

  // Seed default pricing rules if empty
  const rules = await query('SELECT count(*) as count FROM pricing_rules');
  const count = rules[0]?.count || 0;
  if (Number(count) === 0) {
    const defaults = [
      ['DPD', 'DPD', 3.5],
      ['Yodel C2C', 'YODC2C', 3.5],
      ['Royal Mail', 'RM', 3.5],
      ['EvRi', 'EvRi', 3.5],
      ['DHL Ecommerce', 'DHL', 3.5],
      ['DHL Ecom C2C', 'DHLC2C', 3.5],
      ['UPS', 'UPS', 3.5],
      ['InPost', 'INPOST', 3.5],
      ['Pro Carrier', 'PC', 3.5],
      ['AGL', 'AGL', 3.5],
      ['PPI', 'PPI', 3.5],
      ['API TEST', 'API TEST', 0.0]
    ];
    for (const [name, code, pct] of defaults) {
      await query('INSERT INTO pricing_rules (carrier_name, carrier_code, increase_percent) VALUES (?, ?, ?)', [name, code, pct]);
    }
    await query('INSERT INTO campaign_settings (key, value) VALUES (?, ?)', ['cutoff_date', '2026-09-01']);
    await query('INSERT INTO campaign_settings (key, value) VALUES (?, ?)', ['scheduled_date', '2027-01-01T00:01:00Z']);
    await query('INSERT INTO campaign_settings (key, value) VALUES (?, ?)', ['campaign_status', 'DRAFT']);
    await query('INSERT INTO campaign_settings (key, value) VALUES (?, ?)', ['exclude_no_invoice_12m', '1']);
    await query('INSERT INTO campaign_settings (key, value) VALUES (?, ?)', ['safety_lock', 'LOCKED']);
    await query('INSERT INTO campaign_settings (key, value) VALUES (?, ?)', ['staging_status', 'IDLE']);
  }

  console.log(`[DB] Storage engine initialized: ${dbDriver.toUpperCase()}`);
}

async function replaceCustomerRates(dcId, ratesList) {
  if (dbDriver === 'postgres') {
    await pool.query('DELETE FROM customer_rates WHERE customer_dc_id = $1', [dcId]);
    if (Array.isArray(ratesList) && ratesList.length > 0) {
      const chunkSize = 500;
      for (let i = 0; i < ratesList.length; i += chunkSize) {
        const chunk = ratesList.slice(i, i + chunkSize);
        const values = [];
        const params = [];
        let pIdx = 1;
        for (const r of chunk) {
          values.push(`($${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++})`);
          params.push(
            dcId,
            r.courier_code || 'OTHER',
            Number(r.service_id),
            r.service_name || '',
            Number(r.zone_id),
            r.zone_name || '',
            Number(r.weight_class_id),
            r.weight_band || '',
            Math.round(Number(r.current_price_pence || 0)),
            r.current_sub_price_pence !== null && r.current_sub_price_pence !== undefined ? Math.round(Number(r.current_sub_price_pence)) : null
          );
        }
        await pool.query(
          `INSERT INTO customer_rates (customer_dc_id, courier_code, service_id, service_name, zone_id, zone_name, weight_class_id, weight_band, current_price_pence, current_sub_price_pence) VALUES ${values.join(', ')} ON CONFLICT (customer_dc_id, service_id, zone_id, weight_class_id) DO UPDATE SET current_price_pence = EXCLUDED.current_price_pence, current_sub_price_pence = EXCLUDED.current_sub_price_pence`,
          params
        );
      }
    }
    return ratesList.length;
  }

  // JSON-Store: update BOTH in-memory store.data AND persist to disk
  const kept = (store.data.customer_rates || []).filter(r => r.customer_dc_id !== dcId);
  let nextId = kept.reduce((max, r) => (r.id > max ? r.id : max), 0) + 1;
  for (const r of ratesList) {
    kept.push({
      id: nextId++,
      customer_dc_id: dcId,
      courier_code: r.courier_code || 'OTHER',
      service_id: Number(r.service_id),
      service_name: r.service_name || '',
      zone_id: Number(r.zone_id),
      zone_name: r.zone_name || '',
      weight_class_id: Number(r.weight_class_id),
      weight_band: r.weight_band || '',
      current_price_pence: Math.round(Number(r.current_price_pence || 0)),
      current_sub_price_pence: r.current_sub_price_pence !== null && r.current_sub_price_pence !== undefined ? Math.round(Number(r.current_sub_price_pence)) : null
    });
  }
  store.data.customer_rates = kept;
  store.save();
  return ratesList.length;
}

function reloadStore() {
  if (dbDriver === 'json-store' && store) {
    store.load();
  }
}

module.exports = {
  dbDriver,
  query,
  initDb,
  replaceCustomerRates,
  reloadStore
};
