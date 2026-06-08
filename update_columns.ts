import prisma from './src/config/db.js';

async function main() {
  const cols = await prisma.kanban_columns.findMany();
  console.log("Current cols:", cols);
  
  // Find any columns named 'In Progress' or 'in progress' or 'In-Progress'
  const inProgressCols = cols.filter(c => c.label.toLowerCase() === 'in progress' || c.label.toLowerCase() === 'in-progress');
  
  for (const col of inProgressCols) {
    console.log(`Updating column ${col.id} from ${col.label} to 'To be Started'`);
    await prisma.kanban_columns.update({
      where: { id: col.id },
      data: { label: 'To be Started' }
    });
  }
  
  const finalCols = await prisma.kanban_columns.findMany();
  console.log("Final cols:", finalCols);
}

main().catch(console.error).finally(() => {
  // Can't reliably disconnect due to Neon adapter sometimes hanging, but script will exit.
  process.exit(0);
});
