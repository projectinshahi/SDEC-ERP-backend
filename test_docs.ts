import * as dotenv from 'dotenv'; dotenv.config();
import prisma from './src/config/db.js';
async function run() {
  const docs = await prisma.project_documents.findMany({ orderBy: { created_at: 'desc' }, take: 5 });
  console.log(JSON.stringify(docs, null, 2));
}
run().finally(() => prisma.$disconnect());
