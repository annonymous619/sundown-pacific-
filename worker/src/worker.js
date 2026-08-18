const PRODUCTS = Object.freeze({
  'sunset-boulevard': 'Sunset Boulevard',
  'stay-low': 'Stay Low',
  'born-in-california': 'Born in California',
  'keep-it-coastal': 'Keep It Coastal',
  'west-coast-raised': 'West Coast Raised'
});

const SIZES = new Set(['S', 'M', 'L', 'XL', 'XXL', '3XL']);
const REQUIRED_SECRETS = [
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'EASYPOST_API_KEY',
  'CHECKOUT_SIGNING_SECRET',
  'TURNSTILE_SECRET_KEY',
  'SHIP_FROM_JSON',
  'PACKAGE_PROFILE_JSON'
];
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function productPriceCents(size) {
  if (!SIZES.has(size)) throw new CheckoutError('Please select a valid size.');
  return size === 'XXL' || size === '3XL' ? 3000 : 2700;
}

export function packageForOrder(profile, size, quantity) {
  const shirtWeight = Number(profile.weightsOz?.[size]);
  const packagingWeight = Number(profile.packagingWeightOz);
  const length = Number(profile.lengthIn);
  const width = Number(profile.widthIn);
  const baseHeight = Number(profile.baseHeightIn);
  const heightPerShirt = Number(profile.heightPerShirtIn);
  const values = [shirtWeight, packagingWeight, length, width, baseHeight, heightPerShirt];
  if (values.some(value => !Number.isFinite(value) || value <= 0)) {
    throw new Error('PACKAGE_PROFILE_JSON contains missing or invalid measurements.');
  }
  return {
    weight: roundUpHundredth(shirtWeight * quantity + packagingWeight),
    length,
    width,
    height: roundUpHundredth(baseHeight + heightPerShirt * quantity)
  };
}

export function normalizeOrder(input) {
  if (!input || typeof input !== 'object') throw new CheckoutError('Please complete the order form.');
  const productId = clean(input.productId, 50);
  const size = clean(input.size, 4).toUpperCase();
  const quantity = Number(input.quantity);
  if (!PRODUCTS[productId]) throw new CheckoutError('Please select a valid shirt.');
  if (!SIZES.has(size)) throw new CheckoutError('Please select a valid size.');
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 5) {
    throw new CheckoutError('Quantity must be between 1 and 5.');
  }

  const customer = input.customer || {};
  const address = customer.address || {};
  const normalized = {
    productId,
    productName: PRODUCTS[productId],
    size,
    quantity,
    unitPriceCents: productPriceCents(size),
    customer: {
      name: cleanRequired(customer.name, 80, 'Please enter your full name.'),
      email: cleanRequired(customer.email, 120, 'Please enter your email address.').toLowerCase(),
      address: {
        street1: cleanRequired(address.street1, 100, 'Please enter your street address.'),
        street2: clean(address.street2, 100),
        city: cleanRequired(address.city, 60, 'Please enter your city.'),
        state: cleanRequired(address.state, 2, 'Please enter a two-letter state.').toUpperCase(),
        zip: cleanRequired(address.zip, 10, 'Please enter your ZIP code.'),
        country: 'US'
      }
    }
  };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized.customer.email)) {
    throw new CheckoutError('Please enter a valid email address.');
  }
  if (!/^[A-Z]{2}$/.test(normalized.customer.address.state)) {
    throw new CheckoutError('Please enter a two-letter state abbreviation.');
  }
  if (!/^\d{5}(-\d{4})?$/.test(normalized.customer.address.zip)) {
    throw new CheckoutError('Please enter a valid U.S. ZIP code.');
  }
  return normalized;
}

