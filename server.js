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
    if (pathname === '/api/health' && method === 'GET') {
      const rows = await query('SELECT NOW() AS server_time');
      return sendJson(res, 200, { ok: true, connected: true, serverTime: rows[0]?.server_time });
    }

    // USERS (Cashiers & Admins)
    if (pathname === '/api/users' && method === 'GET') {
      const rows = await query(`
        SELECT id, name, role, pin, created_at
        FROM users
        WHERE active = TRUE
        ORDER BY CASE WHEN role = 'admin' THEN 0 ELSE 1 END, name ASC
      `);
      return sendJson(res, 200, rows);
    }

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

    // PRODUCTS / SERVICES / SPECIAL SERVICES
    if (pathname === '/api/products' && method === 'GET') {
      const rows = await query(`
        SELECT id, name, category, price::float AS price, stock, is_service,
               COALESCE(product_type, CASE WHEN is_service THEN 'servicio' ELSE 'producto' END) AS product_type,
               free_after_sales, COALESCE(sales_counter, 0) AS sales_counter, created_at
        FROM products
        WHERE active = TRUE
        ORDER BY category ASC, name ASC
      `);
      return sendJson(res, 200, rows);
    }

    if (pathname === '/api/products' && method === 'POST') {
      const body = await parseBody(req);
      const name = String(body.name || '').trim();
      const category = String(body.category || 'General').trim() || 'General';
      const price = Number(body.price || 0);
      const productType = ['producto', 'servicio', 'servicio_especial'].includes(body.product_type)
        ? body.product_type
        : body.is_service
        ? 'servicio'
        : 'producto';
      const isService = productType !== 'producto';
      const stock = isService || body.stock === null || body.stock === '' ? null : Number(body.stock);
      const freeAfterSales =
        productType === 'servicio_especial' ? Math.max(1, Number(body.free_after_sales || 5)) : null;
      const salesCounter =
        productType === 'servicio_especial' ? Math.max(0, Number(body.sales_counter || 0)) : 0;

      if (!name) return sendJson(res, 400, { error: 'El nombre es obligatorio' });

      const rows = await query(
        `INSERT INTO products (name, category, price, stock, is_service, product_type, free_after_sales, sales_counter)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, name, category, price::float AS price, stock, is_service, product_type, free_after_sales, sales_counter, created_at`,
        [name, category, price, stock, isService, productType, freeAfterSales, salesCounter]
      );
      return sendJson(res, 201, rows[0]);
    }

    const prodMatch = pathname.match(/^\/api\/products\/(\d+)$/);
    if (prodMatch && method === 'PUT') {
      const id = Number(prodMatch[1]);
      const body = await parseBody(req);
      const name = String(body.name || '').trim();
      const category = String(body.category || 'General').trim() || 'General';
      const price = Number(body.price || 0);
      const productType = ['producto', 'servicio', 'servicio_especial'].includes(body.product_type)
        ? body.product_type
        : body.is_service
        ? 'servicio'
        : 'producto';
      const isService = productType !== 'producto';
      const stock = isService || body.stock === null || body.stock === '' ? null : Number(body.stock);
      const freeAfterSales =
        productType === 'servicio_especial' ? Math.max(1, Number(body.free_after_sales || 5)) : null;
      const salesCounter =
        productType === 'servicio_especial' ? Math.max(0, Number(body.sales_counter ?? 0)) : 0;

      const rows = await query(
        `UPDATE products
         SET name = $1, category = $2, price = $3, stock = $4, is_service = $5,
             product_type = $6, free_after_sales = $7, sales_counter = $8
         WHERE id = $9
         RETURNING id, name, category, price::float AS price, stock, is_service, product_type, free_after_sales, sales_counter, created_at`,
        [name, category, price, stock, isService, productType, freeAfterSales, salesCounter, id]
      );
      return sendJson(res, 200, rows[0]);
    }

    if (prodMatch && method === 'DELETE') {
      const id = Number(prodMatch[1]);
      await query('UPDATE products SET active = FALSE WHERE id = $1', [id]);
      return sendJson(res, 200, { ok: true });
    }

    // PROMOTIONS / COMBOS (Compra A + B = -$ descuento)
    if (pathname === '/api/promotions' && method === 'GET') {
      const rows = await query(`
        SELECT pr.id, pr.name, pr.product_a_id, pr.product_b_id,
               pr.discount_amount::float AS discount_amount, pr.active,
               pa.name AS product_a_name, pb.name AS product_b_name
        FROM promotions pr
        LEFT JOIN products pa ON pa.id = pr.product_a_id
        LEFT JOIN products pb ON pb.id = pr.product_b_id
        WHERE pr.active = TRUE
        ORDER BY pr.id DESC
      `);
      return sendJson(res, 200, rows);
    }

    if (pathname === '/api/promotions' && method === 'POST') {
      const body = await parseBody(req);
      const name = String(body.name || '').trim();
      const productAId = Number(body.product_a_id);
      const productBId = Number(body.product_b_id);
      const discountAmount = Number(body.discount_amount || 0);

      if (!name || !productAId || !productBId || discountAmount <= 0) {
        return sendJson(res, 400, { error: 'Datos de promoción incompletos' });
      }

      const rows = await query(
        `INSERT INTO promotions (name, product_a_id, product_b_id, discount_amount)
         VALUES ($1, $2, $3, $4)
         RETURNING id, name, product_a_id, product_b_id, discount_amount::float AS discount_amount, active`,
        [name, productAId, productBId, discountAmount]
      );
      return sendJson(res, 201, rows[0]);
    }

    const promoMatch = pathname.match(/^\/api\/promotions\/(\d+)$/);
    if (promoMatch && method === 'PUT') {
      const id = Number(promoMatch[1]);
      const body = await parseBody(req);
      const name = String(body.name || '').trim();
      const productAId = Number(body.product_a_id);
      const productBId = Number(body.product_b_id);
      const discountAmount = Number(body.discount_amount || 0);

      const rows = await query(
        `UPDATE promotions
         SET name = $1, product_a_id = $2, product_b_id = $3, discount_amount = $4
         WHERE id = $5
         RETURNING id, name, product_a_id, product_b_id, discount_amount::float AS discount_amount, active`,
        [name, productAId, productBId, discountAmount, id]
      );
      return sendJson(res, 200, rows[0]);
    }

    if (promoMatch && method === 'DELETE') {
      const id = Number(promoMatch[1]);
      await query('UPDATE promotions SET active = FALSE WHERE id = $1', [id]);
      return sendJson(res, 200, { ok: true });
    }

    // SALES
    if (pathname === '/api/sales' && method === 'GET') {
      const dateParam = urlObj.searchParams.get('date');
      const startDateParam = urlObj.searchParams.get('start_date') || dateParam;
      const endDateParam = urlObj.searchParams.get('end_date') || dateParam;
      const cashierIdParam = urlObj.searchParams.get('cashier_id');

      let salesRows;
      if (startDateParam && endDateParam && cashierIdParam && cashierIdParam !== 'all') {
        salesRows = await query(
          `SELECT id, COALESCE(subtotal, total)::float AS subtotal, COALESCE(discount_total, 0)::float AS discount_total,
                  COALESCE(promo_summary, '') AS promo_summary, total::float AS total, payment_method,
                  amount_received::float AS amount_received, change_given::float AS change_given,
                  note, cashier_id, COALESCE(cashier_name, 'General') AS cashier_name,
                  COALESCE(status, 'completada') AS status, COALESCE(refunded_total, 0)::float AS refunded_total,
                  cut_id, created_at
           FROM sales
           WHERE (created_at AT TIME ZONE 'America/Mexico_City')::date >= $1::date
             AND (created_at AT TIME ZONE 'America/Mexico_City')::date <= $2::date
             AND cashier_id = $3
           ORDER BY created_at DESC`,
          [startDateParam, endDateParam, Number(cashierIdParam)]
        );
      } else if (startDateParam && endDateParam) {
        salesRows = await query(
          `SELECT id, COALESCE(subtotal, total)::float AS subtotal, COALESCE(discount_total, 0)::float AS discount_total,
                  COALESCE(promo_summary, '') AS promo_summary, total::float AS total, payment_method,
                  amount_received::float AS amount_received, change_given::float AS change_given,
                  note, cashier_id, COALESCE(cashier_name, 'General') AS cashier_name,
                  COALESCE(status, 'completada') AS status, COALESCE(refunded_total, 0)::float AS refunded_total,
                  cut_id, created_at
           FROM sales
           WHERE (created_at AT TIME ZONE 'America/Mexico_City')::date >= $1::date
             AND (created_at AT TIME ZONE 'America/Mexico_City')::date <= $2::date
           ORDER BY created_at DESC`,
          [startDateParam, endDateParam]
        );
      } else {
        salesRows = await query(
          `SELECT id, COALESCE(subtotal, total)::float AS subtotal, COALESCE(discount_total, 0)::float AS discount_total,
                  COALESCE(promo_summary, '') AS promo_summary, total::float AS total, payment_method,
                  amount_received::float AS amount_received, change_given::float AS change_given,
                  note, cashier_id, COALESCE(cashier_name, 'General') AS cashier_name,
                  COALESCE(status, 'completada') AS status, COALESCE(refunded_total, 0)::float AS refunded_total,
                  cut_id, created_at
           FROM sales
           ORDER BY created_at DESC
           LIMIT 500`
        );
      }

      if (salesRows.length === 0) {
        return sendJson(res, 200, []);
      }

      const saleIds = salesRows.map((s) => s.id);
      const itemsRows = await query(
        `SELECT id, sale_id, product_id, product_name, quantity, COALESCE(returned_qty, 0) AS returned_qty,
                unit_price::float AS unit_price, subtotal::float AS subtotal, COALESCE(is_free_reward, FALSE) AS is_free_reward
         FROM sale_items
         WHERE sale_id = ANY($1::int[])
         ORDER BY id ASC`,
        [saleIds]
      );

      const returnsRows = await query(
        `SELECT id, sale_id, refund_amount::float AS refund_amount, reason, return_to_stock,
                items_summary, processed_by_name, authorized_by_name, created_at
         FROM sale_returns
         WHERE sale_id = ANY($1::int[])
         ORDER BY created_at ASC`,
        [saleIds]
      );

      const itemsBySale = {};
      for (const item of itemsRows) {
        if (!itemsBySale[item.sale_id]) itemsBySale[item.sale_id] = [];
        itemsBySale[item.sale_id].push(item);
      }

      const returnsBySale = {};
      for (const ret of returnsRows) {
        if (!returnsBySale[ret.sale_id]) returnsBySale[ret.sale_id] = [];
        returnsBySale[ret.sale_id].push(ret);
      }

      const result = salesRows.map((s) => ({
        ...s,
        items: itemsBySale[s.id] || [],
        returns: returnsBySale[s.id] || [],
      }));

      return sendJson(res, 200, result);
    }

    if (pathname === '/api/sales' && method === 'POST') {
      const body = await parseBody(req);
      const items = Array.isArray(body.items) ? body.items : [];
      if (items.length === 0) {
        return sendJson(res, 400, { error: 'El carrito está vacío' });
      }

      const paymentMethod = body.payment_method || 'efectivo';
      const subtotal = items.reduce((acc, it) => acc + Number(it.subtotal ?? Number(it.unit_price) * Number(it.quantity)), 0);
      const discountTotal = Math.max(0, Number(body.discount_total || 0));
      const promoSummary = String(body.promo_summary || '').trim();
      const total = Math.max(0, subtotal - discountTotal);
      const amountReceived = paymentMethod === 'efectivo' ? Number(body.amount_received ?? total) : total;
      const changeGiven = paymentMethod === 'efectivo' ? Math.max(0, amountReceived - total) : 0;
      const note = String(body.note || '').trim();
      const cashierId = body.cashier_id ? Number(body.cashier_id) : null;
      const cashierName = String(body.cashier_name || 'General').trim() || 'General';

      const saleRows = await query(
        `INSERT INTO sales (subtotal, discount_total, promo_summary, total, payment_method, amount_received, change_given, note, cashier_id, cashier_name, status, refunded_total)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'completada', 0)
         RETURNING id, subtotal::float AS subtotal, discount_total::float AS discount_total, promo_summary,
                   total::float AS total, payment_method, amount_received::float AS amount_received,
                   change_given::float AS change_given, note, cashier_id, cashier_name, status, refunded_total::float AS refunded_total, created_at`,
        [subtotal, discountTotal, promoSummary, total, paymentMethod, amountReceived, changeGiven, note, cashierId, cashierName]
      );
      const sale = saleRows[0];

      const insertedItems = [];
      for (const it of items) {
        const qty = Number(it.quantity) || 1;
        const unitPrice = Number(it.unit_price) || 0;
        const itemSubtotal = Number(it.subtotal ?? qty * unitPrice);
        const productId = it.product_id ? Number(it.product_id) : null;
        const isFreeReward = Boolean(it.is_free_reward);

        const itemRow = await query(
          `INSERT INTO sale_items (sale_id, product_id, product_name, quantity, returned_qty, unit_price, subtotal, is_free_reward)
           VALUES ($1, $2, $3, $4, 0, $5, $6, $7)
           RETURNING id, sale_id, product_id, product_name, quantity, returned_qty, unit_price::float AS unit_price, subtotal::float AS subtotal, is_free_reward`,
          [sale.id, productId, it.product_name, qty, unitPrice, itemSubtotal, isFreeReward]
        );
        insertedItems.push(itemRow[0]);

        if (productId) {
          // Descontar stock si es producto físico y avanzar contador si es servicio_especial
          const prodRows = await query(
            'SELECT product_type, is_service, stock, free_after_sales, COALESCE(sales_counter, 0) AS sales_counter FROM products WHERE id = $1',
            [productId]
          );
          if (prodRows[0]) {
            const p = prodRows[0];
            if (p.product_type === 'servicio_especial' && p.free_after_sales > 0) {
              const cycle = Number(p.free_after_sales) + 1;
              const nextCounter = (Number(p.sales_counter) + qty) % cycle;
              await query('UPDATE products SET sales_counter = $1 WHERE id = $2', [nextCounter, productId]);
            } else if (!p.is_service && p.product_type === 'producto' && p.stock !== null) {
              await query('UPDATE products SET stock = GREATEST(0, stock - $1) WHERE id = $2', [qty, productId]);
            }
          }
        }
      }

      return sendJson(res, 201, { ...sale, items: insertedItems, returns: [] });
    }

    // DEVOLUCIÓN PARCIAL O TOTAL DE VENTA (CON MOTIVO, MERMA/STOCK Y PIN DE ADMIN)
    const saleReturnMatch = pathname.match(/^\/api\/sales\/(\d+)\/return$/);
    if (saleReturnMatch && method === 'POST') {
      const saleId = Number(saleReturnMatch[1]);
      const body = await parseBody(req);
      const returnItems = Array.isArray(body.items) ? body.items : [];
      const reason = String(body.reason || '').trim();
      const refundAmount = Math.max(0, Number(body.refund_amount || 0));
      const processedByName = String(body.processed_by_name || 'General').trim();
      let authorizedByName = String(body.authorized_by_name || '').trim();
      const isAdminSession = Boolean(body.is_admin_session);
      const adminPin = String(body.admin_pin || '').trim();

      if (!reason) {
        return sendJson(res, 400, { error: 'El motivo de la devolución es obligatorio' });
      }

      if (!isAdminSession) {
        if (!adminPin) {
          return sendJson(res, 401, { error: 'Se requiere el PIN de un Administrador para autorizar la devolución' });
        }
        const adminRows = await query(
          "SELECT id, name FROM users WHERE role = 'admin' AND pin = $1 AND active = TRUE LIMIT 1",
          [adminPin]
        );
        if (adminRows.length === 0) {
          return sendJson(res, 401, { error: 'PIN de Administrador incorrecto' });
        }
        authorizedByName = adminRows[0].name;
      } else if (!authorizedByName) {
        authorizedByName = processedByName;
      }

      const summaryParts = [];
      let anyToStock = false;

      for (const reqItem of returnItems) {
        const retQty = Number(reqItem.return_qty || 0);
        if (retQty <= 0) continue;

        const saleItemId = Number(reqItem.sale_item_id);
        const returnToStock = Boolean(reqItem.return_to_stock);
        if (returnToStock) anyToStock = true;

        const dbItemRows = await query(
          'SELECT id, product_id, product_name, quantity, COALESCE(returned_qty, 0) AS returned_qty FROM sale_items WHERE id = $1 AND sale_id = $2',
          [saleItemId, saleId]
        );
        if (!dbItemRows[0]) continue;
        const dbItem = dbItemRows[0];
        const availableQty = Math.max(0, Number(dbItem.quantity) - Number(dbItem.returned_qty));
        const effectiveRetQty = Math.min(retQty, availableQty);
        if (effectiveRetQty <= 0) continue;

        await query(
          'UPDATE sale_items SET returned_qty = COALESCE(returned_qty, 0) + $1 WHERE id = $2',
          [effectiveRetQty, saleItemId]
        );

        let destinoTag = '';
        if (dbItem.product_id) {
          const prodRows = await query(
            'SELECT product_type, is_service, stock, free_after_sales, COALESCE(sales_counter, 0) AS sales_counter FROM products WHERE id = $1',
            [dbItem.product_id]
          );
          if (prodRows[0]) {
            const p = prodRows[0];
            if (p.product_type === 'servicio_especial' && p.free_after_sales > 0) {
              const cycle = Number(p.free_after_sales) + 1;
              const prevCounter = (Number(p.sales_counter) - effectiveRetQty + cycle * 10) % cycle;
              await query('UPDATE products SET sales_counter = $1 WHERE id = $2', [prevCounter, dbItem.product_id]);
              destinoTag = ' (contador revertido)';
            } else if (!p.is_service && p.stock !== null) {
              if (returnToStock) {
                await query('UPDATE products SET stock = stock + $1 WHERE id = $2', [effectiveRetQty, dbItem.product_id]);
                destinoTag = ' (a stock)';
              } else {
                destinoTag = ' (merma/dañado)';
              }
            }
          }
        }

        summaryParts.push(`${effectiveRetQty}x ${dbItem.product_name}${destinoTag}`);
      }

      if (summaryParts.length === 0) {
        return sendJson(res, 400, { error: 'Selecciona al menos una unidad para devolver' });
      }

      const itemsSummary = summaryParts.join(', ');

      await query(
        `INSERT INTO sale_returns (sale_id, refund_amount, reason, return_to_stock, items_summary, processed_by_name, authorized_by_name)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [saleId, refundAmount, reason, anyToStock, itemsSummary, processedByName, authorizedByName]
      );

      // Evaluar si la venta quedó devuelta parcial o totalmente
      const allSaleItems = await query(
        'SELECT quantity, COALESCE(returned_qty, 0) AS returned_qty FROM sale_items WHERE sale_id = $1',
        [saleId]
      );
      const allReturned = allSaleItems.every((it) => Number(it.returned_qty) >= Number(it.quantity));
      const newStatus = allReturned ? 'devuelta_total' : 'devuelta_parcial';

      await query(
        `UPDATE sales
         SET refunded_total = LEAST(total, COALESCE(refunded_total, 0) + $1),
             status = $2
         WHERE id = $3`,
        [refundAmount, newStatus, saleId]
      );

      return sendJson(res, 200, {
        ok: true,
        status: newStatus,
        authorized_by_name: authorizedByName,
        items_summary: itemsSummary,
      });
    }

    const saleMatch = pathname.match(/^\/api\/sales\/(\d+)$/);
    if (saleMatch && method === 'DELETE') {
      const saleId = Number(saleMatch[1]);
      const items = await query('SELECT product_id, quantity FROM sale_items WHERE sale_id = $1', [saleId]);
      for (const it of items) {
        if (it.product_id) {
          const prodRows = await query(
            'SELECT product_type, is_service, stock, free_after_sales, COALESCE(sales_counter, 0) AS sales_counter FROM products WHERE id = $1',
            [it.product_id]
          );
          if (prodRows[0]) {
            const p = prodRows[0];
            if (p.product_type === 'servicio_especial' && p.free_after_sales > 0) {
              const cycle = Number(p.free_after_sales) + 1;
              const prevCounter = (Number(p.sales_counter) - Number(it.quantity) + cycle * 10) % cycle;
              await query('UPDATE products SET sales_counter = $1 WHERE id = $2', [prevCounter, it.product_id]);
            } else if (!p.is_service && p.stock !== null) {
              await query('UPDATE products SET stock = stock + $1 WHERE id = $2', [it.quantity, it.product_id]);
            }
          }
        }
      }
      await query('DELETE FROM sales WHERE id = $1', [saleId]);
      return sendJson(res, 200, { ok: true });
    }

    // CORTES DE CAJA / CIERRES DE TURNO
    if (pathname === '/api/cash-cuts' && method === 'GET') {
      const startDateParam = urlObj.searchParams.get('start_date');
      const endDateParam = urlObj.searchParams.get('end_date') || startDateParam;
      const cashierIdParam = urlObj.searchParams.get('cashier_id');

      let cutRows;
      if (startDateParam && endDateParam && cashierIdParam && cashierIdParam !== 'all') {
        cutRows = await query(
          `SELECT id, cashier_id, cashier_name, sales_count, gross_sales::float AS gross_sales,
                  refunded_total::float AS refunded_total, net_sales::float AS net_sales,
                  expected_cash::float AS expected_cash, counted_cash::float AS counted_cash,
                  cash_difference::float AS cash_difference, card_sales::float AS card_sales,
                  transfer_sales::float AS transfer_sales, note, created_at
           FROM cash_cuts
           WHERE (created_at AT TIME ZONE 'America/Mexico_City')::date >= $1::date
             AND (created_at AT TIME ZONE 'America/Mexico_City')::date <= $2::date
             AND cashier_id = $3
           ORDER BY created_at DESC`,
          [startDateParam, endDateParam, Number(cashierIdParam)]
        );
      } else if (startDateParam && endDateParam) {
        cutRows = await query(
          `SELECT id, cashier_id, cashier_name, sales_count, gross_sales::float AS gross_sales,
                  refunded_total::float AS refunded_total, net_sales::float AS net_sales,
                  expected_cash::float AS expected_cash, counted_cash::float AS counted_cash,
                  cash_difference::float AS cash_difference, card_sales::float AS card_sales,
                  transfer_sales::float AS transfer_sales, note, created_at
           FROM cash_cuts
           WHERE (created_at AT TIME ZONE 'America/Mexico_City')::date >= $1::date
             AND (created_at AT TIME ZONE 'America/Mexico_City')::date <= $2::date
           ORDER BY created_at DESC`,
          [startDateParam, endDateParam]
        );
      } else {
        cutRows = await query(
          `SELECT id, cashier_id, cashier_name, sales_count, gross_sales::float AS gross_sales,
                  refunded_total::float AS refunded_total, net_sales::float AS net_sales,
                  expected_cash::float AS expected_cash, counted_cash::float AS counted_cash,
                  cash_difference::float AS cash_difference, card_sales::float AS card_sales,
                  transfer_sales::float AS transfer_sales, note, created_at
           FROM cash_cuts
           ORDER BY created_at DESC
           LIMIT 100`
        );
      }
      return sendJson(res, 200, cutRows);
    }

    if (pathname === '/api/cash-cuts' && method === 'POST') {
      const body = await parseBody(req);
      const cashierId = body.cashier_id ? Number(body.cashier_id) : null;
      const cashierName = String(body.cashier_name || 'General').trim();
      const salesCount = Number(body.sales_count || 0);
      const grossSales = Number(body.gross_sales || 0);
      const refundedTotal = Number(body.refunded_total || 0);
      const netSales = Number(body.net_sales || 0);
      const expectedCash = Number(body.expected_cash || 0);
      const countedCash = Number(body.counted_cash ?? expectedCash);
      const cashDifference = Number((countedCash - expectedCash).toFixed(2));
      const cardSales = Number(body.card_sales || 0);
      const transferSales = Number(body.transfer_sales || 0);
      const note = String(body.note || '').trim();
      const saleIds = Array.isArray(body.sale_ids)
        ? body.sale_ids.map(Number).filter((n) => Number.isInteger(n) && n > 0)
        : [];

      const rows = await query(
        `INSERT INTO cash_cuts (
           cashier_id, cashier_name, sales_count, gross_sales, refunded_total,
           net_sales, expected_cash, counted_cash, cash_difference, card_sales, transfer_sales, note
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING id, cashier_id, cashier_name, sales_count, gross_sales::float AS gross_sales,
                   refunded_total::float AS refunded_total, net_sales::float AS net_sales,
                   expected_cash::float AS expected_cash, counted_cash::float AS counted_cash,
                   cash_difference::float AS cash_difference, card_sales::float AS card_sales,
                   transfer_sales::float AS transfer_sales, note, created_at`,
        [
          cashierId,
          cashierName,
          salesCount,
          grossSales,
          refundedTotal,
          netSales,
          expectedCash,
          countedCash,
          cashDifference,
          cardSales,
          transferSales,
          note,
        ]
      );
      const cut = rows[0];

      if (saleIds.length > 0) {
        await query('UPDATE sales SET cut_id = $1 WHERE id = ANY($2::int[])', [cut.id, saleIds]);
      }

      return sendJson(res, 201, cut);
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
