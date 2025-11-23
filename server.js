// =====================================================================
// STRIPE BACKEND - Node.js Express per Railway
// =====================================================================

const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || 'sk_test_YOUR_KEY');
const bodyParser = require('body-parser');

const app = express();

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(express.raw({type: 'application/json'}));

// =====================================================================
// ENDPOINT 1: Crea Payment Intent
// =====================================================================
// IMPORTANTE: Questo endpoint è usato dall'app Android
app.post('/create-payment-intent', async (req, res) => {
    try {
        console.log('📨 Ricevuta richiesta: create-payment-intent');
        const { amount, currency = 'eur', description } = req.body;

        // Se amount non è specificato, usa 100 (€1,00)
        const finalAmount = amount || 100;

        console.log(`💳 Creando Payment Intent: ${finalAmount} ${currency.toUpperCase()}`);

        const paymentIntent = await stripe.paymentIntents.create({
            amount: Math.round(finalAmount),
            currency: currency.toLowerCase(),
            description: description || 'FCF Tessere Premium',
            metadata: {
                app: 'fcf-tessere',
                timestamp: new Date().toISOString()
            }
        });

        console.log(`✅ Payment Intent creato: ${paymentIntent.id}`);
        console.log(`📝 Client Secret: ${paymentIntent.client_secret?.substring(0, 20)}...`);

        // IMPORTANTE: Ritorna clientSecret e publishableKey
        res.json({
            clientSecret: paymentIntent.client_secret,
            publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || 'pk_test_YOUR_KEY',
            id: paymentIntent.id,
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
// ENDPOINT 2: Alias per compatibilità (con /api prefix)
// =====================================================================
app.post('/api/create-payment-intent', async (req, res) => {
    // Delega al primo endpoint
    app._router.stack.find(r => r.route && r.route.path === '/create-payment-intent').route.stack[0].handle(req, res);
});

// =====================================================================
// ENDPOINT 3: Verifica il Pagamento
// =====================================================================
app.get('/api/verify-payment', async (req, res) => {
    try {
        const { paymentIntentId } = req.query;
        console.log(`📨 Ricevuta richiesta: verify-payment per ${paymentIntentId}`);

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
// ENDPOINT 4: Webhook Stripe
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
// ENDPOINT 5: Health Check
// =====================================================================
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok',
        timestamp: new Date().toISOString(),
        environment: process.env.NODE_ENV || 'development'
    });
});

// =====================================================================
// ENDPOINT 6: Test Info
// =====================================================================
app.get('/info', (req, res) => {
    const hasSecretKey = !!process.env.STRIPE_SECRET_KEY;
    const hasPublishableKey = !!process.env.STRIPE_PUBLISHABLE_KEY;
    const hasWebhookSecret = !!process.env.STRIPE_WEBHOOK_SECRET && 
                              process.env.STRIPE_WEBHOOK_SECRET !== 'whsec_test_secret';

    res.json({
        app: 'FCF Tessere Stripe Backend',
        version: '1.0.0',
        endpoints: {
            health: 'GET /health',
            createPaymentIntent: 'POST /create-payment-intent',
            createPaymentIntentApi: 'POST /api/create-payment-intent',
            verifyPayment: 'GET /api/verify-payment?paymentIntentId=...',
            webhook: 'POST /webhook'
        },
        configuration: {
            stripeSecretKeySet: hasSecretKey ? '✅ Configurato' : '❌ NON configurato',
            stripePublishableKeySet: hasPublishableKey ? '✅ Configurato' : '❌ NON configurato',
            webhookSecretSet: hasWebhookSecret ? '✅ Configurato correttamente' : '⚠️ FAKE (usa whsec_test_secret)',
            nodeEnvironment: process.env.NODE_ENV || 'development'
        }
    });
});

// =====================================================================
// Avvia il Server
// =====================================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`\n┌─────────────────────────────────────────┐`);
    console.log(`│   🚀 STRIPE BACKEND - IN ESECUZIONE   │`);
    console.log(`├─────────────────────────────────────────┤`);
    console.log(`│ Porta: ${PORT}`);
    console.log(`│ URL: http://localhost:${PORT}`);
    console.log(`├─────────────────────────────────────────┤`);
    console.log(`│ ENDPOINT DISPONIBILI:`);
    console.log(`│ GET  /health`);
    console.log(`│ GET  /info`);
    console.log(`│ POST /create-payment-intent (per app)`);
    console.log(`│ POST /api/create-payment-intent`);
    console.log(`│ GET  /api/verify-payment`);
    console.log(`│ POST /webhook`);
    console.log(`└─────────────────────────────────────────┘\n`);
});

module.exports = app;
