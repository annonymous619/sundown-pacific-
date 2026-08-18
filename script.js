const menuButton = document.querySelector('.menu-toggle');
const nav = document.querySelector('.site-nav');

if (menuButton && nav) {
  menuButton.addEventListener('click', () => {
    const open = nav.classList.toggle('open');
    menuButton.setAttribute('aria-expanded', String(open));
  });

  nav.querySelectorAll('a').forEach(link => {
    link.addEventListener('click', () => {
      nav.classList.remove('open');
      menuButton.setAttribute('aria-expanded', 'false');
    });
  });
}

const observer = new IntersectionObserver(entries => {
  entries.forEach(entry => {
    if (entry.isIntersecting) entry.target.classList.add('is-visible');
  });
}, { threshold: 0.16 });

document.querySelectorAll('.reveal').forEach(el => observer.observe(el));

const PRODUCTS = Object.freeze({
  'sunset-boulevard': { name: 'Sunset Boulevard' },
  'stay-low': { name: 'Stay Low' },
  'born-in-california': { name: 'Born in California' },
  'keep-it-coastal': { name: 'Keep It Coastal' },
  'west-coast-raised': { name: 'West Coast Raised' }
});

const checkoutConfig = window.SUNDOWN_CHECKOUT || { enabled: false, apiBaseUrl: '' };
const checkoutModal = document.querySelector('#checkout-modal');
const shippingForm = document.querySelector('#shipping-form');
const ratesForm = document.querySelector('#rates-form');
const shippingRates = document.querySelector('#shipping-rates');
const checkoutStatus = document.querySelector('#checkout-status');
const subtotalOutput = document.querySelector('#checkout-subtotal');
const totalOutput = document.querySelector('#checkout-total');
const checkoutTitle = document.querySelector('#checkout-title');
let selectedProductId = '';
let quoteResult = null;
let turnstileToken = '';
let turnstileWidgetId = null;

const money = cents => new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD'
}).format(cents / 100);

function currentUnitPrice() {
  const size = shippingForm?.elements.size.value;
  return size === 'XXL' || size === '3XL' ? 3000 : 2700;
}

function updateSubtotal() {
  if (!shippingForm || !subtotalOutput) return;
  const quantity = Number(shippingForm.elements.quantity.value);
  subtotalOutput.textContent = money(currentUnitPrice() * quantity);
}

function setCheckoutStatus(message = '', isError = false) {
  if (!checkoutStatus) return;
  checkoutStatus.textContent = message;
  checkoutStatus.classList.toggle('is-error', isError);
}

function closeCheckout() {
  if (!checkoutModal) return;
  checkoutModal.hidden = true;
  document.body.classList.remove('checkout-lock');
  setCheckoutStatus();
}

function openCheckout(productId) {
  const product = PRODUCTS[productId];
  if (!checkoutModal || !shippingForm || !product) return;
  selectedProductId = productId;
  checkoutTitle.textContent = product.name;
  shippingForm.hidden = false;
  ratesForm.hidden = true;
  quoteResult = null;
  updateSubtotal();
  setCheckoutStatus();
  checkoutModal.hidden = false;
  document.body.classList.add('checkout-lock');
  renderTurnstile();
  shippingForm.elements.size.focus();
}

