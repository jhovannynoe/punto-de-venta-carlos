import { initDatabase, query } from './db.js';

async function main() {
  console.log('Actualizando esquema (Servicio Especial y Promociones A+B) en Neon PostgreSQL...');
  await initDatabase();
  const specials = await query(
    "SELECT id, name, price, free_after_sales, sales_counter FROM products WHERE product_type = 'servicio_especial' AND active = TRUE"
  );
  console.log(`Servicios Especiales activos: ${specials.length}`);
  for (const s of specials) {
    console.log(
      ` - [${s.id}] ${s.name} ($${s.price}) | Meta gratis cada: ${s.free_after_sales} ventas (Contador actual: ${s.sales_counter})`
    );
  }
  const promos = await query('SELECT id, name, product_a_id, product_b_id, discount_amount FROM promotions WHERE active = TRUE');
  console.log(`Promociones activas: ${promos.length}`);
  for (const pr of promos) {
    console.log(` - [${pr.id}] ${pr.name} | -$${pr.discount_amount}`);
  }
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
