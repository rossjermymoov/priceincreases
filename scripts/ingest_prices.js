const fs = require('fs');
const readline = require('readline');
const path = require('path');

function parseCsvLine(line) {
  const result = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      inQuotes = !inQuotes;
    } else if (c === ',' && !inQuotes) {
      result.push(cur.trim());
      cur = '';
    } else {
      cur += c;
    }
  }
  result.push(cur.trim());
  return result;
}

async function ingestPrices() {
  const storePath = path.join(__dirname, '../data/store.json');
  const store = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  const customers = store.customers || [];
  const idToDcId = new Map();
  customers.forEach(c => idToDcId.set(String(c.id), c.dc_id));
  idToDcId.set('3473', 'test Jan');

  console.time('Ingestion');
  const csvPath = path.join(__dirname, '../prices.csv');
  if (!fs.existsSync(csvPath)) {
    throw new Error('prices.csv does not exist at ' + csvPath);
  }

  const fileStream = fs.createReadStream(csvPath);
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  let isHeader = true;
  const rates = [];
  let idCounter = 1;

  for await (const line of rl) {
    if (isHeader) { isHeader = false; continue; }
    if (!line.trim()) continue;

    const parts = parseCsvLine(line);
    const custId = parts[0];
    const dcId = idToDcId.get(custId);
    if (!dcId) continue;

    const pricePounds = parseFloat(parts[12]);
    const pricePence = isNaN(pricePounds) ? 0 : Math.round(pricePounds * 100);

    rates.push({
      id: idCounter++,
      customer_dc_id: dcId,
      courier_code: parts[3],
      service_id: Number(parts[5]),
      service_name: parts[7].replace(/^"|"$/g, ''),
      zone_id: Number(parts[8]),
      zone_name: parts[9].replace(/^"|"$/g, ''),
      weight_class_id: Number(parts[10]),
      weight_band: parts[11].replace(/^"|"$/g, ''),
      current_price_pence: pricePence,
      current_sub_price_pence: 0
    });
  }

  console.timeEnd('Ingestion');
  console.log(`Successfully parsed ${rates.length} real rate cards from prices.csv.`);

  // Replace customer_rates in store
  store.customer_rates = rates;
  fs.writeFileSync(storePath, JSON.stringify(store, null, 2), 'utf8');
  console.log(`Updated store.json with ${rates.length} customer rates.`);

  // Verify Bessette
  const bessetteRates = rates.filter(r => r.customer_dc_id === 'MOOV-0144');
  const bCouriers = [...new Set(bessetteRates.map(r => r.courier_code))];
  console.log(`Bessette rates count: ${bessetteRates.length}, Couriers: ${bCouriers.join(', ')}`);

  return rates.length;
}

if (require.main === module) {
  ingestPrices().then(() => {
    console.log('Ingestion completed successfully.');
    process.exit(0);
  }).catch(err => {
    console.error('Ingestion failed:', err);
    process.exit(1);
  });
}

module.exports = { ingestPrices };
