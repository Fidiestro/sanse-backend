require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');

const app = express();
const PORT = process.env.PORT || 3000;

// ====== TRUST PROXY (debe ir antes de todo en Railway) ======
app.set('trust proxy', 1);

// ====== SEGURIDAD ======
app.use(helmet());

// ====== CORS ======
const allowedOrigins = [
    process.env.FRONTEND_URL || 'https://sansecapital.co',
    'https://sansecapital.co',
    'http://localhost:3000',
    'http://localhost:5500',
    'http://127.0.0.1:5500'
];

app.use(cors({
    origin: function(origin, callback) {
        // Permitir requests sin origin (curl, Postman, health checks)
        if (!origin) return callback(null, true);
        if (allowedOrigins.indexOf(origin) !== -1) {
            return callback(null, true);
        }
        return callback(null, false);
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
}));

// ====== PARSEO ======
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true }));

// ====== HEALTH CHECK (antes de rate limit y rutas protegidas) ======
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        service: 'Sanse Capital API',
        timestamp: new Date().toISOString(),
    });
});

// ====== RATE LIMIT ======
const { generalLimiter } = require('./middleware/rateLimit');
app.use(generalLimiter);

// ====== RUTAS ======
const authRoutes = require('./routes/auth');
app.use('/api/auth', authRoutes);

// Dashboard routes (carga opcional)
try {
    const dashboardRoutes = require('./routes/dashboard');
    app.use('/api/dashboard', dashboardRoutes);
    console.log('📊 Rutas de dashboard cargadas');
} catch (e) {
    console.log('ℹ️  Rutas de dashboard no encontradas (opcional)');
}

// ====== 404 ======
app.use((req, res) => {
    res.status(404).json({ error: 'Ruta no encontrada' });
});

// ====== ERROR HANDLER ======
app.use((err, req, res, next) => {
    console.error('Error no manejado:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
});

// ====== INICIAR SERVIDOR PRIMERO, LUEGO CONECTAR DB ======
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Sanse Capital API corriendo en puerto ${PORT}`);
    console.log(`🔑 Entorno: ${process.env.NODE_ENV || 'development'}`);

    // Conectar a MySQL DESPUÉS de que el servidor ya esté escuchando
    const { testConnection } = require('./config/database');
    testConnection().then(() => {
        console.log('✅ Servidor listo y base de datos conectada');
    }).catch(err => {
        console.error('⚠️ Servidor corriendo pero DB no conectada:', err.message);
    });
});