export function createApp({ fetchImpl = fetch, now = () => Date.now() } = {}) {
  return {
    async fetch(request, env) {
      const url = new URL(request.url);
      if (request.method === 'OPTIONS') return corsResponse(request, env, new Response(null, { status: 204 }));

      try {
        if (url.pathname === '/api/health' && request.method === 'GET') {
          const ready = REQUIRED_SECRETS.every(name => Boolean(env[name]));
          return corsResponse(request, env, json({ ok: true, ready }, ready ? 200 : 503));
        }
        if (url.pathname === '/api/quote' && request.method === 'POST') {
          assertAllowedOrigin(request, env);
          assertConfigured(env);
          return corsResponse(request, env, await createQuote(request, env, fetchImpl, now));
        }
        if (url.pathname === '/api/checkout' && request.method === 'POST') {
          assertAllowedOrigin(request, env);
          assertConfigured(env);
          return corsResponse(request, env, await createCheckout(request, env, fetchImpl, now));
        }
        if (url.pathname === '/api/stripe-webhook' && request.method === 'POST') {
          assertConfigured(env);
          return await handleStripeWebhook(request, env, fetchImpl, now);
        }
        return json({ error: 'Not found.' }, 404);
      } catch (error) {
        const status = error instanceof CheckoutError ? error.status : 500;
        const message = error instanceof CheckoutError ? error.message : 'Checkout is temporarily unavailable.';
        return corsResponse(request, env, json({ error: message }, status));
      }
    }
  };
}

async function createQuote(request, env, fetchImpl, now) {
  const input = await readJson(request);
  await verifyTurnstile(input.turnstileToken, request, env, fetchImpl);
  const order = normalizeOrder(input);
  const shipFrom = parseJsonSecret(env.SHIP_FROM_JSON, 'SHIP_FROM_JSON');
  const packageProfile = parseJsonSecret(env.PACKAGE_PROFILE_JSON, 'PACKAGE_PROFILE_JSON');
  const parcel = packageForOrder(packageProfile, order.size, order.quantity);
  const shipment = await easyPostRequest('/shipments', {
    method: 'POST',
    body: {
      shipment: {
        from_address: shipFrom,
        to_address: {
          name: order.customer.name,
          email: order.customer.email,
          ...order.customer.address
        },
        parcel
      }
    }
  }, env, fetchImpl);

  const rates = selectRates(shipment.rates || []);
  if (!rates.length) throw new CheckoutError('No shipping services were found for that address.', 422);
  const expiresAt = now() + 15 * 60 * 1000;
  const publicRates = await Promise.all(rates.map(async rate => {
    const amountCents = dollarsToCents(rate.rate);
    const token = await signToken({
      shipmentId: shipment.id,
      rateId: rate.id,
      rateCents: amountCents,
      carrier: rate.carrier,
      service: rate.service,
      deliveryDays: numberOrNull(rate.delivery_days ?? rate.est_delivery_days),
      productId: order.productId,
      size: order.size,
      quantity: order.quantity,
      email: order.customer.email,
      exp: expiresAt
    }, env.CHECKOUT_SIGNING_SECRET);
    return {
      token,
      carrier: rate.carrier,
      service: rate.service,
      serviceLabel: serviceLabel(rate.service),
      amountCents,
      deliveryDays: numberOrNull(rate.delivery_days ?? rate.est_delivery_days)
    };
  }));

  return json({
    subtotalCents: order.unitPriceCents * order.quantity,
    rates: publicRates
  });
}

