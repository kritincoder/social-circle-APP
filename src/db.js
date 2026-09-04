const { Pool } = require('pg');

const databaseUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.DATABASE_PRIVATE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const pool = new Pool({
  connectionString: databaseUrl,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

module.exports = { pool };
