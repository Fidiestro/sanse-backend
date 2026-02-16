require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { testConnection } = require('./config/database');
const { generalLimiter } = require('./middleware/rateLimit');
const authRoutes = require('./routes/auth');

const app = express();
const PORT = process.env.PORT || 3000;

// ====== SEGURIDAD ======
app.use(helmet());
app.use(cors({
    origin: process.env.FRONTEND_URL || 'https://sansecapital.co',
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
}));
app.use(generalLimiter);

// ====== PARSEO ======
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true }));

// ====== TRUST PROXY (necesario para Railway/Render) ======
app.set('trust proxy', 1);

// ====== RUTAS ======
app.use('/api/auth', authRoutes);

// ====== HEALTH CHECK ======
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        service: 'Sanse Capital API',
        timestamp: new Date().toISOString(),
    });
});

// ====== 404 ======
app.use((req, res) => {
    res.status(404).json({ error: 'Ruta no encontrada' });
});

// ====== ERROR HANDLER ======
app.use((err, req, res, next) => {
    console.error('Error no manejado:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
});

// ====== INICIAR ======
async function start() {
    await testConnection();
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`🚀 Sanse Capital API corriendo en puerto ${PORT}`);
        console.log(`📍 Entorno: ${process.env.NODE_ENV || 'development'}`);
    });
}

start();