function loadTurnstile() {
  return new Promise((resolve, reject) => {
    if (window.turnstile) return resolve();
    const existing = document.querySelector('script[data-sundown-turnstile]');
    if (existing) {
      existing.addEventListener('load', resolve, { once: true });
      existing.addEventListener('error', reject, { once: true });
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.async = true;
    script.defer = true;
    script.dataset.sundownTurnstile = 'true';
    script.addEventListener('load', resolve, { once: true });
    script.addEventListener('error', reject, { once: true });
    document.head.append(script);
  });
}

function renderTurnstile() {
  if (!window.turnstile || !checkoutConfig.turnstileSiteKey || turnstileWidgetId !== null) return;
  turnstileWidgetId = window.turnstile.render('#turnstile-container', {
    sitekey: checkoutConfig.turnstileSiteKey,
    theme: 'dark',
    callback: token => { turnstileToken = token; },
    'expired-callback': () => { turnstileToken = ''; },
    'error-callback': () => { turnstileToken = ''; }
  });
}

function resetTurnstile() {
  turnstileToken = '';
  if (window.turnstile && turnstileWidgetId !== null) window.turnstile.reset(turnstileWidgetId);
}

async function apiRequest(path, body) {
  const baseUrl = checkoutConfig.apiBaseUrl.replace(/\/$/, '');
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Checkout is temporarily unavailable.');
  return data;
}

function renderRates(result) {
  shippingRates.replaceChildren();
  result.rates.forEach((rate, index) => {
    const label = document.createElement('label');
    label.className = 'shipping-rate';
    const estimate = rate.deliveryDays
      ? `${rate.deliveryDays} estimated business day${rate.deliveryDays === 1 ? '' : 's'}`
      : 'Delivery estimate shown by carrier';
    label.innerHTML = `
      <input type="radio" name="quoteToken" value="${rate.token}" data-rate-cents="${rate.amountCents}" ${index === 0 ? 'checked' : ''}>
      <span class="shipping-rate-copy"><strong>${rate.carrier} ${rate.serviceLabel}</strong><small>${estimate}</small></span>
      <span class="shipping-rate-price">${money(rate.amountCents)}</span>
    `;
    shippingRates.append(label);
  });
  updateTotal();
}

function updateTotal() {
  const selected = ratesForm?.querySelector('input[name="quoteToken"]:checked');
  if (!selected || !quoteResult) return;
  totalOutput.textContent = money(quoteResult.subtotalCents + Number(selected.dataset.rateCents));
}

shippingForm?.elements.size.addEventListener('change', updateSubtotal);
shippingForm?.elements.quantity.addEventListener('change', updateSubtotal);
ratesForm?.addEventListener('change', updateTotal);

shippingForm?.addEventListener('submit', async event => {
  event.preventDefault();
  if (!turnstileToken) {
    setCheckoutStatus('Please complete the quick security check first.', true);
    return;
  }
  const button = shippingForm.querySelector('button[type="submit"]');
  const fields = Object.fromEntries(new FormData(shippingForm));
  button.disabled = true;
  setCheckoutStatus('Finding the best available shipping prices…');
  try {
    quoteResult = await apiRequest('/api/quote', {
      productId: selectedProductId,
      size: fields.size,
      quantity: Number(fields.quantity),
      customer: {
        name: fields.name,
        email: fields.email,
        address: {
          street1: fields.street1,
          street2: fields.street2,
          city: fields.city,
          state: fields.state,
          zip: fields.zip,
          country: 'US'
        }
      },
      turnstileToken
    });
    resetTurnstile();
    renderRates(quoteResult);
    shippingForm.hidden = true;
    ratesForm.hidden = false;
    setCheckoutStatus();
  } catch (error) {
    resetTurnstile();
    setCheckoutStatus(error.message, true);
  } finally {
    button.disabled = false;
  }
});

ratesForm?.addEventListener('submit', async event => {
  event.preventDefault();
  const button = ratesForm.querySelector('button[type="submit"]');
  const selected = ratesForm.querySelector('input[name="quoteToken"]:checked');
  if (!selected) return;
  button.disabled = true;
  setCheckoutStatus('Opening secure Stripe checkout…');
  try {
    const result = await apiRequest('/api/checkout', { quoteToken: selected.value });
    window.location.assign(result.checkoutUrl);
  } catch (error) {
    setCheckoutStatus(error.message, true);
    button.disabled = false;
  }
});

document.querySelector('#edit-address')?.addEventListener('click', () => {
  ratesForm.hidden = true;
  shippingForm.hidden = false;
  setCheckoutStatus();
});

document.querySelectorAll('[data-checkout-close]').forEach(button => {
  button.addEventListener('click', closeCheckout);
});

document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && checkoutModal && !checkoutModal.hidden) closeCheckout();
});

async function initializeCheckout() {
  const buttons = document.querySelectorAll('[data-product-id]');
  if (!checkoutConfig.enabled || !checkoutConfig.apiBaseUrl || !checkoutConfig.turnstileSiteKey) return;
  try {
    await loadTurnstile();
    const baseUrl = checkoutConfig.apiBaseUrl.replace(/\/$/, '');
    const response = await fetch(`${baseUrl}/api/health`, { headers: { Accept: 'application/json' } });
    const health = await response.json();
    if (!response.ok || !health.ready) throw new Error('Not ready');
    buttons.forEach(button => {
      button.disabled = false;
      button.textContent = 'Choose size & shipping';
      button.addEventListener('click', () => openCheckout(button.dataset.productId));
    });
  } catch {
    buttons.forEach(button => {
      button.disabled = true;
      button.textContent = 'Checkout temporarily unavailable';
    });
  }
}

initializeCheckout();
