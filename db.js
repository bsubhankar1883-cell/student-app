const mysql = require('mysql2/promise');
const path = require('path');
const fs = require('fs');

// Try loading environment from parent .college-library/database.env or process.env
const dbHost = process.env.DB_HOST || 'localhost';
const dbPort = parseInt(process.env.DB_PORT || '3306', 10);
const dbUser = process.env.DB_USER || 'root';
const dbPassword = process.env.DB_PASSWORD || '';
const dbName = process.env.DB_NAME || 'college_library';

console.log(`[Database] Connecting to MySQL at ${dbHost}:${dbPort}/${dbName} (user: ${dbUser})`);

const pool = mysql.createPool({
    host: dbHost,
    port: dbPort,
    user: dbUser,
    password: dbPassword,
    database: dbName,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    connectTimeout: 10000
});

module.exports = pool;
