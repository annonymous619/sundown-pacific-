import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createApp,
  normalizeOrder,
  packageForOrder,
  productPriceCents,
  signToken,
  verifyToken,
  verifyStripeSignature
} from '../src/worker.js';

const env = {
  STRIPE_SECRET_KEY: 'sk_test_example',
  STRIPE_WEBHOOK_SECRET: 'whsec_example',
  EASYPOST_API_KEY: 'EZTKexample',
  CHECKOUT_SIGNING_SECRET: 'a-long-random-checkout-signing-secret',
  TURNSTILE_SECRET_KEY: 'turnstile-secret',
  SHIP_FROM_JSON: JSON.stringify({
    name: 'Sundown Pacific',
    street1: '1 Main St',
    city: 'Hemet',
    state: 'CA',
    zip: '92545',
    country: 'US',
    phone: '9515550100'
  }),
  PACKAGE_PROFILE_JSON: JSON.stringify({
    weightsOz: { S: 6, M: 6.5, L: 7, XL: 7.5, XXL: 8, '3XL': 9 },
    packagingWeightOz: 1.5,
    lengthIn: 12,
    widthIn: 10,
    baseHeightIn: 0.25,
    heightPerShirtIn: 0.75
  }),
  PUBLIC_SITE_URL: 'https://sundownpacific.com',
  ALLOWED_ORIGINS: 'https://sundownpacific.com,https://www.sundownpacific.com'
};

const validOrder = {
  productId: 'west-coast-raised',
  size: 'XXL',
  quantity: 2,
  customer: {
    name: 'Customer Name',
    email: 'customer@example.com',
    address: {
      street1: '100 Market St',
      street2: '',
      city: 'San Diego',
      state: 'ca',
      zip: '92101'
    }
  }
};

test('server-owned catalog pricing enforces the size surcharge', () => {
  assert.equal(productPriceCents('XL'), 2700);
  assert.equal(productPriceCents('XXL'), 3000);
  assert.equal(productPriceCents('3XL'), 3000);
});

test('order input is normalized and constrained', () => {
  const order = normalizeOrder(validOrder);
  assert.equal(order.productName, 'West Coast Raised');
  assert.equal(order.customer.address.state, 'CA');
  assert.equal(order.unitPriceCents, 3000);
  assert.throws(() => normalizeOrder({ ...validOrder, quantity: 25 }), /between 1 and 5/);
  assert.throws(() => normalizeOrder({ ...validOrder, productId: 'fake-shirt' }), /valid shirt/);
});

test('package calculation uses measured size weight and packaging', () => {
  const profile = JSON.parse(env.PACKAGE_PROFILE_JSON);
  assert.deepEqual(packageForOrder(profile, '3XL', 2), {
    weight: 19.5,
    length: 12,
    width: 10,
    height: 1.75
  });
});

test('signed quote tokens reject modifications', async () => {
  const token = await signToken({ shipmentId: 'shp_123', exp: 1234 }, env.CHECKOUT_SIGNING_SECRET);
  assert.deepEqual(await verifyToken(token, env.CHECKOUT_SIGNING_SECRET), { shipmentId: 'shp_123', exp: 1234 });
  await assert.rejects(() => verifyToken(`${token.slice(0, -1)}x`, env.CHECKOUT_SIGNING_SECRET), /invalid/);
});

test('quote endpoint validates Turnstile and returns signed discounted rates', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.includes('turnstile')) return Response.json({ success: true });
    if (url.endsWith('/shipments')) {
      return Response.json({
        id: 'shp_quote',
        rates: [
          { id: 'rate_priority', carrier: 'USPS', service: 'Priority', rate: '9.25', delivery_days: 2 },
          { id: 'rate_ground', carrier: 'USPS', service: 'GroundAdvantage', rate: '5.21', delivery_days: 4 },
          { id: 'rate_other', carrier: 'FedEx', service: 'Ground', rate: '4.00', delivery_days: 5 }
        ]
      });
    }
    throw new Error(`Unexpected URL ${url}`);
  };
  const app = createApp({ fetchImpl, now: () => 1_000_000 });
  const request = new Request('https://worker.example/api/quote', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://sundownpacific.com' },
    body: JSON.stringify({ ...validOrder, turnstileToken: 'verified-token' })
  });
  const response = await app.fetch(request, env);
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'https://sundownpacific.com');
  assert.equal(result.subtotalCents, 6000);
  assert.deepEqual(result.rates.map(rate => rate.amountCents), [521, 925]);
  assert.equal(calls.length, 2);
  const shipmentBody = JSON.parse(calls[1].options.body);
  assert.equal(shipmentBody.shipment.parcel.weight, 17.5);
});

