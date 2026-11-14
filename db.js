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
// Clean connection string for Neon HTTP header
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
  await query(`
    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'General',
      price NUMERIC(10, 2) NOT NULL DEFAULT 0,
      stock INTEGER DEFAULT NULL,
      is_service BOOLEAN NOT NULL DEFAULT FALSE,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS sales (
      id SERIAL PRIMARY KEY,
      total NUMERIC(10, 2) NOT NULL,
      payment_method TEXT NOT NULL DEFAULT 'efectivo',
      amount_received NUMERIC(10, 2) NOT NULL DEFAULT 0,
      change_given NUMERIC(10, 2) NOT NULL DEFAULT 0,
      note TEXT DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS sale_items (
      id SERIAL PRIMARY KEY,
      sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
      product_id INTEGER,
      product_name TEXT NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 1,
      unit_price NUMERIC(10, 2) NOT NULL,
      subtotal NUMERIC(10, 2) NOT NULL
    );
  `);

  // Insert sample products/services if table is empty
  const existing = await query('SELECT COUNT(*)::int AS total FROM products WHERE active = TRUE');
  if (existing[0] && Number(existing[0].total) === 0) {
    const samples = [
      ['Servicio General / Consulta', 'Servicios', 150.00, null, true],
      ['Mano de Obra / Instalación', 'Servicios', 300.00, null, true],
      ['Mantenimiento Preventivo', 'Servicios', 450.00, null, true],
      ['Artículo General A', 'Productos', 50.00, 25, false],
      ['Artículo General B', 'Productos', 120.00, 15, false],
      ['Accesorio / Refacción', 'Productos', 85.00, 30, false],
    ];
    for (const [name, category, price, stock, is_service] of samples) {
      await query(
        'INSERT INTO products (name, category, price, stock, is_service) VALUES ($1, $2, $3, $4, $5)',
        [name, category, price, stock, is_service]
      );
    }
  }
}
