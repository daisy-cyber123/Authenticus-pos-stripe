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
// Create Payment Intent  (with OPTIONAL email receipt)
// --------------------
app.post('/create-payment-intent', async (req, res) => {
  try {
    // email can come in as "email" from your UI.
    // (We also accept "receipt_email" just in case.)
    const {
      amount,
      currency = 'usd',
      email,
      receipt_email,
      metadata = {},
    } = req.body;

    if (!amount) {
      return res.status(400).json({ error: 'Missing amount' });
    }

    // Normalize optional email
    const customerEmail = email || receipt_email || null;

    const paymentIntent = await stripe.paymentIntents.create({
      amount,
      currency,
      payment_method_types: ['card_present'],
      capture_method: 'automatic',
      description: 'Authenticus POS Sale',

      // Merge any metadata you send, and store the customer email too
      metadata: {
        ...metadata,
        ...(customerEmail ? { customer_email: customerEmail } : {}),
      },

      // This is what actually triggers Stripe’s email receipt (if enabled)
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
    if (!payment_intent) {
      return res.status(400).json({ error: 'Missing payment_intent' });
    }

    await stripe.terminal.readers.processPaymentIntent(READER_ID, {
      payment_intent,
    });

    // Poll until succeeded
    const poll = async () => {
      const pi = await stripe.paymentIntents.retrieve(payment_intent);
      if (pi.status === 'succeeded') return pi;
      await new Promise((r) => setTimeout(r, 1500));
      return poll();
    };

    const result = await poll();

    res.json({ success: true, payment_intent: result });

    // (Optional) On-reader prompt for email/SMS contact
    try {
      if (result.status === 'succeeded') {
        await new Promise((r) => setTimeout(r, 1000));

        const inputResult = await stripe.terminal.readers.collectInputs(
          READER_ID,
          {
            type: 'customer_contact',
            fields: [
              { name: 'email', label: 'Email for receipt (optional)' },
              { name: 'phone_number', label: 'SMS for receipt (optional)' },
            ],
          }
        );
        console.log('📨 Customer input collected on reader:', inputResult);
      }
    } catch (collectErr) {
      console.error(
        '⚠️ Error collecting on-reader inputs:',
        collectErr.message
      );
    }
  } catch (err) {
    console.error('❌ Error processing payment on reader:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --------------------
// Cancel Payment on Reader
// --------------------
app.post('/cancel-payment', async (req, res) => {
  try {
    await stripe.terminal.readers.cancelAction(READER_ID);
    console.log('🚫 Payment cancelled on reader.');
    res.json({ success: true, message: 'Payment cancelled on reader' });
  } catch (err) {
    console.error('❌ Error cancelling reader action:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --------------------
// Webhook (optional)
// --------------------
app.post('/webhook', (req, res) => res.json({ received: true }));

// --------------------
// Start server
// --------------------
app.listen(PORT, () =>
  console.log(`✅ Authenticus POS server running on port ${PORT}`)
);
