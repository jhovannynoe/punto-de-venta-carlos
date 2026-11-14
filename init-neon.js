import { initDatabase, query } from './db.js';

async function main() {
  console.log('Actualizando esquema (Usuarios/Cajeros + Ventas) en Neon PostgreSQL...');
  await initDatabase();
  const users = await query('SELECT id, name, role, pin FROM users WHERE active = TRUE ORDER BY id');
  console.log(`Usuarios activos en Neon: ${users.length}`);
  for (const u of users) {
    console.log(` - [${u.id}] ${u.name} | Rol: ${u.role} | PIN: ${u.pin}`);
  }
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
