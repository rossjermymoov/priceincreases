const fs = require('fs');
const path = require('path');
const billing = require('../src/billingApi');
const db = require('../src/db');

async function syncAllCustomerPrices() {
  await db.initDb();
  console.log('[LiveRateSync] Initializing live rate sync from Billing API...');

  const couriers = await db.query('SELECT * FROM couriers');
  const services = await db.query('SELECT * FROM courier_services');

  const courierMap = new Map();
  couriers.forEach(c => courierMap.set(c.id, c.code));

  const serviceToCourier = new Map();
  services.forEach(s => serviceToCourier.set(s.id, courierMap.get(s.courier_id) || 'UNKNOWN'));

  const activeCusts = await db.query('SELECT * FROM customers WHERE is_inactive_excluded = 0 OR is_inactive_excluded IS NULL');
  console.log(`[LiveRateSync] Fetching live rates for ${activeCusts.length} active customers...`);

  const allRates = [];
  let idCounter = 1;
  let successCount = 0;
  let failCount = 0;
  let subPriceCount = 0;

  for (const c of activeCusts) {
    if (!c.dc_id || c.dc_id === 'MOOV-TEST-001') continue;
    try {
      const res = await billing.getCustomerPrices(c.dc_id);
      const list = res.prices || [];
      for (const p of list) {
        const courierCode = serviceToCourier.get(p.service_id) || 'OTHER';
        const hasSub = p.sub_price !== null && p.sub_price !== undefined;
        if (hasSub && Number(p.sub_price) > 0) subPriceCount++;

        allRates.push({
          id: idCounter++,
          customer_dc_id: c.dc_id,
          courier_code: courierCode,
          service_id: Number(p.service_id),
          service_name: p.service_name || '',
          zone_id: Number(p.zone_id),
          zone_name: p.zone_name || '',
          weight_class_id: Number(p.weight_class_id),
          weight_band: p.weight_class_name || '',
          current_price_pence: Math.round(Number(p.price || 0)),
          current_sub_price_pence: hasSub ? Math.round(Number(p.sub_price)) : null
        });
      }
      successCount++;
    } catch (e) {
      failCount++;
      // Ignore 404 for test sandboxes
    }
  }

  console.log(`[LiveRateSync] Sync complete. ${successCount} customers succeeded, ${failCount} failed.`);
  console.log(`[LiveRateSync] Total live rates: ${allRates.length}, Rates with subsequent box prices (>0): ${subPriceCount}`);

  // Persist into store.json
  const storePath = path.join(__dirname, '../data/store.json');
  const store = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  store.customer_rates = allRates;
  fs.writeFileSync(storePath, JSON.stringify(store, null, 2), 'utf8');

  // Persist into seed.json
  const seedPath = path.join(__dirname, '../data/seed.json');
  if (fs.existsSync(seedPath)) {
    const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
    seed.customer_rates = allRates;
    fs.writeFileSync(seedPath, JSON.stringify(seed), 'utf8');
  }

  return {
    totalCustomers: successCount,
    totalRates: allRates.length,
    subPriceCount
  };
}

if (require.main === module) {
  syncAllCustomerPrices().then(res => {
    console.log('[LiveRateSync] Finished successfully:', res);
    process.exit(0);
  }).catch(err => {
    console.error('[LiveRateSync] Error:', err);
    process.exit(1);
  });
}

module.exports = { syncAllCustomerPrices };