async function createCheckout(request, env, fetchImpl, now) {
  const input = await readJson(request);
  const quote = await verifyToken(cleanRequired(input.quoteToken, 5000, 'Please select a shipping option.'), env.CHECKOUT_SIGNING_SECRET);
  if (quote.exp < now()) throw new CheckoutError('That shipping quote expired. Please request a new one.', 410);
  const productName = PRODUCTS[quote.productId];
  if (!productName || !SIZES.has(quote.size) || !Number.isInteger(quote.quantity)) {
    throw new CheckoutError('That shipping quote is invalid.', 400);
  }

  const shipment = await easyPostRequest(`/shipments/${encodeURIComponent(quote.shipmentId)}`, { method: 'GET' }, env, fetchImpl);
  const selectedRate = (shipment.rates || []).find(rate => rate.id === quote.rateId);
  if (!selectedRate || dollarsToCents(selectedRate.rate) !== quote.rateCents) {
    throw new CheckoutError('That shipping price is no longer available. Please request a new quote.', 409);
  }

  const siteUrl = String(env.PUBLIC_SITE_URL || 'https://sundownpacific.com').replace(/\/$/, '');
  const form = new URLSearchParams();
  form.set('mode', 'payment');
  form.set('success_url', `${siteUrl}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`);
  form.set('cancel_url', `${siteUrl}/?checkout=cancelled#apparel`);
  form.set('customer_email', quote.email);
  form.set('client_reference_id', quote.shipmentId);
  form.set('allow_promotion_codes', 'true');
  form.set('line_items[0][price_data][currency]', 'usd');
  form.set('line_items[0][price_data][unit_amount]', String(productPriceCents(quote.size)));
  form.set('line_items[0][price_data][product_data][name]', productName);
  form.set('line_items[0][price_data][product_data][description]', `Size ${quote.size}`);
  form.set('line_items[0][quantity]', String(quote.quantity));
  form.set('shipping_options[0][shipping_rate_data][type]', 'fixed_amount');
  form.set('shipping_options[0][shipping_rate_data][fixed_amount][amount]', String(quote.rateCents));
  form.set('shipping_options[0][shipping_rate_data][fixed_amount][currency]', 'usd');
  form.set('shipping_options[0][shipping_rate_data][display_name]', `${quote.carrier} ${serviceLabel(quote.service)}`);
  for (const [key, value] of Object.entries({
    shipment_id: quote.shipmentId,
    easypost_rate_id: quote.rateId,
    product_id: quote.productId,
    size: quote.size,
    quantity: String(quote.quantity)
  })) {
    form.set(`metadata[${key}]`, value);
    form.set(`payment_intent_data[metadata][${key}]`, value);
  }

  const session = await stripeRequest('/checkout/sessions', {
    method: 'POST',
    body: form
  }, env, fetchImpl);
  return json({ checkoutUrl: session.url });
}

async function handleStripeWebhook(request, env, fetchImpl, now) {
  const signature = request.headers.get('stripe-signature');
  const payload = await request.text();
  if (!signature || !await verifyStripeSignature(payload, signature, env.STRIPE_WEBHOOK_SECRET, now())) {
    return json({ error: 'Invalid webhook signature.' }, 400);
  }
  const event = JSON.parse(payload);
  if (event.type !== 'checkout.session.completed') return json({ received: true });
  const session = event.data?.object;
  if (session?.payment_status !== 'paid') return json({ received: true });
  const shipmentId = session.metadata?.shipment_id;
  const rateId = session.metadata?.easypost_rate_id;
  if (!shipmentId || !rateId) return json({ error: 'Missing fulfillment metadata.' }, 400);

  const shipment = await easyPostRequest(`/shipments/${encodeURIComponent(shipmentId)}`, { method: 'GET' }, env, fetchImpl);
  if (!shipment.postage_label) {
    await easyPostRequest(`/shipments/${encodeURIComponent(shipmentId)}/buy`, {
      method: 'POST',
      body: { rate: { id: rateId } }
    }, env, fetchImpl);
  }
  return json({ received: true });
}

async function verifyTurnstile(token, request, env, fetchImpl) {
  if (!token) throw new CheckoutError('Please complete the security check.', 400);
  const form = new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY, response: String(token) });
  const ip = request.headers.get('CF-Connecting-IP');
  if (ip) form.set('remoteip', ip);
  const response = await fetchImpl('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    body: form
  });
  const result = await response.json();
  if (!response.ok || !result.success) throw new CheckoutError('The security check expired. Please try again.', 400);
}

