require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);
app.use(helmet());

// ═══ CORS — permitir frontend ═══
const allowedOrigins = [
    process.env.FRONTEND_URL || 'https://sansecapital.co',
    'https://sansecapital.co',
    'https://www.sansecapital.co',
    'http://localhost:3000',
    'http://localhost:5500',
    'http://127.0.0.1:5500'
];

const corsOptions = {
    origin: function(origin, callback) {
        // Permitir requests sin origin (mobile apps, curl, etc)
        if (!origin) return callback(null, true);
        if (allowedOrigins.indexOf(origin) !== -1) return callback(null, true);
        console.log('⛔ CORS blocked origin:', origin);
        return callback(null, false);
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
};

// CRITICAL: Habilitar preflight (OPTIONS) para TODAS las rutas
app.options('*', cors(corsOptions));
app.use(cors(corsOptions));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ═══ HEALTH CHECK ═══
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', service: 'Sanse Capital API', timestamp: new Date().toISOString() });
});

// ═══ REGISTRO PÚBLICO (sin auth, sin rate limit) ═══
const referralController = require('./controllers/referralController');
app.post('/api/auth/register', referralController.publicRegister);

// ═══ RATE LIMITER (después de register para no bloquearlo) ═══
const { generalLimiter } = require('./middleware/rateLimit');
app.use(generalLimiter);

// ═══ RUTAS ═══
app.use('/api/auth', require('./routes/auth'));

try { app.use('/api/dashboard', require('./routes/dashboard')); console.log('📊 Dashboard routes loaded'); } catch(e) { console.error('❌ Dashboard routes error:', e.message); }
try { app.use('/api/admin', require('./routes/admin')); console.log('🔧 Admin routes loaded'); } catch(e) { console.error('❌ Admin routes error:', e.message); }
try { app.use('/api/investments', require('./routes/investments')); console.log('💰 Investment routes loaded'); } catch(e) { console.error('❌ Investment routes error:', e.message); }
try { app.use('/api/withdrawals', require('./routes/withdrawals')); console.log('💸 Withdrawal routes loaded'); } catch(e) { console.error('❌ Withdrawal routes error:', e.message); }
try { app.use('/api/loans', require('./routes/loans')); console.log('🏦 Loan routes loaded'); } catch(e) { console.error('❌ Loan routes error:', e.message); }
try { app.use('/api/deposits', require('./routes/deposits')); console.log('📥 Deposit routes loaded'); } catch(e) { console.error('❌ Deposit routes error:', e.message); }
try { app.use('/api/user', require('./routes/user')); console.log('👤 User routes loaded'); } catch(e) { console.error('❌ User routes error:', e.message); }

// ═══ 404 y ERROR HANDLER ═══
app.use((req, res) => {
    console.log('🔍 404:', req.method, req.originalUrl);
    res.status(404).json({ error: 'Ruta no encontrada' });
});
app.use((err, req, res, next) => {
    console.error('💥 Error:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
});

// ═══ START ═══
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Sanse Capital API corriendo en puerto ${PORT}`);
    console.log(`🔑 Entorno: ${process.env.NODE_ENV || 'development'}`);
    console.log(`🌐 Origins permitidos: ${allowedOrigins.join(', ')}`);
    const { testConnection } = require('./config/database');
    testConnection().then(() => console.log('✅ DB conectada')).catch(err => console.error('⚠️ DB error:', err.message));
});