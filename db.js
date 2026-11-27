import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx !== -1) {
        const key = trimmed.slice(0, idx).trim();
        const val = trimmed.slice(idx + 1).trim();
        if (!process.env[key]) process.env[key] = val;
      }
    }
  }
}

loadEnv();

export const DATABASE_URL = (
  process.env.DATABASE_URL ||
  'postgresql://neondb_owner:npg_v80ptgIKUSzN@ep-billowing-shape-bex6iinx-pooler.c-9.us-east-2.aws.neon.tech/neondb?sslmode=require'
).replace(/channel_binding=requir$/, 'channel_binding=require');

function getNeonHttpEndpoint(connectionString) {
  const u = new URL(connectionString);
  return `https://${u.hostname}/sql`;
}

const NEON_HTTP_URL = getNeonHttpEndpoint(DATABASE_URL);
const CLEAN_CONN_STR = (() => {
  const u = new URL(DATABASE_URL);
  u.searchParams.delete('channel_binding');
  u.searchParams.set('sslmode', 'require');
  return u.toString();
})();

export async function query(sqlText, params = []) {
  const res = await fetch(NEON_HTTP_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Neon-Connection-String': CLEAN_CONN_STR,
      'Neon-Raw-Text-Output': 'false',
      'Neon-Array-Mode': 'false',
    },
    body: JSON.stringify({ query: sqlText, params }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Error Neon DB (${res.status}): ${errText}`);
  }

  const data = await res.json();
  return data.rows || [];
}

export async function initDatabase() {
  // 1. Tabla de usuarios (Admin y Cajeros)
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'cajero',
      pin TEXT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // 2. Tabla de productos / servicios / servicios especiales
  await query(`
    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'General',
      price NUMERIC(10, 2) NOT NULL DEFAULT 0,
      stock INTEGER DEFAULT NULL,
      is_service BOOLEAN NOT NULL DEFAULT FALSE,
      product_type TEXT NOT NULL DEFAULT 'producto',
      free_after_sales INTEGER DEFAULT NULL,
      sales_counter INTEGER NOT NULL DEFAULT 0,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Asegurar nuevas columnas para Servicio Especial en tabla products existente
  await query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS product_type TEXT NOT NULL DEFAULT 'producto';`);
  await query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS free_after_sales INTEGER DEFAULT NULL;`);
  await query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS sales_counter INTEGER NOT NULL DEFAULT 0;`);

  // Sincronizar product_type en registros anteriores
  await query(`
    UPDATE products
    SET product_type = 'servicio'
    WHERE is_service = TRUE AND product_type = 'producto';
  `);

  // 3. Tabla de Promociones / Combos (Compra A + B = -$ descuento)
  await query(`
    CREATE TABLE IF NOT EXISTS promotions (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      product_a_id INTEGER NOT NULL,
      product_b_id INTEGER NOT NULL,
      discount_amount NUMERIC(10, 2) NOT NULL DEFAULT 10.00,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // 4. Tabla de ventas (con cajero, descuentos de promociones y estado de devoluciones)
  await query(`
    CREATE TABLE IF NOT EXISTS sales (
      id SERIAL PRIMARY KEY,
      subtotal NUMERIC(10, 2) NOT NULL DEFAULT 0,
      discount_total NUMERIC(10, 2) NOT NULL DEFAULT 0,
      promo_summary TEXT DEFAULT '',
      total NUMERIC(10, 2) NOT NULL,
      payment_method TEXT NOT NULL DEFAULT 'efectivo',
      amount_received NUMERIC(10, 2) NOT NULL DEFAULT 0,
      change_given NUMERIC(10, 2) NOT NULL DEFAULT 0,
      note TEXT DEFAULT '',
      cashier_id INTEGER,
      cashier_name TEXT DEFAULT 'General',
      status TEXT NOT NULL DEFAULT 'completada',
      refunded_total NUMERIC(10, 2) NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS cashier_id INTEGER;`);
  await query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS cashier_name TEXT DEFAULT 'General';`);
  await query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS subtotal NUMERIC(10, 2) NOT NULL DEFAULT 0;`);
  await query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS discount_total NUMERIC(10, 2) NOT NULL DEFAULT 0;`);
  await query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS promo_summary TEXT DEFAULT '';`);
  await query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'completada';`);
  await query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS refunded_total NUMERIC(10, 2) NOT NULL DEFAULT 0;`);
  await query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS cut_id INTEGER DEFAULT NULL;`);
  await query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS client_uid TEXT DEFAULT NULL;`);

  // 7. Tabla de Cortes de Caja / Cierres de Turno
  await query(`
    CREATE TABLE IF NOT EXISTS cash_cuts (
      id SERIAL PRIMARY KEY,
      cashier_id INTEGER,
      cashier_name TEXT NOT NULL DEFAULT 'General',
      sales_count INTEGER NOT NULL DEFAULT 0,
      gross_sales NUMERIC(10, 2) NOT NULL DEFAULT 0,
      refunded_total NUMERIC(10, 2) NOT NULL DEFAULT 0,
      net_sales NUMERIC(10, 2) NOT NULL DEFAULT 0,
      expected_cash NUMERIC(10, 2) NOT NULL DEFAULT 0,
      counted_cash NUMERIC(10, 2) NOT NULL DEFAULT 0,
      cash_difference NUMERIC(10, 2) NOT NULL DEFAULT 0,
      card_sales NUMERIC(10, 2) NOT NULL DEFAULT 0,
      transfer_sales NUMERIC(10, 2) NOT NULL DEFAULT 0,
      note TEXT DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // 8. Tabla de Logs de Diagnóstico tras bambalinas (auto-limpieza a 15 días)
  await query(`
    CREATE TABLE IF NOT EXISTS system_logs (
      id SERIAL PRIMARY KEY,
      level TEXT NOT NULL DEFAULT 'info',
      category TEXT NOT NULL DEFAULT 'general',
      message TEXT NOT NULL,
      details TEXT DEFAULT '',
      cashier_name TEXT DEFAULT 'Anónimo',
      device_info TEXT DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await query(`DELETE FROM system_logs WHERE created_at < NOW() - INTERVAL '15 days';`);

  // 5. Tabla de conceptos por venta
  await query(`
    CREATE TABLE IF NOT EXISTS sale_items (
      id SERIAL PRIMARY KEY,
      sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
      product_id INTEGER,
      product_name TEXT NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 1,
      returned_qty INTEGER NOT NULL DEFAULT 0,
      unit_price NUMERIC(10, 2) NOT NULL,
      subtotal NUMERIC(10, 2) NOT NULL,
      is_free_reward BOOLEAN NOT NULL DEFAULT FALSE
    );
  `);

  await query(`ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS is_free_reward BOOLEAN NOT NULL DEFAULT FALSE;`);
  await query(`ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS returned_qty INTEGER NOT NULL DEFAULT 0;`);

  // 6. Tabla de historial de devoluciones (parciales y totales, con motivo, merma/stock y autorización)
  await query(`
    CREATE TABLE IF NOT EXISTS sale_returns (
      id SERIAL PRIMARY KEY,
      sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
      refund_amount NUMERIC(10, 2) NOT NULL DEFAULT 0,
      reason TEXT NOT NULL DEFAULT '',
      return_to_stock BOOLEAN NOT NULL DEFAULT TRUE,
      items_summary TEXT NOT NULL DEFAULT '',
      processed_by_name TEXT NOT NULL DEFAULT 'General',
      authorized_by_name TEXT NOT NULL DEFAULT 'Administrador',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Usuarios iniciales
  const existingUsers = await query('SELECT COUNT(*)::int AS total FROM users WHERE active = TRUE');
  if (existingUsers[0] && Number(existingUsers[0].total) === 0) {
    const defaultUsers = [
      ['Administrador', 'admin', '1234'],
      ['Cajero 1', 'cajero', '1111'],
      ['Cajero 2', 'cajero', '2222'],
    ];
    for (const [name, role, pin] of defaultUsers) {
      await query('INSERT INTO users (name, role, pin) VALUES ($1, $2, $3)', [name, role, pin]);
    }
  }

  // Asegurar que exista al menos un Servicio Especial de ejemplo y una Promoción de ejemplo
  const specialExists = await query(
    "SELECT COUNT(*)::int AS total FROM products WHERE product_type = 'servicio_especial' AND active = TRUE"
  );
  if (specialExists[0] && Number(specialExists[0].total) === 0) {
    await query(
      `INSERT INTO products (name, category, price, stock, is_service, product_type, free_after_sales, sales_counter)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      ['Servicio Especial VIP (Cada 5 el 6º es Gratis)', 'Servicios Especiales', 200.0, null, true, 'servicio_especial', 5, 0]
    );
  }

  const existingPromos = await query('SELECT COUNT(*)::int AS total FROM promotions WHERE active = TRUE');
  if (existingPromos[0] && Number(existingPromos[0].total) === 0) {
    const prods = await query('SELECT id, name FROM products WHERE active = TRUE ORDER BY id ASC LIMIT 2');
    if (prods.length >= 2) {
      await query(
        `INSERT INTO promotions (name, product_a_id, product_b_id, discount_amount)
         VALUES ($1, $2, $3, $4)`,
        [`Combo ${prods[0].name} + ${prods[1].name} (-$10)`, prods[0].id, prods[1].id, 10.0]
      );
    }
  }
}