async function easyPostRequest(path, options, env, fetchImpl) {
  const response = await fetchImpl(`https://api.easypost.com/v2${path}`, {
    method: options.method,
    headers: {
      Authorization: `Basic ${base64(`${env.EASYPOST_API_KEY}:`)}`,
      'Content-Type': 'application/json'
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = result.error?.message || result.error?.errors?.[0]?.message;
    throw new CheckoutError(message || 'Shipping prices are temporarily unavailable.', 422);
  }
  return result;
}

async function stripeRequest(path, options, env, fetchImpl) {
  const response = await fetchImpl(`https://api.stripe.com/v1${path}`, {
    method: options.method,
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: options.body
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new CheckoutError(result.error?.message || 'Secure checkout is temporarily unavailable.', 502);
  return result;
}

function selectRates(rates) {
  const seen = new Set();
  return rates
    .filter(rate => ['USPS', 'UPS'].includes(rate.carrier) && Number(rate.rate) > 0)
    .sort((a, b) => Number(a.rate) - Number(b.rate))
    .filter(rate => {
      const key = `${rate.carrier}:${rate.service}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 4);
}

export async function signToken(payload, secret) {
  const encoded = base64Url(encoder.encode(JSON.stringify(payload)));
  const signature = await hmac(encoded, secret);
  return `${encoded}.${base64Url(signature)}`;
}

export async function verifyToken(token, secret) {
  const [encoded, signature] = token.split('.');
  if (!encoded || !signature || token.split('.').length !== 2) throw new CheckoutError('That shipping quote is invalid.');
  const expected = base64Url(await hmac(encoded, secret));
  if (!constantTimeEqual(signature, expected)) throw new CheckoutError('That shipping quote is invalid.');
  try {
    return JSON.parse(decoder.decode(fromBase64Url(encoded)));
  } catch {
    throw new CheckoutError('That shipping quote is invalid.');
  }
}

export async function verifyStripeSignature(payload, header, secret, nowMs) {
  const parts = Object.fromEntries(header.split(',').map(item => item.split('=', 2)));
  const timestamp = Number(parts.t);
  if (!timestamp || Math.abs(nowMs / 1000 - timestamp) > 300 || !parts.v1) return false;
  const expected = bytesToHex(await hmac(`${timestamp}.${payload}`, secret));
  return constantTimeEqual(parts.v1, expected);
}

async function hmac(value, secret) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
}

function assertAllowedOrigin(request, env) {
  const origin = request.headers.get('Origin');
  const allowed = new Set(String(env.ALLOWED_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean));
  if (!origin || !allowed.has(origin)) throw new CheckoutError('Request origin is not allowed.', 403);
}

function assertConfigured(env) {
  if (!REQUIRED_SECRETS.every(name => Boolean(env[name]))) throw new CheckoutError('Checkout setup is not complete.', 503);
}

function corsResponse(request, env, response) {
  const origin = request.headers.get('Origin');
  const allowed = new Set(String(env?.ALLOWED_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean));
  if (origin && allowed.has(origin)) {
    const headers = new Headers(response.headers);
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    headers.set('Access-Control-Allow-Headers', 'Content-Type');
    headers.set('Vary', 'Origin');
    return new Response(response.body, { status: response.status, headers });
  }
  return response;
}

async function readJson(request) {
  if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) {
    throw new CheckoutError('Expected a JSON request.', 415);
  }
  try {
    return await request.json();
  } catch {
    throw new CheckoutError('The request could not be read.');
  }
}

function parseJsonSecret(value, name) {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${name} must contain valid JSON.`);
  }
}

function serviceLabel(service) {
  const labels = {
    GroundAdvantage: 'Ground Advantage',
    Priority: 'Priority Mail',
    Express: 'Priority Mail Express',
    Ground: 'Ground',
    UPSGroundSaver: 'Ground Saver',
    'UPSGroundsaverGreaterThan1lb': 'Ground Saver',
    '2ndDayAir': '2nd Day Air',
    '3DaySelect': '3 Day Select'
  };
  return labels[service] || String(service).replace(/([a-z])([A-Z])/g, '$1 $2');
}

function clean(value, max) {
  return String(value ?? '').trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max);
}

function cleanRequired(value, max, message) {
  const result = clean(value, max);
  if (!result) throw new CheckoutError(message);
  return result;
}

function roundUpHundredth(value) {
  return Math.ceil(value * 100) / 100;
}

function numberOrNull(value) {
  const result = Number(value);
  return Number.isFinite(result) && result > 0 ? result : null;
}

function dollarsToCents(value) {
  const result = Math.round(Number(value) * 100);
  if (!Number.isSafeInteger(result) || result <= 0) throw new CheckoutError('A carrier returned an invalid shipping price.', 502);
  return result;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

function base64(value) {
  return btoa(unescape(encodeURIComponent(value)));
}

function base64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

function bytesToHex(bytes) {
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function constantTimeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || left.length !== right.length) return false;
  let result = 0;
  for (let index = 0; index < left.length; index += 1) result |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return result === 0;
}

export class CheckoutError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export default createApp();
