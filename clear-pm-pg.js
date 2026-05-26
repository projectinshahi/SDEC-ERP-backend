const { Client } = require('pg');

async function main() {
  const client = new Client({
    connectionString: "postgresql://neondb_owner:npg_3kixXJENWyM8@ep-round-silence-aos4let2.c-2.ap-southeast-1.aws.neon.tech/neondb?sslmode=require"
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
