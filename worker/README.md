# Sundown Pacific checkout service

This Cloudflare Worker keeps Stripe and EasyPost credentials off the public GitHub Pages site. It calculates live rates, creates Stripe Checkout sessions, and purchases the selected EasyPost label only after Stripe confirms payment.

## Required encrypted secrets

- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `EASYPOST_API_KEY`
- `CHECKOUT_SIGNING_SECRET` (a long random value)
- `TURNSTILE_SECRET_KEY`
- `SHIP_FROM_JSON`
- `PACKAGE_PROFILE_JSON`

Example shapes for the two JSON secrets:

```json
{"name":"Sundown Pacific","street1":"SHIP FROM ADDRESS","city":"CITY","state":"CA","zip":"00000","country":"US","phone":"0000000000"}
```

```json
{"weightsOz":{"S":0,"M":0,"L":0,"XL":0,"XXL":0,"3XL":0},"packagingWeightOz":0,"lengthIn":0,"widthIn":0,"baseHeightIn":0,"heightPerShirtIn":0}
```

Replace every zero with measurements from a finished shirt packed in its real mailer. Incorrect measurements can cause carrier adjustments.

## Activation checklist

1. Add all secrets with Cloudflare Workers secret storage. Never place them in this repository.
2. Deploy the Worker and register `/api/stripe-webhook` as a Stripe webhook for `checkout.session.completed`.
3. Create a Cloudflare Turnstile widget for `sundownpacific.com` and save its secret in the Worker.
4. Put the deployed Worker URL and public Turnstile site key in `checkout-config.js`, then change `enabled` to `true`.
5. Complete a Stripe test-mode order and confirm a test EasyPost label is created before using live keys.

Stripe promotion-code entry is enabled. The storefront stores no customer database; shipping information is sent to EasyPost to quote and create the label.