test('checkout endpoint revalidates the carrier rate and creates a Stripe session', async () => {
  const quoteToken = await signToken({
    shipmentId: 'shp_quote',
    rateId: 'rate_ground',
    rateCents: 521,
    carrier: 'USPS',
    service: 'GroundAdvantage',
    deliveryDays: 4,
    productId: 'west-coast-raised',
    size: 'XXL',
    quantity: 2,
    email: 'customer@example.com',
    exp: 2_000_000
  }, env.CHECKOUT_SIGNING_SECRET);
  let stripeBody;
  const fetchImpl = async (url, options) => {
    if (url.includes('/shipments/shp_quote')) {
      return Response.json({ rates: [{ id: 'rate_ground', rate: '5.21' }] });
    }
    if (url.includes('api.stripe.com')) {
      stripeBody = options.body;
      return Response.json({ url: 'https://checkout.stripe.com/c/pay/test' });
    }
    throw new Error(`Unexpected URL ${url}`);
  };
  const app = createApp({ fetchImpl, now: () => 1_000_000 });
  const response = await app.fetch(new Request('https://worker.example/api/checkout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://sundownpacific.com' },
    body: JSON.stringify({ quoteToken })
  }), env);
  const result = await response.json();
  assert.equal(result.checkoutUrl, 'https://checkout.stripe.com/c/pay/test');
  assert.equal(stripeBody.get('line_items[0][price_data][unit_amount]'), '3000');
  assert.equal(stripeBody.get('shipping_options[0][shipping_rate_data][fixed_amount][amount]'), '521');
  assert.equal(stripeBody.get('allow_promotion_codes'), 'true');
});

test('Stripe webhook signature uses a five-minute tolerance', async () => {
  const timestamp = 1_700_000_000;
  const payload = JSON.stringify({ type: 'checkout.session.completed' });
  const token = await signToken({}, 'unused');
  assert.ok(token);
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env.STRIPE_WEBHOOK_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signatureBytes = new Uint8Array(await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${timestamp}.${payload}`)
  ));
  const signature = [...signatureBytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
  assert.equal(await verifyStripeSignature(payload, `t=${timestamp},v1=${signature}`, env.STRIPE_WEBHOOK_SECRET, timestamp * 1000), true);
  assert.equal(await verifyStripeSignature(payload, `t=${timestamp},v1=${signature}`, env.STRIPE_WEBHOOK_SECRET, (timestamp + 301) * 1000), false);
});

test('a verified paid checkout automatically purchases the selected label once', async () => {
  const timestamp = 1_700_000_000;
  const event = {
    type: 'checkout.session.completed',
    data: {
      object: {
        payment_status: 'paid',
        metadata: { shipment_id: 'shp_paid', easypost_rate_id: 'rate_paid' }
      }
    }
  };
  const payload = JSON.stringify(event);
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env.STRIPE_WEBHOOK_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signatureBytes = new Uint8Array(await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${timestamp}.${payload}`)
  ));
  const signature = [...signatureBytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/shipments/shp_paid')) return Response.json({ id: 'shp_paid', postage_label: null });
    if (url.endsWith('/shipments/shp_paid/buy')) return Response.json({ id: 'shp_paid', postage_label: { label_url: 'https://example.test/label.png' } });
    throw new Error(`Unexpected URL ${url}`);
  };
  const app = createApp({ fetchImpl, now: () => timestamp * 1000 });
  const response = await app.fetch(new Request('https://worker.example/api/stripe-webhook', {
    method: 'POST',
    headers: { 'stripe-signature': `t=${timestamp},v1=${signature}` },
    body: payload
  }), env);
  assert.equal(response.status, 200);
  assert.deepEqual(calls.map(call => call.url.split('/').at(-1)), ['shp_paid', 'buy']);
  assert.deepEqual(JSON.parse(calls[1].options.body), { rate: { id: 'rate_paid' } });
});

test('untrusted origins cannot spend shipping-rate API calls', async () => {
  const app = createApp({ fetchImpl: async () => { throw new Error('should not fetch'); } });
  const response = await app.fetch(new Request('https://worker.example/api/quote', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://attacker.example' },
    body: JSON.stringify({ ...validOrder, turnstileToken: 'token' })
  }), env);
  assert.equal(response.status, 403);
});
