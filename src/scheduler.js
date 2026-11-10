const cron = require('node-cron');
const db = require('./db');
const billingApi = require('./billingApi');

class PricingScheduler {
  constructor() {
    this.cronTask = null;
    this.isRunning = false;
    this.progress = {
      total: 0,
      current: 0,
      success: 0,
      failed: 0,
      status: 'IDLE',
      lastMessage: ''
    };
  }

  init() {
    // Check every minute if an armed campaign should run
    this.cronTask = cron.schedule('* * * * *', async () => {
      await this.checkScheduledTrigger();
    });
    console.log('[Scheduler] Cron worker running (polling every minute for scheduled execution).');
  }

  async checkScheduledTrigger() {
    if (this.isRunning) return;

    try {
      const statusSetting = await db.query("SELECT value FROM campaign_settings WHERE key = 'campaign_status'");
      const dateSetting = await db.query("SELECT value FROM campaign_settings WHERE key = 'scheduled_date'");

      const status = statusSetting[0]?.value;
      const scheduledDateStr = dateSetting[0]?.value;

      if (status === 'ARMED' && scheduledDateStr) {
        const scheduledTime = new Date(scheduledDateStr).getTime();
        const now = Date.now();

        if (now >= scheduledTime) {
          console.log(`[Scheduler] 🚀 Reached target date (${scheduledDateStr})! Executing January price increase...`);
          await this.executeCampaign('AUTOMATED_CRON');
        }
      }
    } catch (err) {
      console.error('[Scheduler] Error checking scheduled campaign:', err);
    }
  }

  async calculateCustomerRates(customerDcId = null) {
    // 1. Fetch rules
    const rules = await db.query('SELECT * FROM pricing_rules WHERE active = 1');
    const ruleMap = new Map();
    for (const r of rules) {
      ruleMap.set(r.carrier_code, Number(r.increase_percent));
    }

    // 2. Fetch cutoff date
    const cutoffRow = await db.query("SELECT value FROM campaign_settings WHERE key = 'cutoff_date'");
    const cutoffDateStr = cutoffRow[0]?.value || '2026-09-01';
    const cutoffTimestamp = new Date(cutoffDateStr).getTime();

    // 3. Fetch 12-month invoice exclusion gate setting
    const exclude12mRow = await db.query("SELECT value FROM campaign_settings WHERE key = 'exclude_no_invoice_12m'");
    const exclude12m = exclude12mRow[0]?.value !== '0'; // default true

    // 4. Fetch customers
    let sql = 'SELECT * FROM customers';
    const params = [];
    if (customerDcId) {
      sql += ' WHERE dc_id = ?';
      params.push(customerDcId);
    } else if (exclude12m) {
      sql += ' WHERE (is_inactive_excluded = 0 OR is_inactive_excluded IS NULL)';
    }
    const customers = await db.query(sql, params);

    // 5. Fetch rates
    let rateSql = 'SELECT * FROM customer_rates';
    const rateParams = [];
    if (customerDcId) {
      rateSql += ' WHERE customer_dc_id = ?';
      rateParams.push(customerDcId);
    }
    const rates = await db.query(rateSql, rateParams);

    // Group rates by customer
    const ratesByCustomer = new Map();
    for (const r of rates) {
      if (!ratesByCustomer.has(r.customer_dc_id)) {
        ratesByCustomer.set(r.customer_dc_id, []);
      }
      ratesByCustomer.get(r.customer_dc_id).push(r);
    }

    const calculatedList = [];

    for (const c of customers) {
      const isInactiveExcluded = Number(c.is_inactive_excluded) === 1;
      if (exclude12m && isInactiveExcluded && !customerDcId) {
        continue;
      }

      const joinDate = c.created_at ? new Date(c.created_at).getTime() : 0;
      const isJoinedAfterCutoff = joinDate > cutoffTimestamp;
      const isManuallyExempt = Number(c.is_exempt) === 1;

      const custRates = ratesByCustomer.get(c.dc_id) || [];

      for (const rate of custRates) {
        let appliedPct = 0;
        let exemptionReason = null;

        if (isInactiveExcluded) {
          appliedPct = 0;
          exemptionReason = 'Excluded: No invoice in last 12 months';
        } else if (isManuallyExempt) {
          appliedPct = 0;
          exemptionReason = 'Manually Exempt';
        } else if (isJoinedAfterCutoff) {
          appliedPct = 0;
          exemptionReason = `Joined after ${cutoffDateStr} (Introductory)`;
        } else if (c.custom_increase_pct !== null && c.custom_increase_pct !== undefined) {
          appliedPct = Number(c.custom_increase_pct);
          exemptionReason = 'Customer Custom Rate';
        } else {
          appliedPct = ruleMap.get(rate.courier_code) || 0;
        }

        const oldPricePence = Number(rate.current_price_pence);
        const newPricePence = Math.round(oldPricePence * (1 + appliedPct / 100));
        const diffPence = newPricePence - oldPricePence;

        const oldSubPrice = Number(rate.current_sub_price_pence || 0);
        const newSubPrice = Math.round(oldSubPrice * (1 + appliedPct / 100));

        calculatedList.push({
          customer_dc_id: c.dc_id,
          customer_name: c.name,
          service_id: rate.service_id,
          service_name: rate.service_name,
          courier_code: rate.courier_code,
          zone_id: rate.zone_id,
          zone_name: rate.zone_name,
          weight_class_id: rate.weight_class_id,
          weight_band: rate.weight_band,
          old_price: oldPricePence,
          new_price: newPricePence,
          diff_pence: diffPence,
          old_sub_price: oldSubPrice,
          new_sub_price: newSubPrice,
          applied_percent: appliedPct,
          exemption_reason: exemptionReason,
          is_exempt: appliedPct === 0
        });
      }
    }

    return calculatedList;
  }

