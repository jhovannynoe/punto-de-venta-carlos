import { initDatabase, query } from './db.js';

async function main() {
  console.log('Inicializando esquema y datos base en Neon PostgreSQL...');
  await initDatabase();
  const prods = await query('SELECT id, name, category, price, stock, is_service FROM products WHERE active = TRUE ORDER BY id');
  console.log(`Conectado a Neon correctamente. Productos/Servicios activos: ${prods.length}`);
  for (const p of prods) {
    console.log(` - [${p.id}] ${p.name} ($${p.price}) | ${p.is_service ? 'Servicio' : 'Stock: ' + p.stock}`);
  }
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
