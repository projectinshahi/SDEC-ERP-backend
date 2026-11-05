const { Client } = require('pg');
require('dotenv').config();

async function main() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL
  });

  try {
    await client.connect();
    const res = await client.query('DELETE FROM project_members');
    console.log('Deleted project_members:', res.rowCount);
  } catch (err) {
    console.error('Error:', err);
  } finally {
    await client.end();
  }
}

main();
