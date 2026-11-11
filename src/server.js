require('dotenv').config();
const express = require('express');
const path = require('path');
const db = require('./db');
const billingApi = require('./billingApi');
const scheduler = require('./scheduler');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// 1. Health & Status
app.get('/api/status', async (req, res) => {
  try {
    const custCount = await db.query('SELECT count(*) as count FROM customers');
    const courierCount = await db.query('SELECT count(*) as count FROM couriers');
    const rateCount = await db.query('SELECT count(*) as count FROM customer_rates');
    const statusSetting = await db.query("SELECT value FROM campaign_settings WHERE key = 'campaign_status'");
    const dateSetting = await db.query("SELECT value FROM campaign_settings WHERE key = 'scheduled_date'");
    const exclude12mSetting = await db.query("SELECT value FROM campaign_settings WHERE key = 'exclude_no_invoice_12m'");

    const allCusts = await db.query('SELECT * FROM customers');
    const activeInvoicedCount = allCusts.filter(c => !c.is_inactive_excluded || c.is_inactive_excluded === 0).length;
    const excludedInactiveCount = allCusts.length - activeInvoicedCount;

    res.json({
      status: 'ok',
      dbDriver: db.dbDriver,
      counts: {
        customers: Number(custCount[0]?.count || 0),
        activeInvoicedCustomers: activeInvoicedCount,
        excludedInactiveCustomers: excludedInactiveCount,
        couriers: Number(courierCount[0]?.count || 0),
        rates: Number(rateCount[0]?.count || 0)
      },
      campaign: {
        status: statusSetting[0]?.value || 'DRAFT',
        scheduledDate: dateSetting[0]?.value || '2027-01-01T00:01:00Z',
        excludeNoInvoice12m: exclude12mSetting[0]?.value !== '0',
        progress: scheduler.progress
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function syncFromBillingApi() {
  console.log('[Sync] Fetching customers and couriers from Billing API...');
  const [customers, couriers, services] = await Promise.all([
    billingApi.getCustomers(),
    billingApi.getCouriers(),
    billingApi.getCourierServices()
  ]);

  const existingCusts = await db.query('SELECT dc_id FROM customers');
  const existingDcIds = new Set(existingCusts.map(c => c.dc_id));
  const isInitialLoad = existingCusts.length === 0;

  // Save customers
  for (const c of customers) {
    if (!c.dc_id) continue;
    const isNew = !isInitialLoad && !existingDcIds.has(c.dc_id);
    const idCol = db.dbDriver === 'postgres'
      ? 'INSERT INTO customers (id, dc_id, name, email, created_at, billing_period, is_new_customer) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (dc_id) DO UPDATE SET name=EXCLUDED.name, email=EXCLUDED.email, billing_period=EXCLUDED.billing_period'
      : 'INSERT OR REPLACE INTO customers (id, dc_id, name, email, created_at, billing_period, is_new_customer) VALUES (?, ?, ?, ?, ?, ?, ?)';
    await db.query(idCol, [c.id, c.dc_id, c.name, c.email || '', c.created_at, c.billing_period || 'weekly', isNew ? 1 : 0]);
  }

  // Save couriers
  for (const cr of couriers) {
    const crSql = db.dbDriver === 'postgres'
      ? 'INSERT INTO couriers (id, name, code) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, code=EXCLUDED.code'
      : 'INSERT OR REPLACE INTO couriers (id, name, code) VALUES (?, ?, ?)';
    await db.query(crSql, [cr.id, cr.name, cr.code]);
  }

  // Save services
  for (const s of services) {
    const sSql = db.dbDriver === 'postgres'
      ? 'INSERT INTO courier_services (id, courier_id, name, code) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, code=EXCLUDED.code'
      : 'INSERT OR REPLACE INTO courier_services (id, courier_id, name, code) VALUES (?, ?, ?, ?)';
    await db.query(sSql, [s.id, s.client_courier_id, s.name, s.code]);
  }

  // Audit customer invoices (12-month inactivity exclusion)
  const auditResult = await auditCustomerInvoices(customers);

  // Populate baseline rates for active customers
  const activeCusts = customers.filter(c => c.is_inactive_excluded !== 1);
  await ensureRatesForCustomers(activeCusts);

  const nowIso = new Date().toISOString();
  const upsertSql = db.dbDriver === 'postgres'
    ? 'INSERT INTO campaign_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value'
    : 'INSERT OR REPLACE INTO campaign_settings (key, value) VALUES (?, ?)';
  await db.query(upsertSql, ['last_sync_time', nowIso]);

  return {
    customersSynced: customers.length,
    activeInvoicedCustomers: auditResult.activeCount,
    excludedInactiveCustomers: auditResult.excludedCount,
    couriersSynced: couriers.length,
    servicesSynced: services.length,
    lastSyncTime: nowIso
  };
}

// 2. Full Sync from Billing API
app.post('/api/sync', async (req, res) => {
  try {
    const result = await syncFromBillingApi();
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[Sync] Failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// 3. Customers List
app.get('/api/customers', async (req, res) => {
  try {
    const includeExcluded = req.query.include_excluded === '1' || req.query.include_excluded === 'true';
    const exclude12mSetting = await db.query("SELECT value FROM campaign_settings WHERE key = 'exclude_no_invoice_12m'");
    const exclude12m = exclude12mSetting[0]?.value !== '0';

    let list = await db.query('SELECT * FROM customers');
    if (!includeExcluded && exclude12m) {
      list = list.filter(c => !c.is_inactive_excluded || c.is_inactive_excluded === 0);
    }
    list.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Toggle 12-Month Inactivity Exclusion Gate
app.post('/api/settings/invoice-gate', async (req, res) => {
  try {
    const { enabled } = req.body;
    const val = enabled ? '1' : '0';
    const upsertSql = db.dbDriver === 'postgres'
      ? 'INSERT INTO campaign_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value'
      : 'INSERT OR REPLACE INTO campaign_settings (key, value) VALUES (?, ?)';
    await db.query(upsertSql, ['exclude_no_invoice_12m', val]);
    res.json({ success: true, excludeNoInvoice12m: Boolean(enabled) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Toggle Exemption or Custom Percentage
app.post('/api/customers/:dcId/exempt', async (req, res) => {
  try {
    const { is_exempt, custom_increase_pct } = req.body;
    await db.query(
      'UPDATE customers SET is_exempt = ?, custom_increase_pct = ? WHERE dc_id = ?',
      [is_exempt ? 1 : 0, custom_increase_pct !== undefined ? custom_increase_pct : null, req.params.dcId]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Bulk Exemption or Custom Percentage
app.post('/api/customers/bulk-exempt', async (req, res) => {
  try {
    const { dc_ids, is_exempt, custom_increase_pct } = req.body;
    if (Array.isArray(dc_ids)) {
      for (const dc_id of dc_ids) {
        await db.query(
          'UPDATE customers SET is_exempt = ?, custom_increase_pct = ? WHERE dc_id = ?',
          [is_exempt ? 1 : 0, custom_increase_pct !== undefined ? custom_increase_pct : null, dc_id]
        );
      }
    }
    res.json({ success: true, count: dc_ids?.length || 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add or Update Customer Rates
app.post('/api/customers/:dcId/rates', async (req, res) => {
  try {
    const { dcId } = req.params;
    const { rates } = req.body;
    if (Array.isArray(rates)) {
      for (const r of rates) {
        const sql = db.dbDriver === 'postgres'
          ? 'INSERT INTO customer_rates (customer_dc_id, courier_code, service_id, service_name, zone_id, zone_name, weight_class_id, weight_band, current_price_pence, current_sub_price_pence) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (customer_dc_id, service_id, zone_id, weight_class_id) DO UPDATE SET current_price_pence = EXCLUDED.current_price_pence, current_sub_price_pence = EXCLUDED.current_sub_price_pence'
          : 'INSERT OR REPLACE INTO customer_rates (customer_dc_id, courier_code, service_id, service_name, zone_id, zone_name, weight_class_id, weight_band, current_price_pence, current_sub_price_pence) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
        await db.query(sql, [
          dcId,
          r.courier_code || 'DPD',
          Number(r.service_id),
          r.service_name || 'Standard Service',
          Number(r.zone_id || 9527),
          r.zone_name || 'Mainland',
          Number(r.weight_class_id || 17516),
          r.weight_band || 'Standard',
          Math.round(Number(r.price)),
          Math.round(Number(r.sub_price || 0))
        ]);
      }
    }
    res.json({ success: true, ratesCount: rates?.length || 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Customer Exclusion Statistics
app.get('/api/customers/stats', async (req, res) => {
  try {
    const cutoffRow = await db.query("SELECT value FROM campaign_settings WHERE key = 'cutoff_date'");
    const cutoffDate = cutoffRow[0]?.value || '2026-09-01';
    const cutoffTimestamp = new Date(cutoffDate).getTime();

    const list = await db.query('SELECT * FROM customers');
    const active = list.filter(c => !c.is_inactive_excluded || c.is_inactive_excluded === 0);
    const dormant = list.filter(c => c.is_inactive_excluded === 1);

    const isCutoffExempt = (c) => {
      const isTest = (c.dc_id || '').toLowerCase().includes('test') || (c.name || '').toLowerCase().includes('test');
      return !isTest && c.created_at && new Date(c.created_at).getTime() > cutoffTimestamp;
    };

    const introExempt = active.filter(c => isCutoffExempt(c));
    const manualExempt = active.filter(c => Number(c.is_exempt) === 1);
    const allExempt = active.filter(c => Number(c.is_exempt) === 1 || isCutoffExempt(c));
    const custom = active.filter(c => !isCutoffExempt(c) && !c.is_exempt && c.custom_increase_pct !== null && c.custom_increase_pct !== undefined);
    const standard = active.filter(c => !isCutoffExempt(c) && !c.is_exempt && (c.custom_increase_pct === null || c.custom_increase_pct === undefined));
    const pushed = active.filter(c => c.last_pushed_at && c.last_pushed_status === 'success');
    const pending = active.filter(c => !isCutoffExempt(c) && !c.is_exempt && !c.last_pushed_at);
    const newCustomers = active.filter(c => Number(c.is_new_customer) === 1);

    res.json({
      total: list.length,
      active: active.length,
      dormant: dormant.length,
      standard: standard.length,
      exempt: allExempt.length,
      manualExempt: manualExempt.length,
      introExempt: introExempt.length,
      custom: custom.length,
      pushed: pushed.length,
      pending: pending.length,
      newCustomers: newCustomers.length,
      cutoffDate
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Couriers List
app.get('/api/couriers', async (req, res) => {
  try {
    const list = await db.query('SELECT * FROM couriers ORDER BY name ASC');
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. Rules
app.get('/api/rules', async (req, res) => {
  try {
    // Ensure all couriers in DB have a pricing rule
    const couriers = await db.query('SELECT * FROM couriers');
    let rules = await db.query('SELECT * FROM pricing_rules');
    const existingCodes = new Set(rules.map(r => r.carrier_code || r.carrier_name));

    const defaultPcts = {
      'DPD': 3.5,
      'YODC2C': 3.5,
      'RM': 3.5,
      'EvRi': 3.5,
      'DHL': 3.5,
      'DHLC2C': 3.5,
      'UPS': 3.5,
      'INPOST': 3.5,
      'PC': 3.5,
      'AGL': 3.5,
      'PPI': 3.5,
      'API TEST': 0.0
    };

    let addedNew = false;
    for (const c of couriers) {
      if (!existingCodes.has(c.code) && !existingCodes.has(c.name)) {
        const pct = defaultPcts[c.code] !== undefined ? defaultPcts[c.code] : 3.0;
        await db.query('INSERT INTO pricing_rules (carrier_name, carrier_code, increase_percent) VALUES (?, ?, ?)', [c.name, c.code, pct]);
        addedNew = true;
      }
    }
    if (addedNew) {
      rules = await db.query('SELECT * FROM pricing_rules');
    }
    rules.sort((a, b) => (a.carrier_name || '').localeCompare(b.carrier_name || ''));

    const cutoff = await db.query("SELECT value FROM campaign_settings WHERE key = 'cutoff_date'");
    res.json({
      rules,
      cutoffDate: cutoff[0]?.value || '2026-09-01'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/rules', async (req, res) => {
  try {
    const { rules, cutoffDate } = req.body;
    if (Array.isArray(rules)) {
      for (const r of rules) {
        const sql = db.dbDriver === 'postgres'
          ? 'UPDATE pricing_rules SET increase_percent = $1, fixed_markup_pence = $2, active = $3 WHERE carrier_name = $4'
          : 'UPDATE pricing_rules SET increase_percent = ?, fixed_markup_pence = ?, active = ? WHERE carrier_name = ?';
        await db.query(sql, [
          Number(r.increase_percent || 0),
          Math.round(Number(r.fixed_markup_pence || 0)),
          r.active ? 1 : 0,
          r.carrier_name || r.carrier_code
        ]);
      }
    }
    if (cutoffDate) {
      const upsertSql = db.dbDriver === 'postgres'
        ? 'INSERT INTO campaign_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value'
        : 'INSERT OR REPLACE INTO campaign_settings (key, value) VALUES (?, ?)';
      await db.query(upsertSql, ['cutoff_date', cutoffDate]);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update a single courier percentage rule (instant sync from Tab 1 or Tab 3)
app.post('/api/rules/carrier', async (req, res) => {
  try {
    const { carrier_code, carrier_name, increase_percent } = req.body;
    const identifier = carrier_code || carrier_name;
    const pct = parseFloat(increase_percent) || 0;
    const sql = db.dbDriver === 'postgres'
      ? 'UPDATE pricing_rules SET increase_percent = $1, fixed_markup_pence = $2, active = $3 WHERE carrier_code = $4'
      : 'UPDATE pricing_rules SET increase_percent = ?, fixed_markup_pence = ?, active = ? WHERE carrier_code = ?';
    await db.query(sql, [pct, 0, 1, identifier]);
    res.json({ success: true, carrier: identifier, increase_percent: pct });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Apply uniform percentage markup to all couriers instantly
app.post('/api/rules/uniform', async (req, res) => {
  try {
    const pct = parseFloat(req.body.increase_percent) || 0;
    const rules = await db.query('SELECT * FROM pricing_rules');
    for (const r of rules) {
      if (r.carrier_code === 'API TEST') continue;
      const identifier = r.carrier_code || r.carrier_name;
      const sql = db.dbDriver === 'postgres'
        ? 'UPDATE pricing_rules SET increase_percent = $1, fixed_markup_pence = $2, active = $3 WHERE carrier_code = $4'
        : 'UPDATE pricing_rules SET increase_percent = ?, fixed_markup_pence = ?, active = ? WHERE carrier_code = ?';
      await db.query(sql, [pct, 0, 1, identifier]);
    }
    res.json({ success: true, increase_percent: pct });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. Rates Preview & Diff Calculation
app.get('/api/rates/preview', async (req, res) => {
  try {
    const customerDcId = req.query.customer_dc_id && req.query.customer_dc_id !== 'all' ? req.query.customer_dc_id : null;
    const carrier = req.query.carrier && req.query.carrier !== 'all' ? req.query.carrier : null;
    const search = (req.query.search || '').trim().toLowerCase();

    let rates = await scheduler.calculateCustomerRates(customerDcId);

    if (carrier) {
      rates = rates.filter(r => r.courier_code === carrier || (r.service_name && r.service_name.toLowerCase().includes(carrier.toLowerCase())));
    }

    if (search) {
      rates = rates.filter(r =>
        (r.customer_name && r.customer_name.toLowerCase().includes(search)) ||
        (r.customer_dc_id && r.customer_dc_id.toLowerCase().includes(search)) ||
        (r.service_name && r.service_name.toLowerCase().includes(search))
      );
    }

    let totalOldPence = 0;
    let totalNewPence = 0;
    let exemptCount = 0;
    const uniqueCustomers = new Set();

    for (const r of rates) {
      totalOldPence += r.old_price;
      totalNewPence += r.new_price;
      uniqueCustomers.add(r.customer_dc_id);
      if (r.is_exempt) exemptCount++;
    }

    const totalDiffPence = totalNewPence - totalOldPence;
    const avgPct = totalOldPence > 0 ? ((totalDiffPence / totalOldPence) * 100).toFixed(2) : '0.00';

    // If viewing a specific customer or search filter, return all matching rates.
    // If viewing all customers, return the first 500 rows for high UI responsiveness.
    const returnedRates = (customerDcId || search) ? rates : rates.slice(0, 500);

    res.json({
      summary: {
        totalCustomers: uniqueCustomers.size,
        totalRates: rates.length,
        exemptRates: exemptCount,
        totalOldCost: (totalOldPence / 100).toFixed(2),
        totalNewCost: (totalNewPence / 100).toFixed(2),
        totalDifference: (totalDiffPence / 100).toFixed(2),
        averageIncreasePercent: avgPct
      },
      rates: returnedRates,
      totalCount: rates.length,
      returnedCount: returnedRates.length
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6. Sandbox Testing Lab
app.post('/api/sandbox/create-customer', async (req, res) => {
  try {
    const rawName = (req.body.name || 'test Jan').trim();
    const rawDcId = (req.body.dc_id || rawName).trim();

    let result;
    let alreadyExists = false;

    try {
      result = await billingApi.createCustomer({
        ...req.body,
        name: rawName,
        dc_id: rawDcId
      });
    } catch (err) {
      const errMsg = (err.data && typeof err.data === 'object' && err.data.error) || err.message || '';
      if (errMsg.toLowerCase().includes('already been registered')) {
        alreadyExists = true;
        result = { success: true, message: `Customer "${rawName}" is already registered in Billing API and ready to test!`, alreadyExists: true };
      } else {
        throw err;
      }
    }

    // Upsert into local database so customer is active and available immediately
    const upsertCustSql = db.dbDriver === 'postgres'
      ? 'INSERT INTO customers (dc_id, name, email, created_at, is_inactive_excluded, is_exempt) VALUES ($1, $2, $3, $4, 0, 0) ON CONFLICT (dc_id) DO UPDATE SET name = EXCLUDED.name, is_inactive_excluded = 0'
      : 'INSERT OR REPLACE INTO customers (dc_id, name, email, created_at, is_inactive_excluded, is_exempt) VALUES (?, ?, ?, ?, 0, 0)';
    await db.query(upsertCustSql, [rawDcId, rawName, req.body.email || 'testing@despatchcloud.com', new Date().toISOString()]);

    // Ensure baseline sample rates are seeded for this customer across couriers
    await ensureRatesForCustomers([{ dc_id: rawDcId, name: rawName }]);

    await db.query(
      'INSERT INTO audit_logs (event_type, customer_dc_id, details, status, created_at) VALUES (?, ?, ?, ?, ?)',
      ['SANDBOX_CREATE_CUSTOMER', rawDcId, JSON.stringify(result), 'SUCCESS', new Date().toISOString()]
    );

    res.json({ success: true, customer_dc_id: rawDcId, name: rawName, alreadyExists, result });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, data: err.data });
  }
});

async function handleSandboxPushRates(req, res) {
  let pricesToPush = req.body.prices;
  const testDcId = (req.body.customer_dc_id || 'test Jan').trim();
  try {
    const isTestCustomer = testDcId.toLowerCase().includes('test');
    
    // Safety lock enforcement: only sandbox test accounts can be pushed if locked
    const lockRow = await db.query("SELECT value FROM campaign_settings WHERE key = 'safety_lock'");
    const isLocked = !lockRow[0] || lockRow[0].value !== 'UNLOCKED';
    if (isLocked && !isTestCustomer) {
      return res.status(403).json({
        error: `Deployment Blocked: System Safety Lock is ACTIVE (LOCKED). Live price updates to customer "${testDcId}" cannot occur while the safety lock is engaged. Please unlock the system first.`
      });
    }

    if (!pricesToPush || !Array.isArray(pricesToPush) || pricesToPush.length === 0) {
      // Calculate rates for this customer from our rules engine
      let calculated = await scheduler.calculateCustomerRates(testDcId);
      if (calculated.length === 0) {
        // Ensure customer exists and has sample rates seeded if none exist
        const custs = await db.query('SELECT * FROM customers WHERE dc_id = ?', [testDcId]);
        if (custs.length === 0) {
          const insertSql = db.dbDriver === 'postgres'
            ? 'INSERT INTO customers (dc_id, name, created_at, is_inactive_excluded, is_exempt) VALUES ($1, $2, $3, 0, 0) ON CONFLICT (dc_id) DO NOTHING'
            : 'INSERT OR IGNORE INTO customers (dc_id, name, created_at, is_inactive_excluded, is_exempt) VALUES (?, ?, ?, 0, 0)';
          await db.query(insertSql, [testDcId, testDcId, new Date().toISOString()]);
        }
        await ensureRatesForCustomers([{ dc_id: testDcId, name: testDcId }]);
        calculated = await scheduler.calculateCustomerRates(testDcId);
      }

      pricesToPush = calculated.map(r => ({
        service_id: Number(r.service_id),
        zone_id: Number(r.zone_id),
        weight_class_id: Number(r.weight_class_id),
        price: Number(r.new_price),
        sub_price: Number(r.new_sub_price)
      }));
    }

    const result = await billingApi.updateCustomerPrices(testDcId, pricesToPush);
    const auditDetails = JSON.stringify({
      count: pricesToPush.length,
      payload: pricesToPush,
      response: result
    });
    await db.query(
      'INSERT INTO audit_logs (event_type, customer_dc_id, details, status, created_at) VALUES (?, ?, ?, ?, ?)',
      ['PRICE_PUSH', testDcId, auditDetails, 'SUCCESS', new Date().toISOString()]
    );
    await db.query(
      'UPDATE customers SET last_pushed_at = ?, last_pushed_status = ? WHERE dc_id = ?',
      [new Date().toISOString(), 'success', testDcId]
    );
    res.json({ success: true, customer_dc_id: testDcId, ratesUpdated: pricesToPush.length, pricesSent: pricesToPush, result });
  } catch (err) {
    const errorDetails = JSON.stringify({
      count: pricesToPush ? pricesToPush.length : 0,
      payload: pricesToPush || [],
      error: err.message,
      data: err.data
    });
    await db.query(
      'INSERT INTO audit_logs (event_type, customer_dc_id, details, status, created_at) VALUES (?, ?, ?, ?, ?)',
      ['PRICE_PUSH_FAILED', testDcId, errorDetails, 'FAILED', new Date().toISOString()]
    );
    await db.query(
      'UPDATE customers SET last_pushed_at = ?, last_pushed_status = ? WHERE dc_id = ?',
      [new Date().toISOString(), 'failed', testDcId]
    );
    res.status(err.status || 500).json({ error: err.message, data: err.data });
  }
}

app.post('/api/sandbox/push-rates', handleSandboxPushRates);
app.post('/api/sandbox/test-price-update', handleSandboxPushRates);

// Staging & Safety Lock Management Endpoints
app.get('/api/staging/status', async (req, res) => {
  try {
    const lockRow = await db.query("SELECT value FROM campaign_settings WHERE key = 'safety_lock'");
    const statusRow = await db.query("SELECT value FROM campaign_settings WHERE key = 'staging_status'");
    const stagedAtRow = await db.query("SELECT value FROM campaign_settings WHERE key = 'staged_at'");

    const safetyLock = lockRow[0]?.value || 'LOCKED';
    const stagingStatus = statusRow[0]?.value || 'IDLE';
    const stagedAt = stagedAtRow[0]?.value || null;

    const stagedRates = await db.query('SELECT * FROM staged_rates');
    const uniqueCusts = new Set(stagedRates.map(r => r.customer_dc_id));
    const exemptRates = stagedRates.filter(r => r.is_exempt);

    let totalOld = 0, totalNew = 0;
    for (const r of stagedRates) {
      totalOld += (r.current_price || r.old_price || 0);
      totalNew += (r.staged_price || r.new_price || 0);
    }
    const totalDiff = totalNew - totalOld;
    const avgPct = totalOld > 0 ? ((totalDiff / totalOld) * 100).toFixed(2) : '0.00';

    res.json({
      safetyLock,
      stagingStatus,
      stagedAt,
      isLocked: safetyLock !== 'UNLOCKED',
      summary: {
        totalCustomers: uniqueCusts.size,
        totalRates: stagedRates.length,
        exemptRates: exemptRates.length,
        totalOldCost: (totalOld / 100).toFixed(2),
        totalNewCost: (totalNew / 100).toFixed(2),
        totalDifference: (totalDiff / 100).toFixed(2),
        averageIncreasePercent: avgPct
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/staging/lock', async (req, res) => {
  try {
    const isLocked = req.body.locked === true || req.body.locked === 'true' || req.body.lock === 'LOCKED' || req.body.action === 'lock';
    const newLockState = isLocked ? 'LOCKED' : 'UNLOCKED';
    const upsertSql = db.dbDriver === 'postgres'
      ? 'INSERT INTO campaign_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value'
      : 'INSERT OR REPLACE INTO campaign_settings (key, value) VALUES (?, ?)';

    await db.query(upsertSql, ['safety_lock', newLockState]);
    await db.query(
      'INSERT INTO audit_logs (event_type, customer_dc_id, details, status, created_at) VALUES (?, ?, ?, ?, ?)',
      ['SAFETY_LOCK_TOGGLED', 'SYSTEM', `Lock set to ${newLockState}`, newLockState, new Date().toISOString()]
    );
    res.json({ success: true, safetyLock: newLockState, isLocked: newLockState !== 'UNLOCKED' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/staging/generate', async (req, res) => {
  try {
    const calculated = await scheduler.calculateCustomerRates();
    await db.query('DELETE FROM staged_rates');

    const stagedList = calculated.map(r => ({
      customer_dc_id: r.customer_dc_id,
      customer_name: r.customer_name,
      service_id: r.service_id,
      service_name: r.service_name,
      courier_code: r.courier_code,
      zone_id: r.zone_id,
      zone_name: r.zone_name,
      weight_class_id: r.weight_class_id,
      weight_band: r.weight_band,
      current_price: r.old_price,
      staged_price: r.new_price,
      diff_pence: r.diff_pence,
      applied_percent: r.applied_percent,
      is_exempt: r.is_exempt ? 1 : 0,
      exemption_reason: r.exemption_reason || null
    }));

    if (db.dbDriver === 'json-store') {
      await db.query('INSERT INTO staged_rates', [stagedList]);
    } else {
      for (const r of stagedList) {
        await db.query(
          'INSERT INTO staged_rates (customer_dc_id, customer_name, service_id, service_name, courier_code, zone_id, zone_name, weight_class_id, weight_band, current_price, staged_price, diff_pence, applied_percent, is_exempt, exemption_reason) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)',
          [r.customer_dc_id, r.customer_name, r.service_id, r.service_name, r.courier_code, r.zone_id, r.zone_name, r.weight_class_id, r.weight_band, r.current_price, r.staged_price, r.diff_pence, r.applied_percent, r.is_exempt, r.exemption_reason]
        );
      }
    }

    const stagedAt = new Date().toISOString();
    const upsertSql = db.dbDriver === 'postgres'
      ? 'INSERT INTO campaign_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value'
      : 'INSERT OR REPLACE INTO campaign_settings (key, value) VALUES (?, ?)';

    await db.query(upsertSql, ['staging_status', 'STAGED']);
    await db.query(upsertSql, ['staged_at', stagedAt]);

    const uniqueCusts = new Set(stagedList.map(r => r.customer_dc_id));
    await db.query(
      'INSERT INTO audit_logs (event_type, customer_dc_id, details, status, created_at) VALUES (?, ?, ?, ?, ?)',
      ['STAGING_GENERATED', 'SYSTEM', `Staged ${uniqueCusts.size} customers across ${stagedList.length} rates`, 'STAGED', stagedAt]
    );

    res.json({
      success: true,
      stagingStatus: 'STAGED',
      stagedAt,
      totalCustomers: uniqueCusts.size,
      totalRates: stagedList.length
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/staging/discard', async (req, res) => {
  try {
    await db.query('DELETE FROM staged_rates');
    const upsertSql = db.dbDriver === 'postgres'
      ? 'INSERT INTO campaign_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value'
      : 'INSERT OR REPLACE INTO campaign_settings (key, value) VALUES (?, ?)';
    await db.query(upsertSql, ['staging_status', 'IDLE']);
    await db.query(upsertSql, ['staged_at', '']);
    await db.query(
      'INSERT INTO audit_logs (event_type, customer_dc_id, details, status, created_at) VALUES (?, ?, ?, ?, ?)',
      ['STAGING_DISCARDED', 'SYSTEM', 'Staged proposals discarded', 'IDLE', new Date().toISOString()]
    );
    res.json({ success: true, stagingStatus: 'IDLE' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/staging/customer-rates', async (req, res) => {
  try {
    const dcId = req.query.customer_dc_id;
    if (!dcId) return res.status(400).json({ error: 'customer_dc_id required' });

    let staged = await db.query('SELECT * FROM staged_rates WHERE customer_dc_id = ?', [dcId]);
    if (staged.length === 0) {
      const calculated = await scheduler.calculateCustomerRates(dcId);
      staged = calculated.map(r => ({
        customer_dc_id: r.customer_dc_id,
        customer_name: r.customer_name,
        service_id: r.service_id,
        service_name: r.service_name,
        courier_code: r.courier_code,
        zone_id: r.zone_id,
        zone_name: r.zone_name,
        weight_class_id: r.weight_class_id,
        weight_band: r.weight_band,
        current_price: r.old_price,
        staged_price: r.new_price,
        diff_pence: r.diff_pence,
        applied_percent: r.applied_percent,
        is_exempt: r.is_exempt ? 1 : 0,
        exemption_reason: r.exemption_reason || null
      }));
    }
    res.json({ customer_dc_id: dcId, rates: staged });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/staging/release', async (req, res) => {
  try {
    const lockRow = await db.query("SELECT value FROM campaign_settings WHERE key = 'safety_lock'");
    const isLocked = !lockRow[0] || lockRow[0].value !== 'UNLOCKED';
    if (isLocked) {
      return res.status(403).json({
        error: 'Deployment Blocked: System Safety Lock is ACTIVE (LOCKED). You must explicitly unlock the system before any live rate changes can occur.'
      });
    }

    const statusRow = await db.query("SELECT value FROM campaign_settings WHERE key = 'staging_status'");
    if (statusRow[0]?.value !== 'STAGED') {
      return res.status(400).json({
        error: 'No rates currently staged. Please stage rates for review first.'
      });
    }

    const result = await scheduler.executeCampaign('STAGED_RELEASE');

    // Automatically re-lock system for safety
    const upsertSql = db.dbDriver === 'postgres'
      ? 'INSERT INTO campaign_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value'
      : 'INSERT OR REPLACE INTO campaign_settings (key, value) VALUES (?, ?)';
    await db.query(upsertSql, ['safety_lock', 'LOCKED']);
    await db.query(upsertSql, ['staging_status', 'DEPLOYED']);

    await db.query(
      'INSERT INTO audit_logs (event_type, customer_dc_id, details, status, created_at) VALUES (?, ?, ?, ?, ?)',
      ['SAFETY_LOCK_AUTO_RELOCKED', 'SYSTEM', 'System automatically re-locked following rate deployment', 'LOCKED', new Date().toISOString()]
    );

    res.json({ success: true, message: 'Staged rates deployed successfully to Despatch Cloud Billing API. System re-locked.', result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 7. Execution & Scheduling
app.post('/api/campaign/arm', async (req, res) => {
  try {
    const { scheduledDate } = req.body;
    const target = scheduledDate || '2027-01-01T00:01:00Z';
    const upsertSql = db.dbDriver === 'postgres'
      ? 'INSERT INTO campaign_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value'
      : 'INSERT OR REPLACE INTO campaign_settings (key, value) VALUES (?, ?)';

    await db.query(upsertSql, ['campaign_status', 'ARMED']);
    await db.query(upsertSql, ['scheduled_date', target]);

    await db.query(
      'INSERT INTO audit_logs (event_type, customer_dc_id, details, status, created_at) VALUES (?, ?, ?, ?, ?)',
      ['CAMPAIGN_ARMED', 'SYSTEM', `Target Date: ${target}`, 'ARMED', new Date().toISOString()]
    );

    res.json({ success: true, status: 'ARMED', scheduledDate: target });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/campaign/run-now', async (req, res) => {
  try {
    if (scheduler.isRunning) {
      return res.status(409).json({ error: 'Campaign is already running.' });
    }
    // Fire asynchronously in background
    scheduler.executeCampaign('MANUAL_RUN_BUTTON').catch(err => {
      console.error('[Manual Run] Background failure:', err);
    });
    res.json({ success: true, message: 'Execution initiated in background.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/campaign/progress', (req, res) => {
  res.json(scheduler.progress);
});

// 8. Audit Logs
app.get('/api/audit-logs', async (req, res) => {
  try {
    const logs = await db.query('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 50');
    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 9. Export CSV
app.get('/api/export-csv', async (req, res) => {
  try {
    const rates = await scheduler.calculateCustomerRates();
    const headers = ['Customer DC ID', 'Customer Name', 'Carrier', 'Service Name', 'Zone', 'Weight Band', 'Old Price (£)', 'New Price (£)', 'Diff (£)', 'Increase %', 'Exempt Reason'];
    const rows = rates.map(r => [
      `"${r.customer_dc_id}"`,
      `"${r.customer_name}"`,
      `"${r.courier_code}"`,
      `"${r.service_name}"`,
      `"${r.zone_name}"`,
      `"${r.weight_band}"`,
      (r.old_price / 100).toFixed(2),
      (r.new_price / 100).toFixed(2),
      (r.diff_pence / 100).toFixed(2),
      r.applied_percent + '%',
      `"${r.exemption_reason || 'Eligible'}"`
    ]);

    const csvContent = [headers.join(','), ...rows.map(e => e.join(','))].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="january_pricing_increase_diff.csv"');
    res.send(csvContent);
  } catch (err) {
    res.status(500).send('Failed to generate CSV: ' + err.message);
  }
});

async function auditCustomerInvoices(customers) {
  console.log(`[InvoiceGate] Auditing 12-month invoice activity for ${customers.length} customers...`);
  const now = Date.now();
  const twelveMonthsAgo = now - (365 * 24 * 3600 * 1000);

  const chunkSize = 10;
  let activeCount = 0;
  let excludedCount = 0;

  for (let i = 0; i < customers.length; i += chunkSize) {
    const chunk = customers.slice(i, i + chunkSize);
    await Promise.all(chunk.map(async c => {
      let lastInvDate = null;
      let totalInvs = 0;
      let isExcluded = 1;

      // Rule 1: All customers with DC ID starting with HOF are excluded
      const isHof = (c.dc_id || '').toUpperCase().startsWith('HOF');
      const isTest = (c.dc_id || '').toLowerCase().includes('test') || (c.name || '').toLowerCase().includes('test');

      if (isTest) {
        isExcluded = 0;
      } else if (!isHof) {
        try {
          const invRes = await billingApi.getCustomerInvoices(c.dc_id);
          const invs = invRes.data || (Array.isArray(invRes) ? invRes : []);
          totalInvs = invs.length;

          // Rule 2: Invoices must have total > 0 or subtotal > 0 (ignore £0 automated ledger dummies)
          const billedInvs = invs.filter(inv => {
            const tot = Number(inv.total || 0);
            const sub = Number(inv.subtotal || 0);
            return tot > 0 || sub > 0;
          });

          if (billedInvs.length > 0) {
            const last = billedInvs[billedInvs.length - 1];
            lastInvDate = last.generation_date || last.created_at || null;
            const lastTime = lastInvDate ? new Date(lastInvDate).getTime() : 0;
            if (lastTime >= twelveMonthsAgo) {
              isExcluded = 0;
            }
          }
        } catch (e) {
          isExcluded = 1;
        }
      }

      if (isExcluded === 0) activeCount++;
      else excludedCount++;

      const updateSql = db.dbDriver === 'postgres'
        ? 'UPDATE customers SET last_invoice_date = $1, total_invoices = $2, is_inactive_excluded = $3 WHERE dc_id = $4'
        : 'UPDATE customers SET last_invoice_date = ?, total_invoices = ?, is_inactive_excluded = ? WHERE dc_id = ?';
      await db.query(updateSql, [lastInvDate, totalInvs, isExcluded, c.dc_id]);
    }));
  }

  console.log(`[InvoiceGate] Audit complete: ${activeCount} active, ${excludedCount} excluded (>12m no non-zero invoice or HOF).`);
  return { activeCount, excludedCount, total: customers.length };
}

async function ensureRatesForCustomers(customers) {
  const existing = await db.query('SELECT count(*) as count FROM customer_rates');
  const count = Number(existing[0]?.count || 0);
  if (count === 0) {
    console.log('[RateShift] Customer rates empty. Ingesting from prices.csv...');
    const { ingestPrices } = require('../scripts/ingest_prices');
    await ingestPrices();
  }
}

app.post('/api/rates/reload-csv', async (req, res) => {
  try {
    const { ingestPrices } = require('../scripts/ingest_prices');
    const count = await ingestPrices();
    res.json({ success: true, count, message: `Successfully reloaded ${count} rates from prices.csv` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Start Server
async function start() {
  await db.initDb();
  scheduler.init();

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[RateShift] Server running on http://0.0.0.0:${PORT}`);
  });

  try {
    let custs = await db.query('SELECT * FROM customers');
    if (custs.length === 0) {
      console.log('[RateShift] Database empty. Running initial sync from Billing API...');
      syncFromBillingApi().then(res => {
        console.log(`[RateShift] Initial sync complete: ${res.customersSynced} customers loaded.`);
      }).catch(err => {
        console.warn('[RateShift] Initial auto-sync error:', err.message);
      });
    } else {
      const needsAudit = custs.some(c => 
        c.is_inactive_excluded === undefined || 
        c.is_inactive_excluded === null || 
        ((c.dc_id || '').toUpperCase().startsWith('HOF') && c.is_inactive_excluded !== 1)
      );
      if (needsAudit) {
        auditCustomerInvoices(custs).then(res => {
          console.log(`[InvoiceGate] Background audit complete: ${res.activeCount} active, ${res.excludedCount} excluded.`);
        }).catch(err => {
          console.warn('[InvoiceGate] Background audit error:', err.message);
        });
      }

      const activeCusts = custs.filter(c => c.is_inactive_excluded !== 1);
      ensureRatesForCustomers(activeCusts.length > 0 ? activeCusts : custs).then(() => {
        console.log(`[RateShift] Rate cards verified/seeded across ${custs.length} customers.`);
      }).catch(err => {
        console.warn('[RateShift] ensureRatesForCustomers error:', err.message);
      });
    }
  } catch (e) {
    console.warn('[RateShift] Initial rate verification warning:', e.message);
  }
}

start().catch(err => {
  console.error('[Fatal] Server failed to start:', err);
  process.exit(1);
});
