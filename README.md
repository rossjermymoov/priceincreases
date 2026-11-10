# RateShift — January Pricing & Courier Increase Manager

Production deployment & automated scheduler for Despatch Cloud Billing API customer rate card adjustments.

---

## 🚀 Features

- **Billing API Synchronizer**: Directly fetches active customers, couriers (DPD, Yodel, Royal Mail, EvRi, DHL, UPS, etc.), services, zones, and weight bands.
- **Rules Engine**:
  - Percentage adjustments per courier (e.g. DPD +3.9%, Yodel +2.0%, Royal Mail +3.5%).
  - Customer joining cutoff date (e.g. customers who joined after Sept 1, 2026 receive 0% introductory rate protection).
  - Individual customer exemptions and bespoke contract overrides.
- **Side-by-Side Diff Inspector**: Calculates exact old price vs new price, pence difference, and projected impact across all rate lines.
- **Safe Sandbox Verification**: 1-click test to create `TEST-JAN-2027` customer and verify price updates on `POST /api/prices/update-customer-prices`.
- **Dual Execution Triggers**:
  - **Automated January 1st Scheduler**: Built-in cron worker targeting `2027-01-01 00:01:00 UTC`.
  - **Manual Immediate Run**: On-demand batch execution with rate-limiting (5 requests/sec) and real-time progress bar.
- **Audit Logging & CSV Export**: Complete historical trail of every rate update sent to the Billing API.

---

## 🛠️ Tech Stack & Database Compatibility

- **Runtime**: Node.js 24 + Express
- **Database**:
  - **Production (Railway)**: PostgreSQL via `DATABASE_URL` (auto-provisioned by Railway)
  - **Local Development**: Zero-config SQLite (`data/rateshift.db`)
- **Scheduler**: Node-cron worker

---

## 🚂 Railway Deployment (Quick Guide)

1. **Deploy to Railway**:
   - Create a new project on Railway.
   - Select **Deploy from GitHub repo** and choose `rossjermymoov/priceincreases`.
2. **Add PostgreSQL Service**:
   - In the Railway project canvas, click **+ New** $\rightarrow$ **Database** $\rightarrow$ **Add PostgreSQL**.
   - Railway will automatically inject the `DATABASE_URL` environment variable into your application service.
3. **Set Environment Variables**:
   In Railway $\rightarrow$ Settings $\rightarrow$ Variables:
   - `BILLING_API_TOKEN` = `iiMcRFucDESz3pxU`
   - `BILLING_API_BASE` = `https://production.billingapi.co.uk`
   - `PORT` = `3000`
4. **Access GUI**:
   - Open your generated Railway domain (e.g. `https://priceincreases-production.up.railway.app`).
   - Click **Sync From Billing API** to ingest live customers.
   - Run the Sandbox test in Tab 3 to verify live connectivity.
   - Arm the campaign for January 1st!

---

## 💻 Local Quickstart

```bash
git clone https://github.com/rossjermymoov/priceincreases.git
cd priceincreases
npm install
npm start
```
Then open [http://localhost:3000](http://localhost:3000) in your browser.
