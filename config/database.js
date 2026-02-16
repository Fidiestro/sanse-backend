const mysql = require('mysql2/promise');
require('dotenv').config();

const sslConfig = process.env.DB_SSL === 'true'
    ? { rejectUnauthorized: false }
    : undefined;

const pool = mysql.createPool({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: sslConfig,
    waitForConnections: true,
    connectionLimit: 5,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0,
    connectTimeout: 30000,
    timezone: '-05:00',
});

async function testConnection() {
    try {
        const connection = await pool.getConnection();
        console.log('✅ MySQL conectado correctamente');
        connection.release();
    } catch (error) {
        console.error('❌ Error conectando a MySQL:', error.message);
        if (process.env.NODE_ENV !== 'production') {
            process.exit(1);
        }
    }
}

module.exports = { pool, testConnection };
