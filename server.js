import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query, initDatabase } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'www');
const PORT = Number(process.env.PORT || 3000);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(payload));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error('JSON inválido'));
      }
    });
    req.on('error', reject);
  });
}

async function handleApi(req, res, urlObj) {
  const pathname = urlObj.pathname;
  const method = req.method;

  if (method === 'OPTIONS') {
    return sendJson(res, 200, { ok: true });
  }

  try {
    // Health check
    if (pathname === '/api/health' && method === 'GET') {
      const rows = await query('SELECT NOW() AS server_time');
      return sendJson(res, 200, { ok: true, connected: true, serverTime: rows[0]?.server_time });
    }

    // GET /api/users (List active cashiers & admins)
    if (pathname === '/api/users' && method === 'GET') {
      const rows = await query(`
        SELECT id, name, role, pin, created_at
        FROM users
        WHERE active = TRUE
        ORDER BY CASE WHEN role = 'admin' THEN 0 ELSE 1 END, name ASC
      `);
      return sendJson(res, 200, rows);
    }

    // POST /api/auth (Verify PIN login)
    if (pathname === '/api/auth' && method === 'POST') {
      const body = await parseBody(req);
      const userId = Number(body.user_id || 0);
      const pin = String(body.pin || '').trim();

      const rows = await query(
        'SELECT id, name, role FROM users WHERE id = $1 AND pin = $2 AND active = TRUE',
        [userId, pin]
      );
      if (rows.length === 0) {
        return sendJson(res, 401, { error: 'PIN incorrecto' });
      }
      return sendJson(res, 200, rows[0]);
    }

    // POST /api/users (Create cashier or admin)
    if (pathname === '/api/users' && method === 'POST') {
      const body = await parseBody(req);
      const name = String(body.name || '').trim();
      const role = body.role === 'admin' ? 'admin' : 'cajero';
      const pin = String(body.pin || '').trim();

      if (!name || !pin) {
        return sendJson(res, 400, { error: 'Nombre y PIN son obligatorios' });
      }

      const rows = await query(
        `INSERT INTO users (name, role, pin)
         VALUES ($1, $2, $3)
         RETURNING id, name, role, pin, created_at`,
        [name, role, pin]
      );
      return sendJson(res, 201, rows[0]);
    }

    // PUT & DELETE /api/users/:id
    const userMatch = pathname.match(/^\/api\/users\/(\d+)$/);
    if (userMatch && method === 'PUT') {
      const id = Number(userMatch[1]);
      const body = await parseBody(req);
      const name = String(body.name || '').trim();
      const role = body.role === 'admin' ? 'admin' : 'cajero';
      const pin = String(body.pin || '').trim();

      const rows = await query(
        `UPDATE users
         SET name = $1, role = $2, pin = $3
         WHERE id = $4
         RETURNING id, name, role, pin, created_at`,
        [name, role, pin, id]
      );
      return sendJson(res, 200, rows[0]);
    }

    if (userMatch && method === 'DELETE') {
      const id = Number(userMatch[1]);
      await query('UPDATE users SET active = FALSE WHERE id = $1', [id]);
      return sendJson(res, 200, { ok: true });
    }

    // GET /api/products
    if (pathname === '/api/products' && method === 'GET') {
      const rows = await query(`
        SELECT id, name, category, price::float AS price, stock, is_service, created_at
        FROM products
        WHERE active = TRUE
        ORDER BY category ASC, name ASC
      `);
      return sendJson(res, 200, rows);
    }

    // POST /api/products
    if (pathname === '/api/products' && method === 'POST') {
      const body = await parseBody(req);
      const name = String(body.name || '').trim();
      const category = String(body.category || 'General').trim() || 'General';
      const price = Number(body.price || 0);
      const isService = Boolean(body.is_service);
      const stock = isService || body.stock === null || body.stock === '' ? null : Number(body.stock);

      if (!name) return sendJson(res, 400, { error: 'El nombre es obligatorio' });

      const rows = await query(
        `INSERT INTO products (name, category, price, stock, is_service)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, name, category, price::float AS price, stock, is_service, created_at`,
        [name, category, price, stock, isService]
      );
      return sendJson(res, 201, rows[0]);
    }

    // PUT & DELETE /api/products/:id
    const prodMatch = pathname.match(/^\/api\/products\/(\d+)$/);
    if (prodMatch && method === 'PUT') {
      const id = Number(prodMatch[1]);
      const body = await parseBody(req);
      const name = String(body.name || '').trim();
      const category = String(body.category || 'General').trim() || 'General';
      const price = Number(body.price || 0);
      const isService = Boolean(body.is_service);
      const stock = isService || body.stock === null || body.stock === '' ? null : Number(body.stock);

      const rows = await query(
        `UPDATE products
         SET name = $1, category = $2, price = $3, stock = $4, is_service = $5
         WHERE id = $6
         RETURNING id, name, category, price::float AS price, stock, is_service, created_at`,
        [name, category, price, stock, isService, id]
      );
      return sendJson(res, 200, rows[0]);
    }

    if (prodMatch && method === 'DELETE') {
      const id = Number(prodMatch[1]);
      await query('UPDATE products SET active = FALSE WHERE id = $1', [id]);
      return sendJson(res, 200, { ok: true });
    }

    // GET /api/sales?date=YYYY-MM-DD&cashier_id=123
    if (pathname === '/api/sales' && method === 'GET') {
      const dateParam = urlObj.searchParams.get('date');
      const cashierIdParam = urlObj.searchParams.get('cashier_id');

      let salesRows;
      if (dateParam && cashierIdParam && cashierIdParam !== 'all') {
        salesRows = await query(
          `SELECT id, total::float AS total, payment_method, amount_received::float AS amount_received,
                  change_given::float AS change_given, note, cashier_id, COALESCE(cashier_name, 'General') AS cashier_name, created_at
           FROM sales
           WHERE (created_at AT TIME ZONE 'America/Mexico_City')::date = $1::date
             AND cashier_id = $2
           ORDER BY created_at DESC`,
          [dateParam, Number(cashierIdParam)]
        );
      } else if (dateParam) {
        salesRows = await query(
          `SELECT id, total::float AS total, payment_method, amount_received::float AS amount_received,
                  change_given::float AS change_given, note, cashier_id, COALESCE(cashier_name, 'General') AS cashier_name, created_at
           FROM sales
           WHERE (created_at AT TIME ZONE 'America/Mexico_City')::date = $1::date
           ORDER BY created_at DESC`,
          [dateParam]
        );
      } else {
        salesRows = await query(
          `SELECT id, total::float AS total, payment_method, amount_received::float AS amount_received,
                  change_given::float AS change_given, note, cashier_id, COALESCE(cashier_name, 'General') AS cashier_name, created_at
           FROM sales
           ORDER BY created_at DESC
           LIMIT 100`
        );
      }

      if (salesRows.length === 0) {
        return sendJson(res, 200, []);
      }

      const saleIds = salesRows.map((s) => s.id);
      const itemsRows = await query(
        `SELECT id, sale_id, product_id, product_name, quantity, unit_price::float AS unit_price, subtotal::float AS subtotal
         FROM sale_items
         WHERE sale_id = ANY($1::int[])
         ORDER BY id ASC`,
        [saleIds]
      );

      const itemsBySale = {};
      for (const item of itemsRows) {
        if (!itemsBySale[item.sale_id]) itemsBySale[item.sale_id] = [];
        itemsBySale[item.sale_id].push(item);
      }

      const result = salesRows.map((s) => ({
        ...s,
        items: itemsBySale[s.id] || [],
      }));

      return sendJson(res, 200, result);
    }

    // POST /api/sales
    if (pathname === '/api/sales' && method === 'POST') {
      const body = await parseBody(req);
      const items = Array.isArray(body.items) ? body.items : [];
      if (items.length === 0) {
        return sendJson(res, 400, { error: 'El carrito está vacío' });
      }

      const paymentMethod = body.payment_method || 'efectivo';
      const total = items.reduce((acc, it) => acc + Number(it.unit_price) * Number(it.quantity), 0);
      const amountReceived = paymentMethod === 'efectivo' ? Number(body.amount_received ?? total) : total;
      const changeGiven = paymentMethod === 'efectivo' ? Math.max(0, amountReceived - total) : 0;
      const note = String(body.note || '').trim();
      const cashierId = body.cashier_id ? Number(body.cashier_id) : null;
      const cashierName = String(body.cashier_name || 'General').trim() || 'General';

      const saleRows = await query(
        `INSERT INTO sales (total, payment_method, amount_received, change_given, note, cashier_id, cashier_name)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, total::float AS total, payment_method, amount_received::float AS amount_received,
                   change_given::float AS change_given, note, cashier_id, cashier_name, created_at`,
        [total, paymentMethod, amountReceived, changeGiven, note, cashierId, cashierName]
      );
      const sale = saleRows[0];

      const insertedItems = [];
      for (const it of items) {
        const qty = Number(it.quantity) || 1;
        const unitPrice = Number(it.unit_price) || 0;
        const subtotal = qty * unitPrice;
        const productId = it.product_id ? Number(it.product_id) : null;

        const itemRow = await query(
          `INSERT INTO sale_items (sale_id, product_id, product_name, quantity, unit_price, subtotal)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id, sale_id, product_id, product_name, quantity, unit_price::float AS unit_price, subtotal::float AS subtotal`,
          [sale.id, productId, it.product_name, qty, unitPrice, subtotal]
        );
        insertedItems.push(itemRow[0]);

        if (productId) {
          await query(
            `UPDATE products
             SET stock = CASE WHEN is_service = FALSE AND stock IS NOT NULL THEN GREATEST(0, stock - $1) ELSE stock END
             WHERE id = $2`,
            [qty, productId]
          );
        }
      }

      return sendJson(res, 201, { ...sale, items: insertedItems });
    }

    // DELETE /api/sales/:id (Cancel sale and restore stock)
    const saleMatch = pathname.match(/^\/api\/sales\/(\d+)$/);
    if (saleMatch && method === 'DELETE') {
      const saleId = Number(saleMatch[1]);
      const items = await query('SELECT product_id, quantity FROM sale_items WHERE sale_id = $1', [saleId]);
      for (const it of items) {
        if (it.product_id) {
          await query(
            `UPDATE products
             SET stock = CASE WHEN is_service = FALSE AND stock IS NOT NULL THEN stock + $1 ELSE stock END
             WHERE id = $2`,
            [it.quantity, it.product_id]
          );
        }
      }
      await query('DELETE FROM sales WHERE id = $1', [saleId]);
      return sendJson(res, 200, { ok: true });
    }

    return sendJson(res, 404, { error: 'Ruta API no encontrada' });
  } catch (err) {
    console.error('API Error:', err);
    return sendJson(res, 500, { error: err.message || 'Error interno del servidor' });
  }
}

const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (urlObj.pathname.startsWith('/api/')) {
    return handleApi(req, res, urlObj);
  }

  let filePath = path.join(PUBLIC_DIR, urlObj.pathname === '/' ? 'index.html' : urlObj.pathname);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(PUBLIC_DIR, 'index.html');
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
});

async function start() {
  try {
    console.log('Conectando e inicializando tablas en Neon PostgreSQL...');
    await initDatabase();
    console.log('Base de datos Neon lista.');
  } catch (err) {
    console.error('Aviso al inicializar Neon:', err.message);
  }

  server.listen(PORT, () => {
    console.log(`Punto de Venta Web activo en: http://localhost:${PORT}`);
  });
}

start();