  async executeCampaign(triggeredBy = 'MANUAL') {
    if (this.isRunning) {
      throw new Error('A price update campaign is already in progress.');
    }

    this.isRunning = true;
    this.progress.status = 'RUNNING';
    this.progress.lastMessage = `Campaign started (${triggeredBy})`;

    const upsertSql = db.dbDriver === 'postgres'
      ? 'INSERT INTO campaign_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value'
      : 'INSERT OR REPLACE INTO campaign_settings (key, value) VALUES (?, ?)';

    await db.query(upsertSql, ['campaign_status', 'RUNNING']);

    try {
      // Calculate all proposed rates
      const rates = await this.calculateCustomerRates();
      // Group by customer_dc_id
      const byCustomer = new Map();
      for (const r of rates) {
        if (!byCustomer.has(r.customer_dc_id)) {
          byCustomer.set(r.customer_dc_id, []);
        }
        byCustomer.get(r.customer_dc_id).push(r);
      }

      const customerKeys = [...byCustomer.keys()];
      this.progress.total = customerKeys.length;
      this.progress.current = 0;
      this.progress.success = 0;
      this.progress.failed = 0;

      for (let i = 0; i < customerKeys.length; i++) {
        const dcId = customerKeys[i];
        const custRates = byCustomer.get(dcId);
        this.progress.current = i + 1;

        // Skip customers where increase is 0% across all rates
        const hasIncreases = custRates.some(r => r.diff_pence > 0);
        if (!hasIncreases) {
          this.progress.success++;
          await db.query(
            'INSERT INTO audit_logs (event_type, customer_dc_id, details, status, created_at) VALUES (?, ?, ?, ?, ?)',
            ['PRICE_UPDATE_SKIPPED', dcId, '0% increase (Exempt or no change)', 'SKIPPED', new Date().toISOString()]
          );
          continue;
        }

        try {
          const payloadPrices = custRates.map(r => ({
            service_id: r.service_id,
            zone_id: r.zone_id,
            weight_class_id: r.weight_class_id,
            price: r.new_price,
            sub_price: r.new_sub_price
          }));

          await billingApi.updateCustomerPrices(dcId, payloadPrices);

          // Update local DB rates
          for (const r of custRates) {
            await db.query(
              'UPDATE customer_rates SET current_price_pence = ?, current_sub_price_pence = ? WHERE customer_dc_id = ? AND service_id = ? AND zone_id = ? AND weight_class_id = ?',
              [r.new_price, r.new_sub_price, dcId, r.service_id, r.zone_id, r.weight_class_id]
            );
          }

          this.progress.success++;
          await db.query(
            'INSERT INTO audit_logs (event_type, customer_dc_id, details, status, created_at) VALUES (?, ?, ?, ?, ?)',
            ['PRICE_UPDATE_SUCCESS', dcId, `Updated ${custRates.length} rates`, 'SUCCESS', new Date().toISOString()]
          );
        } catch (err) {
          this.progress.failed++;
          console.error(`[Scheduler] Failed updating customer ${dcId}:`, err.message);
          await db.query(
            'INSERT INTO audit_logs (event_type, customer_dc_id, details, status, created_at) VALUES (?, ?, ?, ?, ?)',
            ['PRICE_UPDATE_FAILED', dcId, `Error: ${err.message}`, 'FAILED', new Date().toISOString()]
          );
        }

        // Rate-limit safety: 200ms delay between API calls (~5 calls/sec)
        await new Promise(r => setTimeout(r, 200));
      }

      this.progress.status = 'COMPLETED';
      this.progress.lastMessage = `Completed: ${this.progress.success} succeeded, ${this.progress.failed} failed.`;
      await db.query(upsertSql, ['campaign_status', 'COMPLETED']);
    } catch (err) {
      this.progress.status = 'FAILED';
      this.progress.lastMessage = `Campaign aborted: ${err.message}`;
      await db.query(upsertSql, ['campaign_status', 'FAILED']);
    } finally {
      this.isRunning = false;
    }
  }
}

module.exports = new PricingScheduler();
