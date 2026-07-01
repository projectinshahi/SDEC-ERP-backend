import prisma from './dist/config/db.js';

async function test() {
  try {
    // 1. Get first user
    const users = await prisma.$queryRawUnsafe(`SELECT id FROM users LIMIT 1;`);
    const userId = users[0]?.id;
    console.log('Seeded User ID found:', userId);

    // 2. Get first document
    const docs = await prisma.$queryRawUnsafe(`SELECT id FROM documents LIMIT 1;`);
    const docId = docs[0]?.id;
    console.log('Document ID found:', docId);

    if (!docId) {
      console.log('No documents found in database. Please upload one first.');
      process.exit(0);
    }

    console.log(`\nExecuting status update on document #${docId} using user #${userId}...`);
    const res = await prisma.$executeRawUnsafe(
      `
      UPDATE documents
      SET status = $1, verified_by = $2, verified_at = $3
      WHERE id = $4
      `,
      'Verified',
      userId,
      new Date(),
      docId
    );
    console.log('Update query result:', res);
  } catch (err) {
    console.error('Update query failed with full error stack:', err);
  }
  process.exit(0);
}

test();
