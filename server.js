// =====================================================================
// STRIPE BACKEND CON CODICI SBLOCCO LIMITATI A 3 UTILIZZI
// + CODICI MASTER SENZA LIMITI
// =====================================================================

const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || 'sk_test_YOUR_KEY');
const bodyParser = require('body-parser');
const { Pool } = require('pg');

const app = express();

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(express.raw({type: 'application/json'}));

// =====================================================================
// DATABASE PostgreSQL
// =====================================================================

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

const MAX_UNLOCK_USES = 3;

// Crea le tabelle al startup
pool.query(`
    CREATE TABLE IF NOT EXISTS paid_devices (
        id SERIAL PRIMARY KEY,
        device_id VARCHAR(255) UNIQUE NOT NULL,
        payment_intent_id VARCHAR(255),
        unlock_code VARCHAR(50) UNIQUE NOT NULL,
        paid_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        amount INTEGER,
        currency VARCHAR(3),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
`, (err) => {
    if (err) {
        console.error('❌ Errore creazione tabella paid_devices:', err);
    } else {
        console.log('✅ Tabella paid_devices verificata');
    }
});

pool.query(`
    CREATE TABLE IF NOT EXISTS unlock_codes (
        id SERIAL PRIMARY KEY,
        unlock_code VARCHAR(50) UNIQUE NOT NULL,
        device_id VARCHAR(255),
        payment_intent_id VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        used_count INTEGER DEFAULT 0,
        last_used TIMESTAMP,
        active BOOLEAN DEFAULT true,
        unlimited BOOLEAN DEFAULT false
    );
`, (err) => {
    if (err) {
        console.error('❌ Errore creazione tabella unlock_codes:', err);
    } else {
        console.log('✅ Tabella unlock_codes verificata');
    }
});

// =====================================================================
// FUNZIONE: Genera codice di sblocco univoco
// =====================================================================

function generateUnlockCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789';
    let code = 'FCF';
    
    for (let i = 0; i < 3; i++) {
        code += '-';
        for (let j = 0; j < 4; j++) {
            code += chars.charAt(Math.floor(Math.random() * chars.length));
        }
    }
    
    return code;
}

// =====================================================================
// INSERISCI CODICE MASTER AL STARTUP (UNA SOLA VOLTA)
// =====================================================================

const MASTER_CODE = 'FCF-A7K9-M2P4-X8Q1'; // Codice MASTER senza limiti

pool.query(
    `INSERT INTO unlock_codes (unlock_code, active, unlimited, used_count)
     VALUES ($1, true, true, 0)
     ON CONFLICT (unlock_code) DO NOTHING`,
    [MASTER_CODE],
    (err) => {
        if (err) {
            console.error('❌ Errore inserimento codice MASTER:', err);
        } else {
            console.log(`✅ Codice MASTER disponibile: ${MASTER_CODE}`);
        }
    }
);

