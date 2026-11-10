/**
 * Despatch Cloud Billing API Client
 */
const DEFAULT_BASE_URL = 'https://production.billingapi.co.uk';
const DEFAULT_TOKEN = process.env.BILLING_API_TOKEN || 'iiMcRFucDESz3pxU';

class BillingApiClient {
  constructor(baseUrl = DEFAULT_BASE_URL, token = DEFAULT_TOKEN) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.token = token;
  }

  async request(path, options = {}) {
    const url = `${this.baseUrl}${path.startsWith('/') ? path : '/' + path}`;
    const headers = {
      'Authorization': `Bearer ${this.token}`,
      'Accept': 'application/json',
      'User-Agent': 'RateShift-Railway/1.0',
      ...(options.headers || {})
    };

    if (options.body && typeof options.body === 'object' && !(options.body instanceof String)) {
      headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(options.body);
    }

    const res = await fetch(url, { ...options, headers });
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }

    if (!res.ok) {
      const err = new Error(`Billing API error HTTP ${res.status}: ${typeof data === 'object' ? JSON.stringify(data) : data}`);
      err.status = res.status;
      err.data = data;
      throw err;
    }

    return data;
  }

  // 1. Fetch Customers
  async getCustomers() {
    return this.request('/api/customers.json');
  }

  // 2. Fetch Couriers
  async getCouriers() {
    return this.request('/api/couriers.json');
  }

  // 3. Fetch Courier Services
  async getCourierServices() {
    return this.request('/api/courier-services.json');
  }

  // 4. Fetch Zones for a Service
  async getZones(serviceId) {
    return this.request(`/api/services/${serviceId}/zones.json`);
  }

  // 5. Fetch Weight Classes for a Service
  async getWeightClasses(serviceId) {
    return this.request(`/api/services/${serviceId}/weight-classes.json`);
  }

  // 6. Create Fake Customer for Sandbox Testing
  async createCustomer(customerData = {}) {
    const payload = {
      name: customerData.name || 'TEST Customer Jan 2027',
      dc_id: customerData.dc_id || 'TEST-JAN-2027',
      billing_period: customerData.billing_period || 'weekly',
      vat_enabled: customerData.vat_enabled !== undefined ? customerData.vat_enabled : true,
      address_line_1: customerData.address_line_1 || 'Test Unit 100',
      address_line_2: customerData.address_line_2 || 'Industrial Park',
      city: customerData.city || 'Driffield',
      county: customerData.county || 'East Yorkshire',
      country: customerData.country || 'United Kingdom',
      postcode: customerData.postcode || 'YO25 9DJ',
      email: customerData.email || 'testing@despatchcloud.com',
      telephone: customerData.telephone || '07000000000'
    };
    return this.request('/api/create-customer', {
      method: 'POST',
      body: payload
    });
  }

  // 7. Update Customer Prices (POST /api/prices/update-customer-prices)
  async updateCustomerPrices(customerDcId, prices) {
    const payload = {
      customer_dc_id: customerDcId,
      prices: prices.map(p => ({
        service_id: Number(p.service_id),
        zone_id: Number(p.zone_id),
        weight_class_id: Number(p.weight_class_id),
        price: Math.round(Number(p.price)), // pence
        sub_price: Math.round(Number(p.sub_price || 0))
      }))
    };
    return this.request('/api/prices/update-customer-prices', {
      method: 'POST',
      body: payload
    });
  }

  // 8. Update Fuel Surcharges
  async updateFuelSurcharges(customerDcId, prices) {
    return this.request('/api/prices/update-customer-fuel-surcharges', {
      method: 'POST',
      body: {
        customer_dc_id: customerDcId,
        prices
      }
    });
  }
}

module.exports = new BillingApiClient();
