// --------------------
// Load environment variables
// --------------------
require('dotenv').config();

// --------------------
// Import dependencies
// --------------------
const express = require('express');
const bodyParser = require('body-parser');
const Stripe = require('stripe');
const path = require('path');
const cors = require('cors');

// --------------------
// Initialize app and Stripe
// --------------------
const app = express();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// --------------------
// Config
// --------------------
const PORT = process.env.PORT || 4242;
const READER_ID = process.env.READER_ID;

// --------------------
// Middleware
// --------------------
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));
app.use(bodyParser.json());
// NOTE: If you later implement real Stripe webhook signature verification,
// the /webhook route should use raw body ONLY.
app.use('/webhook', bodyParser.raw({ type: 'application/json' }));

// --------------------
// Health Check
// --------------------
app.get('/ping', (_, res) => res.json({ message: 'pong' }));

// --------------------
// Root + POS routes
// --------------------
app.get('/', (_, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
);

app.get('/pos', (_, res) =>
  res.sendFile(path.join(__dirname, 'public', 'pos.html'))
);

// --------------------
// Create Payment Intent (optional email receipt + metadata)
// --------------------
app.post('/create-payment-intent', async (req, res) => {
  try {
    const {
      amount,
      currency = 'usd',
      email,
      receipt_email,
      metadata = {},
    } = req.body;

    if (!amount || typeof amount !== 'number' || amount <= 0) {
      return res.status(400).json({ error: 'Missing or invalid amount' });
    }

    // Normalize optional email
    const customerEmail = (email || receipt_email || '').toString().trim() || null;

    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount),
      currency,
      payment_method_types: ['card_present'],
      capture_method: 'automatic',
      description: 'Authenticus POS Sale',

      metadata: {
        ...metadata,
        ...(customerEmail ? { customer_email: customerEmail } : {}),
      },

      // Triggers Stripe email receipt (if enabled in Stripe dashboard)
      receipt_email: customerEmail || undefined,
    });

    console.log(`✅ Created PaymentIntent: ${paymentIntent.id}`);
    res.json({ payment_intent: paymentIntent.id });
  } catch (err) {
    console.error('❌ Stripe error creating payment intent:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --------------------
// Process Payment on Reader
// --------------------
app.post('/process-on-reader', async (req, res) => {
  try {
    const { payment_intent } = req.body;

    if (!READER_ID) {
      return res.status(500).json({ error: 'Server misconfigured: missing READER_ID' });
    }
    if (!payment_intent) {
      return res.status(400).json({ error: 'Missing payment_intent' });
    }

    await stripe.terminal.readers.processPaymentIntent(READER_ID, {
      payment_intent,
    });

    // Poll until terminal completes the payment
    const poll = async () => {
      const pi = await stripe.paymentIntents.retrieve(payment_intent);

      // Common terminal outcomes:
      // - succeeded
      // - requires_payment_method (failed / canceled / retry)
      // - canceled
      if (pi.status === 'succeeded' || pi.status === 'canceled' || pi.status === 'requires_payment_method') {
        return pi;
      }

      await new Promise((r) => setTimeout(r, 1500));
      return poll();
    };

    const result = await poll();

    // Return result
    res.json({ success: result.status === 'succeeded', payment_intent: result });

    // (Optional) On-reader prompt for email/SMS contact (non-blocking)
    // NOTE: This collects contact info on the reader, but does not automatically
    // attach it to the PaymentIntent unless you add code to do so.
    try {
      if (result.status === 'succeeded') {
        await new Promise((r) => setTimeout(r, 1000));

        const inputResult = await stripe.terminal.readers.collectInputs(READER_ID, {
          type: 'customer_contact',
          fields: [
            { name: 'email', label: 'Email for receipt (optional)' },
            { name: 'phone_number', label: 'SMS for receipt (optional)' },
          ],
        });

        console.log('📨 Customer input collected on reader:', inputResult);
      }
    } catch (collectErr) {
      console.error('⚠️ Error collecting on-reader inputs:', collectErr.message);
    }
  } catch (err) {
    console.error('❌ Error processing payment on reader:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --------------------
// Cancel Payment on Reader (+ optionally cancel PaymentIntent)
// --------------------
app.post('/cancel-payment', async (req, res) => {
  try {
    if (!READER_ID) {
      return res.status(500).json({ error: 'Server misconfigured: missing READER_ID' });
    }

    const { payment_intent } = (req.body || {});

    // Cancel current action on the reader (stops collect/payment actions)
    await stripe.terminal.readers.cancelAction(READER_ID);

    // If the frontend sends a payment_intent id, cancel it too (cleaner)
    if (payment_intent) {
      try {
        await stripe.paymentIntents.cancel(payment_intent);
      } catch (piCancelErr) {
        // Not fatal; reader action already canceled
        console.error('⚠️ Could not cancel PaymentIntent:', piCancelErr.message);
      }
    }

    console.log('🚫 Payment cancelled on reader.');
    res.json({ success: true, message: 'Payment cancelled on reader' });
  } catch (err) {
    console.error('❌ Error cancelling reader action:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --------------------
// Webhook (optional placeholder)
// --------------------
app.post('/webhook', (req, res) => res.json({ received: true }));

// --------------------
// Start server
// --------------------
app.listen(PORT, () =>
  console.log(`✅ Authenticus POS server running on port ${PORT}`)
);