// =====================================================================
// ENDPOINT 1: Crea Payment Intent
// =====================================================================
app.post('/create-payment-intent', async (req, res) => {
    try {
        console.log('📨 Ricevuta richiesta: create-payment-intent');
        const { amount, currency = 'eur', description, deviceId } = req.body;

        const finalAmount = (amount || 1.99) * 100;

        console.log(`💳 Creando Payment Intent: ${finalAmount} centesimi (${(finalAmount / 100).toFixed(2)}€)`);
        console.log(`📱 Device ID: ${deviceId}`);

        const paymentIntent = await stripe.paymentIntents.create({
            amount: Math.round(finalAmount),
            currency: currency.toLowerCase(),
            description: description || 'FCF Tessere Premium',
            metadata: {
                app: 'fcf-tessere',
                deviceId: deviceId,
                timestamp: new Date().toISOString()
            }
        });

        console.log(`✅ Payment Intent creato: ${paymentIntent.id}`);

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
// ENDPOINT 2: Registra device come pagato E genera codice
// =====================================================================
app.post('/register-paid-device', async (req, res) => {
    try {
        const { deviceId, paymentIntentId, amount, currency } = req.body;

        if (!deviceId || !paymentIntentId) {
            return res.status(400).json({ 
                error: 'deviceId e paymentIntentId sono obbligatori' 
            });
        }

        console.log(`💳 Registrando device pagato: ${deviceId}`);
        console.log(`   Payment Intent: ${paymentIntentId}`);

        const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

        if (paymentIntent.status !== 'succeeded') {
            console.log(`❌ PaymentIntent non completato: ${paymentIntent.status}`);
            return res.status(400).json({ 
                error: 'PaymentIntent non completato',
                status: paymentIntent.status
            });
        }

        console.log(`✅ PaymentIntent verificato: ${paymentIntent.status}`);

        let unlockCode = generateUnlockCode();
        let attempts = 0;
        const maxAttempts = 10;

        while (attempts < maxAttempts) {
            const existingCode = await pool.query(
                'SELECT * FROM unlock_codes WHERE unlock_code = $1',
                [unlockCode]
            );
            
            if (existingCode.rows.length === 0) {
                break;
            }
            
            unlockCode = generateUnlockCode();
            attempts++;
        }

        console.log(`🔑 Codice di sblocco generato: ${unlockCode}`);
        console.log(`   📊 Limite utilizzi: ${MAX_UNLOCK_USES}`);

        await pool.query(
            `INSERT INTO unlock_codes (unlock_code, device_id, payment_intent_id, active, used_count, unlimited) 
             VALUES ($1, $2, $3, true, 0, false)`,
            [unlockCode, deviceId, paymentIntentId]
        );

        await pool.query(
            `INSERT INTO paid_devices (device_id, payment_intent_id, unlock_code, amount, currency) 
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (device_id) DO UPDATE 
             SET payment_intent_id = $2, unlock_code = $3, amount = $4, currency = $5, paid_at = CURRENT_TIMESTAMP
             RETURNING *`,
            [deviceId, paymentIntentId, unlockCode, amount || 100, currency || 'eur']
        );

        console.log(`✅ Device registrato con codice limitato a ${MAX_UNLOCK_USES} utilizzi`);

        res.json({
            success: true,
            deviceId: deviceId,
            paymentIntentId: paymentIntentId,
            unlockCode: unlockCode,
            maxUses: MAX_UNLOCK_USES,
            message: `Codice valido per ${MAX_UNLOCK_USES} dispositivi. Salva il codice!`,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('❌ Errore register-paid-device:', error.message);
        res.status(500).json({ 
            error: error.message 
        });
    }
});

// =====================================================================
// ENDPOINT 3: Verifica codice di sblocco
// =====================================================================
app.post('/verify-unlock-code', async (req, res) => {
    try {
        const { unlockCode } = req.body;

        if (!unlockCode) {
            return res.status(400).json({ 
                error: 'unlockCode è obbligatorio' 
            });
        }

        console.log(`🔍 Verifica codice: ${unlockCode}`);

        const result = await pool.query(
            'SELECT * FROM unlock_codes WHERE unlock_code = $1',
            [unlockCode]
        );

        if (result.rows.length === 0) {
            console.log(`❌ Codice non trovato`);
            return res.json({
                valid: false,
                message: 'Codice non trovato',
                limitReached: false
            });
        }

        const codeRecord = result.rows[0];

        if (!codeRecord.active) {
            console.log(`❌ Codice disattivato`);
            return res.json({
                valid: false,
                message: 'Codice disattivato',
                limitReached: false
            });
        }

        // ✅ NUOVO: Controlla se è un codice UNLIMITED
        const isUnlimited = codeRecord.unlimited === true;

        if (!isUnlimited && codeRecord.used_count >= MAX_UNLOCK_USES) {
            await pool.query(
                'UPDATE unlock_codes SET active = false WHERE unlock_code = $1',
                [unlockCode]
            );
            
            console.log(`⛔ Codice disattivato automaticamente`);
            
            return res.json({
                valid: false,
                message: `Codice raggiunto il limite di ${MAX_UNLOCK_USES} utilizzi. Non è più valido.`,
                usesRemaining: 0,
                limitReached: true
            });
        }

        const usesRemaining = isUnlimited ? Infinity : (MAX_UNLOCK_USES - codeRecord.used_count - 1);
        
        await pool.query(
            `UPDATE unlock_codes 
             SET used_count = used_count + 1, last_used = CURRENT_TIMESTAMP 
             WHERE unlock_code = $1`,
            [unlockCode]
        );

        console.log(`✅ Codice verificato: ${unlockCode}`);
        if (isUnlimited) {
            console.log(`   🔓 CODICE MASTER (Senza limiti)`);
        } else {
            console.log(`   Utilizzi rimanenti: ${usesRemaining}/${MAX_UNLOCK_USES}`);
        }

        res.json({
            valid: true,
            unlockCode: unlockCode,
            originalDeviceId: codeRecord.device_id,
            usedCount: codeRecord.used_count + 1,
            usesRemaining: isUnlimited ? null : usesRemaining,
            maxUses: isUnlimited ? null : MAX_UNLOCK_USES,
            isUnlimited: isUnlimited,
            message: isUnlimited
                ? `🔓 Codice MASTER valido! (Senza limiti)`
                : usesRemaining > 0 
                    ? `Codice valido! (${usesRemaining} utilizzi rimasti)`
                    : `Attenzione: ultimo utilizzo per questo codice!`,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('❌ Errore verify-unlock-code:', error.message);
        res.status(500).json({ 
            error: error.message 
        });
    }
});

// =====================================================================
// ENDPOINT 4: Verifica se device è sbloccato
// =====================================================================
app.post('/verify-device', async (req, res) => {
    try {
        const { deviceId } = req.body;

        if (!deviceId) {
            return res.status(400).json({ 
                error: 'deviceId è obbligatorio' 
            });
        }

        console.log(`📱 Verifica device: ${deviceId}`);

        const result = await pool.query(
            'SELECT * FROM paid_devices WHERE device_id = $1',
            [deviceId]
        );

        const isUnlocked = result.rows.length > 0;

        if (isUnlocked) {
            console.log(`✅ Device ${deviceId} è SBLOCCATO`);
            console.log(`   Codice: ${result.rows[0].unlock_code}`);
        } else {
            console.log(`❌ Device ${deviceId} è BLOCCATO`);
        }

        res.json({
            deviceId: deviceId,
            isUnlocked: isUnlocked,
            unlockCode: isUnlocked ? result.rows[0].unlock_code : null,
            paidAt: isUnlocked ? result.rows[0].paid_at : null,
            amount: isUnlocked ? result.rows[0].amount : null,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('❌ Errore verify-device:', error.message);
        res.status(500).json({ 
            error: error.message 
        });
    }
});

// =====================================================================
// ENDPOINT 5: Webhook Stripe
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
// ENDPOINT 6: Health Check
// =====================================================================
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok',
        timestamp: new Date().toISOString(),
        environment: process.env.NODE_ENV || 'development'
    });
});

// =====================================================================
// ENDPOINT 7: Test Info
// =====================================================================
app.get('/info', async (req, res) => {
    try {
        const dbResult = await pool.query('SELECT COUNT(*) as count FROM paid_devices');
        const codesResult = await pool.query('SELECT COUNT(*) as count FROM unlock_codes WHERE active = true');
        const deactivatedResult = await pool.query('SELECT COUNT(*) as count FROM unlock_codes WHERE active = false');
        const masterResult = await pool.query('SELECT COUNT(*) as count FROM unlock_codes WHERE unlimited = true');
        
        const paidDevicesCount = dbResult.rows[0].count;
        const activeCodesCount = codesResult.rows[0].count;
        const deactivatedCodesCount = deactivatedResult.rows[0].count;
        const masterCodesCount = masterResult.rows[0].count;

        res.json({
            app: 'FCF Tessere Stripe Backend',
            version: '4.0.0',
            features: {
                unlockCodesLimit: `Massimo ${MAX_UNLOCK_USES} utilizzi per codice`,
                autoDeactivation: 'Codici disattivati automaticamente al raggiungimento del limite',
                masterCodes: 'Supporto per codici MASTER senza limiti'
            },
            endpoints: {
                health: 'GET /health',
                createPaymentIntent: 'POST /create-payment-intent',
                registerPaidDevice: 'POST /register-paid-device (genera codice limitato)',
                verifyUnlockCode: 'POST /verify-unlock-code (con controllo limite)',
                verifyDevice: 'POST /verify-device',
                webhook: 'POST /webhook'
            },
            database: {
                connected: true,
                paidDevicesCount: parseInt(paidDevicesCount),
                activeUnlockCodesCount: parseInt(activeCodesCount),
                deactivatedCodesCount: parseInt(deactivatedCodesCount),
                masterCodesCount: parseInt(masterCodesCount),
                limitsEnforced: true
            },
            configuration: {
                stripeSecretKeySet: !!process.env.STRIPE_SECRET_KEY ? '✅' : '❌',
                stripePublishableKeySet: !!process.env.STRIPE_PUBLISHABLE_KEY ? '✅' : '❌',
                databaseConfigured: !!process.env.DATABASE_URL ? '✅' : '❌'
            },
            masterCodeAvailable: MASTER_CODE
        });
    } catch (error) {
        res.status(500).json({
            error: error.message
        });
    }
});

// =====================================================================
// Avvia il Server
// =====================================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`\n┌────────────────────────────────────────────────────────────┐`);
    console.log(`│  🚀 STRIPE BACKEND v4.0 - CODICI LIMITATI + MASTER          │`);
    console.log(`├────────────────────────────────────────────────────────────┤`);
    console.log(`│ Porta: ${PORT}`);
    console.log(`│ URL: http://localhost:${PORT}`);
    console.log(`│ Database: PostgreSQL (Railway)`);
    console.log(`│ Sicurezza: Ogni codice valido per max ${MAX_UNLOCK_USES} device`);
    console.log(`│ Master Code: ${MASTER_CODE} (Senza limiti)`);
    console.log(`│ Status: Protezione contro abuso attiva ✅`);
    console.log(`├────────────────────────────────────────────────────────────┤`);
    console.log(`│ ENDPOINT DISPONIBILI:`);
    console.log(`│ GET  /health`);
    console.log(`│ GET  /info`);
    console.log(`│ POST /create-payment-intent`);
    console.log(`│ POST /register-paid-device → Genera codice (${MAX_UNLOCK_USES} usi)`);
    console.log(`│ POST /verify-unlock-code → Verifica + decrementa contatore`);
    console.log(`│ POST /verify-device`);
    console.log(`│ POST /webhook`);
    console.log(`└────────────────────────────────────────────────────────────┘\n`);
});

module.exports = app;

