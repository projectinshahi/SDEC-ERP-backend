import 'dotenv/config';
import { Pool } from 'pg';

const connectionString = process.env.DATABASE_URL;
console.log('Testing connection string:', connectionString.replace(/:[^:@]+@/, ':***@'));

const pool = new Pool({ connectionString });

async function test() {
  try {
    const client = await pool.connect();
    console.log('Connected to pool!');
    const res = await client.query('SELECT NOW()');
    console.log('Query result:', res.rows[0]);
    client.release();
    pool.end();
  } catch (err) {
    console.error('Pool connection error:', err);
  }
}

test();
