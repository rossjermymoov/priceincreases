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

// 2. Full Sync from Billing API
app.post('/api/sync', async (req, res) => {
  try {
    console.log('[Sync] Fetching customers and couriers from Billing API...');
    const [customers, couriers, services] = await Promise.all([
      billingApi.getCustomers(),
      billingApi.getCouriers(),
      billingApi.getCourierServices()
    ]);

    // Save customers
    for (const c of customers) {
      if (!c.dc_id) continue;
      const idCol = db.dbDriver === 'postgres'
        ? 'INSERT INTO customers (id, dc_id, name, email, created_at, billing_period) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (dc_id) DO UPDATE SET name=EXCLUDED.name, email=EXCLUDED.email, billing_period=EXCLUDED.billing_period'
        : 'INSERT OR REPLACE INTO customers (id, dc_id, name, email, created_at, billing_period) VALUES (?, ?, ?, ?, ?, ?)';
      await db.query(idCol, [c.id, c.dc_id, c.name, c.email || '', c.created_at, c.billing_period || 'weekly']);
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

    res.json({
      success: true,
      customersSynced: customers.length,
      activeInvoicedCustomers: auditResult.activeCount,
      excludedInactiveCustomers: auditResult.excludedCount,
      couriersSynced: couriers.length,
      servicesSynced: services.length
    });
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

// 4. Rules
app.get('/api/rules', async (req, res) => {
  try {
    const rules = await db.query('SELECT * FROM pricing_rules ORDER BY carrier_name ASC');
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
        await db.query(
          'UPDATE pricing_rules SET increase_percent = ?, active = ? WHERE carrier_name = ?',
          [Number(r.increase_percent), r.active ? 1 : 0, r.carrier_name]
        );
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
    const result = await billingApi.createCustomer(req.body);
    await db.query(
      'INSERT INTO audit_logs (event_type, customer_dc_id, details, status, created_at) VALUES (?, ?, ?, ?, ?)',
      ['SANDBOX_CREATE_CUSTOMER', req.body.dc_id || 'TEST-JAN-2027', JSON.stringify(result), 'SUCCESS', new Date().toISOString()]
    );
    res.json({ success: true, result });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, data: err.data });
  }
});

app.post('/api/sandbox/test-price-update', async (req, res) => {
  try {
    const testDcId = req.body.customer_dc_id || 'TEST-JAN-2027';
    const testPrices = req.body.prices || [
      { service_id: 764, zone_id: 9527, weight_class_id: 17516, price: 1662, sub_price: 416 },
      { service_id: 2777, zone_id: 20809, weight_class_id: 33799, price: 1224, sub_price: 306 }
    ];

    const result = await billingApi.updateCustomerPrices(testDcId, testPrices);
    await db.query(
      'INSERT INTO audit_logs (event_type, customer_dc_id, details, status, created_at) VALUES (?, ?, ?, ?, ?)',
      ['SANDBOX_UPDATE_PRICES', testDcId, JSON.stringify(result), 'SUCCESS', new Date().toISOString()]
    );
    res.json({ success: true, result });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, data: err.data });
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

  const chunkSize = 6;
  let activeCount = 0;
  let excludedCount = 0;

  for (let i = 0; i < customers.length; i += chunkSize) {
    const chunk = customers.slice(i, i + chunkSize);
    await Promise.all(chunk.map(async c => {
      let lastInvDate = null;
      let totalInvs = 0;
      let isExcluded = 1;

      try {
        const invRes = await billingApi.getCustomerInvoices(c.dc_id);
        const invs = invRes.data || (Array.isArray(invRes) ? invRes : []);
        totalInvs = invs.length;
        if (invs.length > 0) {
          const last = invs[invs.length - 1];
          lastInvDate = last.generation_date || last.created_at || null;
          const lastTime = lastInvDate ? new Date(lastInvDate).getTime() : 0;
          if (lastTime >= twelveMonthsAgo) {
            isExcluded = 0;
          }
        }
      } catch (e) {
        isExcluded = 1;
      }

      if (isExcluded === 0) activeCount++;
      else excludedCount++;

      const updateSql = db.dbDriver === 'postgres'
        ? 'UPDATE customers SET last_invoice_date = $1, total_invoices = $2, is_inactive_excluded = $3 WHERE dc_id = $4'
        : 'UPDATE customers SET last_invoice_date = ?, total_invoices = ?, is_inactive_excluded = ? WHERE dc_id = ?';
      await db.query(updateSql, [lastInvDate, totalInvs, isExcluded, c.dc_id]);
    }));
  }

  console.log(`[InvoiceGate] Audit complete: ${activeCount} active, ${excludedCount} excluded (>12m no invoice).`);
  return { activeCount, excludedCount, total: customers.length };
}

async function ensureRatesForCustomers(customers) {
  const sampleServices = [
    { service_id: 764, name: 'DPD Next Day', courier: 'DPD', zone_id: 9527, zone_name: 'Mainland', weight_id: 17516, weight_name: '0-30kg', price: 545, sub: 100 },
    { service_id: 2777, name: 'Yodel Tracked', courier: 'YODC2C', zone_id: 20809, zone_name: 'Mainland', weight_id: 33799, weight_name: '0-15kg', price: 395, sub: 80 },
    { service_id: 769, name: 'DPD Classic', courier: 'DPD', zone_id: 9527, zone_name: 'Mainland', weight_id: 17516, weight_name: '0-30kg', price: 620, sub: 120 },
    { service_id: 886, name: 'Royal Mail Tracked 48', courier: 'RM', zone_id: 9527, zone_name: 'UK National', weight_id: 17516, weight_name: '0-2kg', price: 290, sub: 50 }
  ];

  for (const c of customers) {
    if (!c.dc_id) continue;
    for (const s of sampleServices) {
      const rSql = db.dbDriver === 'postgres'
        ? 'INSERT INTO customer_rates (customer_dc_id, courier_code, service_id, service_name, zone_id, zone_name, weight_class_id, weight_band, current_price_pence, current_sub_price_pence) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT DO NOTHING'
        : 'INSERT OR IGNORE INTO customer_rates (customer_dc_id, courier_code, service_id, service_name, zone_id, zone_name, weight_class_id, weight_band, current_price_pence, current_sub_price_pence) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
      await db.query(rSql, [c.dc_id, s.courier, s.service_id, s.name, s.zone_id, s.zone_name, s.weight_id, s.weight_name, s.price, s.sub]);
    }
  }
}

// Start Server
async function start() {
  await db.initDb();
  scheduler.init();

  try {
    const custs = await db.query('SELECT * FROM customers');
    if (custs.length > 0) {
      // Check if invoice audit is needed
      const needsAudit = custs.some(c => c.is_inactive_excluded === undefined || c.is_inactive_excluded === null);
      if (needsAudit) {
        auditCustomerInvoices(custs).then(res => {
          console.log(`[InvoiceGate] Background audit complete: ${res.activeCount} active, ${res.excludedCount} excluded.`);
        }).catch(err => {
          console.warn('[InvoiceGate] Background audit error:', err.message);
        });
      }

      const activeCusts = custs.filter(c => c.is_inactive_excluded !== 1);
      await ensureRatesForCustomers(activeCusts.length > 0 ? activeCusts : custs);
      console.log(`[RateShift] Rate cards verified/seeded across ${custs.length} customers.`);
    }
  } catch (e) {
    console.warn('[RateShift] Initial rate verification warning:', e.message);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[RateShift] Server running on http://0.0.0.0:${PORT}`);
  });
}

start().catch(err => {
  console.error('[Fatal] Server failed to start:', err);
  process.exit(1);
});
