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
app.use(bodyParser.json());
app.use('/webhook', bodyParser.raw({ type: 'application/json' }));

// --------------------
// Debug route (helps verify backend is responding)
// --------------------
app.get('/ping', (_, res) => {
  res.json({ message: 'pong' });
});

// --------------------
// Root route
// --------------------
app.get('/', (_, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --------------------
// POS page route
// --------------------
app.get('/pos', (_, res) => {
  res.sendFile(path.join(__dirname, 'public', 'pos.html'));
});

// --------------------
// Create Payment Intent
// --------------------
app.post('/create-payment-intent', async (req, res) => {
  try {
    const { amount, currency = 'usd', email, metadata = {} } = req.body;
    if (!amount) return res.status(400).json({ error: 'Missing amount' });

    const paymentIntent = await stripe.paymentIntents.create({
      amount,
      currency,
      payment_method_types: ['card_present'],
      capture_method: 'automatic',
      metadata,
      description: 'Authenticus POS Sale',
      receipt_email: email || undefined,
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
    if (!payment_intent)
      return res.status(400).json({ error: 'Missing payment_intent' });

    // Tell Stripe to process payment on your WisePOS E
    await stripe.terminal.readers.processPaymentIntent(READER_ID, {
      payment_intent,
    });

    // Poll until payment succeeds
    const poll = async () => {
      const pi = await stripe.paymentIntents.retrieve(payment_intent);
      if (pi.status === 'succeeded') return pi;
      await new Promise((r) => setTimeout(r, 1500));
      return poll();
    };

    const result = await poll();

    // Respond to frontend
    res.json({ success: true, payment_intent: result });

    // -------------------------------
    // Prompt customer for email/SMS receipt
    // -------------------------------
    try {
      if (result.status === 'succeeded') {
        await new Promise((r) => setTimeout(r, 1000)); // small delay

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
      console.error('⚠️ Error collecting on-reader inputs:', collectErr.message);
    }
  } catch (err) {
    console.error('❌ Error processing payment on reader:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --------------------
// Webhook (optional)
// --------------------
app.post('/webhook', (req, res) => {
  res.json({ received: true });
});

// --------------------
// Serve static files LAST (prevents HTML from overriding JSON routes)
// --------------------
app.use(express.static(path.join(__dirname, 'public')));

// --------------------
// Fallback for unknown routes
// --------------------
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found', path: req.path });
});

// --------------------
// Start server
// --------------------
app.listen(PORT, () =>
  console.log(`✅ Authenticus POS server running on port ${PORT}`)
);
