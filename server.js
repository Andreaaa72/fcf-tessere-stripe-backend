// =====================================================================
// STRIPE BACKEND - Node.js Express per Render
// =====================================================================

const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || 'sk_live_YOUR_KEY');
const bodyParser = require('body-parser');

const app = express();

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(express.raw({type: 'application/json'}));

// =====================================================================
// ENDPOINT 1: Crea Payment Intent
// =====================================================================
app.post('/api/create-payment-intent', async (req, res) => {
    try {
        console.log('📝 Ricevuta richiesta: create-payment-intent');
        const { amount, currency, description } = req.body;

        if (!amount || !currency) {
            return res.status(400).json({ 
                error: 'amount e currency sono obbligatori',
                received: req.body
            });
        }

        const paymentIntent = await stripe.paymentIntents.create({
            amount: Math.round(amount),
            currency: currency.toLowerCase(),
            description: description || 'FCF Tessere Premium',
            metadata: {
                app: 'fcf-tessere',
                timestamp: new Date().toISOString()
            }
        });

        console.log(`✅ Payment Intent creato: ${paymentIntent.id}`);

        res.json({
            id: paymentIntent.id,
            clientSecret: paymentIntent.client_secret,
            amount: paymentIntent.amount,
            currency: paymentIntent.currency,
            status: paymentIntent.status
        });

    } catch (error) {
        console.error('❌ Errore create-payment-intent:', error.message);
        res.status(500).json({ 
            error: error.message,
            type: error.type
        });
    }
});

// =====================================================================
// ENDPOINT 2: Verifica il Pagamento
// =====================================================================
app.get('/api/verify-payment', async (req, res) => {
    try {
        const { paymentIntentId } = req.query;
        console.log(`🔍 Ricevuta richiesta: verify-payment per ${paymentIntentId}`);

        if (!paymentIntentId) {
            return res.status(400).json({ 
                error: 'paymentIntentId è obbligatorio' 
            });
        }

        const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

        console.log(`✅ Payment Intent verificato: ${paymentIntent.id} - Status: ${paymentIntent.status}`);

        res.json({
            id: paymentIntent.id,
            status: paymentIntent.status,
            amount: paymentIntent.amount,
            currency: paymentIntent.currency,
            created: paymentIntent.created,
            customer: paymentIntent.customer
        });

    } catch (error) {
        console.error('❌ Errore verify-payment:', error.message);
        res.status(500).json({ 
            error: error.message 
        });
    }
});

// =====================================================================
// ENDPOINT 3: Webhook Stripe
// =====================================================================
app.post('/webhook', express.raw({type: 'application/json'}), async (req, res) => {
    const sig = req.headers['stripe-signature'];

    try {
        console.log('🪝 Webhook ricevuto da Stripe');
        
        const event = stripe.webhooks.constructEvent(
            req.body,
            sig,
            process.env.STRIPE_WEBHOOK_SECRET || 'whsec_test_secret'
        );

        switch (event.type) {
            case 'payment_intent.succeeded':
                console.log(`✅ WEBHOOK: Pagamento riuscito - ${event.data.object.id}`);
                break;
            case 'payment_intent.payment_failed':
                console.log(`❌ WEBHOOK: Pagamento fallito - ${event.data.object.id}`);
                break;
            case 'charge.refunded':
                console.log(`↩️ WEBHOOK: Rimborso - ${event.data.object.id}`);
                break;
            default:
                console.log(`ℹ️ Evento: ${event.type}`);
        }

        res.json({received: true});

    } catch (error) {
        console.error('❌ Errore webhook:', error.message);
        res.status(400).json({error: error.message});
    }
});

// =====================================================================
// ENDPOINT 4: Health Check
// =====================================================================
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok',
        timestamp: new Date().toISOString(),
        environment: process.env.NODE_ENV || 'development'
    });
});

// =====================================================================
// ENDPOINT 5: Test Info
// =====================================================================
app.get('/info', (req, res) => {
    res.json({
        app: 'FCF Tessere Stripe Backend',
        version: '1.0.0',
        endpoints: {
            health: '/health',
            createPaymentIntent: 'POST /api/create-payment-intent',
            verifyPayment: 'GET /api/verify-payment?paymentIntentId=...',
            webhook: 'POST /webhook'
        },
        stripeKeySet: !!process.env.STRIPE_SECRET_KEY,
        webhookSecretSet: !!process.env.STRIPE_WEBHOOK_SECRET
    });
});

// =====================================================================
// Avvia il Server
// =====================================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`\n╔════════════════════════════════════════╗`);
    console.log(`║   🚀 STRIPE BACKEND - IN ESECUZIONE   ║`);
    console.log(`╠════════════════════════════════════════╣`);
    console.log(`║ Porta: ${PORT}`);
    console.log(`║ URL: http://localhost:${PORT}`);
    console.log(`╠════════════════════════════════════════╣`);
    console.log(`║ ENDPOINT DISPONIBILI:`);
    console.log(`║ GET  /health`);
    console.log(`║ GET  /info`);
    console.log(`║ POST /api/create-payment-intent`);
    console.log(`║ GET  /api/verify-payment`);
    console.log(`║ POST /webhook`);
    console.log(`╚════════════════════════════════════════╝\n`);
});

module.exports = app;
