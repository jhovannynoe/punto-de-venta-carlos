// Conexión directa a Neon Serverless HTTP API (para APK Android y modo directo) + API local
const NEON_CONN_STR =
  'postgresql://neondb_owner:npg_v80ptgIKUSzN@ep-billowing-shape-bex6iinx-pooler.c-9.us-east-2.aws.neon.tech/neondb?sslmode=require';
const NEON_HTTP_URL =
  'https://ep-billowing-shape-bex6iinx-pooler.c-9.us-east-2.aws.neon.tech/sql';

async function neonQuery(sqlText, params = []) {
  const res = await fetch(NEON_HTTP_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Neon-Connection-String': NEON_CONN_STR,
      'Neon-Raw-Text-Output': 'false',
      'Neon-Array-Mode': 'false',
    },
    body: JSON.stringify({ query: sqlText, params }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Error Neon (${res.status}): ${errText}`);
  }
  const data = await res.json();
  return data.rows || [];
}

async function ensureNeonSchemaDirect() {
  await neonQuery(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'cajero',
      pin TEXT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await neonQuery(`
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
  await neonQuery(`ALTER TABLE products ADD COLUMN IF NOT EXISTS product_type TEXT NOT NULL DEFAULT 'producto';`);
  await neonQuery(`ALTER TABLE products ADD COLUMN IF NOT EXISTS free_after_sales INTEGER DEFAULT NULL;`);
  await neonQuery(`ALTER TABLE products ADD COLUMN IF NOT EXISTS sales_counter INTEGER NOT NULL DEFAULT 0;`);

  await neonQuery(`
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

  await neonQuery(`
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
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await neonQuery(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS subtotal NUMERIC(10, 2) NOT NULL DEFAULT 0;`);
  await neonQuery(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS discount_total NUMERIC(10, 2) NOT NULL DEFAULT 0;`);
  await neonQuery(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS promo_summary TEXT DEFAULT '';`);
  await neonQuery(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS cashier_id INTEGER;`);
  await neonQuery(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS cashier_name TEXT DEFAULT 'General';`);

  await neonQuery(`
    CREATE TABLE IF NOT EXISTS sale_items (
      id SERIAL PRIMARY KEY,
      sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
      product_id INTEGER,
      product_name TEXT NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 1,
      unit_price NUMERIC(10, 2) NOT NULL,
      subtotal NUMERIC(10, 2) NOT NULL,
      is_free_reward BOOLEAN NOT NULL DEFAULT FALSE
    );
  `);
  await neonQuery(`ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS is_free_reward BOOLEAN NOT NULL DEFAULT FALSE;`);
}

// Capa de datos unificada (Servidor Web o Directo a Neon desde APK)
const DataService = {
  useDirectNeon: false,

  async init() {
    if (window.location.protocol === 'file:' || window.Capacitor) {
      this.useDirectNeon = true;
      await ensureNeonSchemaDirect();
      return { mode: 'Neon Cloud (Directo APK)' };
    }
    try {
      const res = await fetch('/api/health');
      if (res.ok) {
        this.useDirectNeon = false;
        return { mode: 'Neon Cloud (Servidor Web)' };
      }
    } catch {
      // Fallback directo a Neon HTTP
    }
    this.useDirectNeon = true;
    await ensureNeonSchemaDirect();
    return { mode: 'Neon Cloud (Directo)' };
  },

  async getUsers() {
    if (!this.useDirectNeon) {
      const res = await fetch('/api/users');
      if (res.ok) return res.json();
    }
    return await neonQuery(`
      SELECT id, name, role, pin, created_at
      FROM users
      WHERE active = TRUE
      ORDER BY CASE WHEN role = 'admin' THEN 0 ELSE 1 END, name ASC
    `);
  },

  async verifyPin(userId, pin) {
    if (!this.useDirectNeon) {
      const res = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: userId, pin }),
      });
      if (res.ok) return res.json();
      if (res.status === 401) throw new Error('PIN incorrecto');
    }
    const rows = await neonQuery(
      'SELECT id, name, role FROM users WHERE id = $1 AND pin = $2 AND active = TRUE',
      [Number(userId), String(pin).trim()]
    );
    if (rows.length === 0) throw new Error('PIN incorrecto');
    return rows[0];
  },

  async saveUser(userObj) {
    const role = userObj.role === 'admin' ? 'admin' : 'cajero';
    if (!this.useDirectNeon) {
      const url = userObj.id ? `/api/users/${userObj.id}` : '/api/users';
      const method = userObj.id ? 'PUT' : 'POST';
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...userObj, role }),
      });
      if (res.ok) return res.json();
    }
    if (userObj.id) {
      const rows = await neonQuery(
        'UPDATE users SET name = $1, role = $2, pin = $3 WHERE id = $4 RETURNING id, name, role, pin',
        [userObj.name, role, userObj.pin, Number(userObj.id)]
      );
      return rows[0];
    } else {
      const rows = await neonQuery(
        'INSERT INTO users (name, role, pin) VALUES ($1, $2, $3) RETURNING id, name, role, pin',
        [userObj.name, role, userObj.pin]
      );
      return rows[0];
    }
  },

  async deleteUser(id) {
    if (!this.useDirectNeon) {
      const res = await fetch(`/api/users/${id}`, { method: 'DELETE' });
      if (res.ok) return true;
    }
    await neonQuery('UPDATE users SET active = FALSE WHERE id = $1', [Number(id)]);
    return true;
  },

  async getProducts() {
    if (!this.useDirectNeon) {
      const res = await fetch('/api/products');
      if (res.ok) return res.json();
    }
    const rows = await neonQuery(`
      SELECT id, name, category, price::float AS price, stock, is_service,
             COALESCE(product_type, CASE WHEN is_service THEN 'servicio' ELSE 'producto' END) AS product_type,
             free_after_sales, COALESCE(sales_counter, 0) AS sales_counter, created_at
      FROM products
      WHERE active = TRUE
      ORDER BY category ASC, name ASC
    `);
    return rows.map((r) => ({
      ...r,
      price: Number(r.price),
      stock: r.stock !== null ? Number(r.stock) : null,
      free_after_sales: r.free_after_sales !== null ? Number(r.free_after_sales) : null,
      sales_counter: Number(r.sales_counter || 0),
    }));
  },

  async saveProduct(prod) {
    const productType = ['producto', 'servicio', 'servicio_especial'].includes(prod.product_type)
      ? prod.product_type
      : prod.is_service
      ? 'servicio'
      : 'producto';
    const isService = productType !== 'producto';
    const stock = isService || prod.stock === null || prod.stock === '' ? null : Number(prod.stock);
    const freeAfterSales =
      productType === 'servicio_especial' ? Math.max(1, Number(prod.free_after_sales || 5)) : null;
    const salesCounter =
      productType === 'servicio_especial' ? Math.max(0, Number(prod.sales_counter ?? 0)) : 0;

    const payload = {
      ...prod,
      product_type: productType,
      is_service: isService,
      stock,
      free_after_sales: freeAfterSales,
      sales_counter: salesCounter,
    };

    if (!this.useDirectNeon) {
      const url = prod.id ? `/api/products/${prod.id}` : '/api/products';
      const method = prod.id ? 'PUT' : 'POST';
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.ok) return res.json();
    }
    if (prod.id) {
      const rows = await neonQuery(
        `UPDATE products
         SET name = $1, category = $2, price = $3, stock = $4, is_service = $5,
             product_type = $6, free_after_sales = $7, sales_counter = $8
         WHERE id = $9
         RETURNING id, name, category, price::float AS price, stock, is_service, product_type, free_after_sales, sales_counter`,
        [
          prod.name,
          prod.category || 'General',
          Number(prod.price),
          stock,
          isService,
          productType,
          freeAfterSales,
          salesCounter,
          Number(prod.id),
        ]
      );
      return rows[0];
    } else {
      const rows = await neonQuery(
        `INSERT INTO products (name, category, price, stock, is_service, product_type, free_after_sales, sales_counter)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, name, category, price::float AS price, stock, is_service, product_type, free_after_sales, sales_counter`,
        [
          prod.name,
          prod.category || 'General',
          Number(prod.price),
          stock,
          isService,
          productType,
          freeAfterSales,
          salesCounter,
        ]
      );
      return rows[0];
    }
  },

  async deleteProduct(id) {
    if (!this.useDirectNeon) {
      const res = await fetch(`/api/products/${id}`, { method: 'DELETE' });
      if (res.ok) return true;
    }
    await neonQuery('UPDATE products SET active = FALSE WHERE id = $1', [Number(id)]);
    return true;
  },

  async getPromotions() {
    if (!this.useDirectNeon) {
      const res = await fetch('/api/promotions');
      if (res.ok) return res.json();
    }
    const rows = await neonQuery(`
      SELECT pr.id, pr.name, pr.product_a_id, pr.product_b_id,
             pr.discount_amount::float AS discount_amount, pr.active,
             pa.name AS product_a_name, pb.name AS product_b_name
      FROM promotions pr
      LEFT JOIN products pa ON pa.id = pr.product_a_id
      LEFT JOIN products pb ON pb.id = pr.product_b_id
      WHERE pr.active = TRUE
      ORDER BY pr.id DESC
    `);
    return rows.map((r) => ({ ...r, discount_amount: Number(r.discount_amount) }));
  },

  async savePromotion(promo) {
    if (!this.useDirectNeon) {
      const url = promo.id ? `/api/promotions/${promo.id}` : '/api/promotions';
      const method = promo.id ? 'PUT' : 'POST';
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(promo),
      });
      if (res.ok) return res.json();
    }
    if (promo.id) {
      const rows = await neonQuery(
        `UPDATE promotions
         SET name = $1, product_a_id = $2, product_b_id = $3, discount_amount = $4
         WHERE id = $5
         RETURNING id, name, product_a_id, product_b_id, discount_amount::float AS discount_amount`,
        [promo.name, Number(promo.product_a_id), Number(promo.product_b_id), Number(promo.discount_amount), Number(promo.id)]
      );
      return rows[0];
    } else {
      const rows = await neonQuery(
        `INSERT INTO promotions (name, product_a_id, product_b_id, discount_amount)
         VALUES ($1, $2, $3, $4)
         RETURNING id, name, product_a_id, product_b_id, discount_amount::float AS discount_amount`,
        [promo.name, Number(promo.product_a_id), Number(promo.product_b_id), Number(promo.discount_amount)]
      );
      return rows[0];
    }
  },

  async deletePromotion(id) {
    if (!this.useDirectNeon) {
      const res = await fetch(`/api/promotions/${id}`, { method: 'DELETE' });
      if (res.ok) return true;
    }
    await neonQuery('UPDATE promotions SET active = FALSE WHERE id = $1', [Number(id)]);
    return true;
  },

  async createSale(salePayload) {
    if (!this.useDirectNeon) {
      const res = await fetch('/api/sales', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(salePayload),
      });
      if (res.ok) return res.json();
    }
    const items = salePayload.items || [];
    const subtotal = items.reduce((acc, it) => acc + Number(it.subtotal ?? Number(it.unit_price) * Number(it.quantity)), 0);
    const discountTotal = Math.max(0, Number(salePayload.discount_total || 0));
    const promoSummary = String(salePayload.promo_summary || '').trim();
    const total = Math.max(0, subtotal - discountTotal);
    const paymentMethod = salePayload.payment_method || 'efectivo';
    const amountReceived = paymentMethod === 'efectivo' ? Number(salePayload.amount_received ?? total) : total;
    const changeGiven = paymentMethod === 'efectivo' ? Math.max(0, amountReceived - total) : 0;
    const note = String(salePayload.note || '').trim();
    const cashierId = salePayload.cashier_id ? Number(salePayload.cashier_id) : null;
    const cashierName = String(salePayload.cashier_name || 'General').trim();

    const saleRows = await neonQuery(
      `INSERT INTO sales (subtotal, discount_total, promo_summary, total, payment_method, amount_received, change_given, note, cashier_id, cashier_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id, subtotal::float AS subtotal, discount_total::float AS discount_total, promo_summary,
                 total::float AS total, payment_method, amount_received::float AS amount_received,
                 change_given::float AS change_given, note, cashier_id, cashier_name, created_at`,
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

      const itemRow = await neonQuery(
        `INSERT INTO sale_items (sale_id, product_id, product_name, quantity, unit_price, subtotal, is_free_reward)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, sale_id, product_id, product_name, quantity, unit_price::float AS unit_price, subtotal::float AS subtotal, is_free_reward`,
        [sale.id, productId, it.product_name, qty, unitPrice, itemSubtotal, isFreeReward]
      );
      insertedItems.push(itemRow[0]);

      if (productId) {
        const prodRows = await neonQuery(
          'SELECT product_type, is_service, stock, free_after_sales, COALESCE(sales_counter, 0) AS sales_counter FROM products WHERE id = $1',
          [productId]
        );
        if (prodRows[0]) {
          const p = prodRows[0];
          if (p.product_type === 'servicio_especial' && p.free_after_sales > 0) {
            const cycle = Number(p.free_after_sales) + 1;
            const nextCounter = (Number(p.sales_counter) + qty) % cycle;
            await neonQuery('UPDATE products SET sales_counter = $1 WHERE id = $2', [nextCounter, productId]);
          } else if (!p.is_service && p.product_type === 'producto' && p.stock !== null) {
            await neonQuery('UPDATE products SET stock = GREATEST(0, stock - $1) WHERE id = $2', [qty, productId]);
          }
        }
      }
    }
    return { ...sale, items: insertedItems };
  },

  async getSales(dateStr, cashierId = 'all') {
    if (!this.useDirectNeon) {
      const params = new URLSearchParams();
      if (dateStr) params.set('date', dateStr);
      if (cashierId && cashierId !== 'all') params.set('cashier_id', cashierId);
      const res = await fetch(`/api/sales?${params.toString()}`);
      if (res.ok) return res.json();
    }
    let salesRows;
    if (dateStr && cashierId && cashierId !== 'all') {
      salesRows = await neonQuery(
        `SELECT id, COALESCE(subtotal, total)::float AS subtotal, COALESCE(discount_total, 0)::float AS discount_total,
                COALESCE(promo_summary, '') AS promo_summary, total::float AS total, payment_method,
                amount_received::float AS amount_received, change_given::float AS change_given,
                note, cashier_id, COALESCE(cashier_name, 'General') AS cashier_name, created_at
         FROM sales
         WHERE (created_at AT TIME ZONE 'America/Mexico_City')::date = $1::date
           AND cashier_id = $2
         ORDER BY created_at DESC`,
        [dateStr, Number(cashierId)]
      );
    } else if (dateStr) {
      salesRows = await neonQuery(
        `SELECT id, COALESCE(subtotal, total)::float AS subtotal, COALESCE(discount_total, 0)::float AS discount_total,
                COALESCE(promo_summary, '') AS promo_summary, total::float AS total, payment_method,
                amount_received::float AS amount_received, change_given::float AS change_given,
                note, cashier_id, COALESCE(cashier_name, 'General') AS cashier_name, created_at
         FROM sales
         WHERE (created_at AT TIME ZONE 'America/Mexico_City')::date = $1::date
         ORDER BY created_at DESC`,
        [dateStr]
      );
    } else {
      salesRows = await neonQuery(
        `SELECT id, COALESCE(subtotal, total)::float AS subtotal, COALESCE(discount_total, 0)::float AS discount_total,
                COALESCE(promo_summary, '') AS promo_summary, total::float AS total, payment_method,
                amount_received::float AS amount_received, change_given::float AS change_given,
                note, cashier_id, COALESCE(cashier_name, 'General') AS cashier_name, created_at
         FROM sales
         ORDER BY created_at DESC
         LIMIT 100`
      );
    }
    if (salesRows.length === 0) return [];
    const saleIds = salesRows.map((s) => Number(s.id));
    const itemsRows = await neonQuery(
      `SELECT id, sale_id, product_id, product_name, quantity, unit_price::float AS unit_price,
              subtotal::float AS subtotal, COALESCE(is_free_reward, FALSE) AS is_free_reward
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
    return salesRows.map((s) => ({
      ...s,
      subtotal: Number(s.subtotal),
      discount_total: Number(s.discount_total || 0),
      total: Number(s.total),
      amount_received: Number(s.amount_received),
      change_given: Number(s.change_given),
      items: itemsBySale[s.id] || [],
    }));
  },

  async deleteSale(saleId) {
    if (!this.useDirectNeon) {
      const res = await fetch(`/api/sales/${saleId}`, { method: 'DELETE' });
      if (res.ok) return true;
    }
    const items = await neonQuery('SELECT product_id, quantity FROM sale_items WHERE sale_id = $1', [Number(saleId)]);
    for (const it of items) {
      if (it.product_id) {
        const prodRows = await neonQuery(
          'SELECT product_type, is_service, stock, free_after_sales, COALESCE(sales_counter, 0) AS sales_counter FROM products WHERE id = $1',
          [Number(it.product_id)]
        );
        if (prodRows[0]) {
          const p = prodRows[0];
          if (p.product_type === 'servicio_especial' && p.free_after_sales > 0) {
            const cycle = Number(p.free_after_sales) + 1;
            const prevCounter = (Number(p.sales_counter) - Number(it.quantity) + cycle * 10) % cycle;
            await neonQuery('UPDATE products SET sales_counter = $1 WHERE id = $2', [prevCounter, Number(it.product_id)]);
          } else if (!p.is_service && p.stock !== null) {
            await neonQuery('UPDATE products SET stock = stock + $1 WHERE id = $2', [Number(it.quantity), Number(it.product_id)]);
          }
        }
      }
    }
    await neonQuery('DELETE FROM sales WHERE id = $1', [Number(saleId)]);
    return true;
  },
};

// Estado de la aplicación
const state = {
  users: [],
  currentUser: null,
  selectedLoginUser: null,
  products: [],
  promotions: [],
  cart: [],
  sales: [],
  selectedCategory: 'Todos',
  searchQuery: '',
  catalogFilter: '',
  paymentMethod: 'efectivo',
  selectedDate: getTodayLocalISO(),
  selectedCashierFilter: 'all',
};

function getTodayLocalISO() {
  const now = new Date();
  const offsetMs = now.getTimezoneOffset() * 60000;
  return new Date(now.getTime() - offsetMs).toISOString().slice(0, 10);
}

function formatMoney(num) {
  return '$' + Number(num || 0).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function showToast(msg) {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ==========================================
// CÁLCULO DE SERVICIO ESPECIAL Y PROMOCIONES (A + B)
// ==========================================
function calculateSpecialServicePricing(prod, quantity) {
  const unitPrice = Number(prod.price || 0);
  if (prod.product_type !== 'servicio_especial' || !prod.free_after_sales || prod.free_after_sales <= 0) {
    return {
      freeUnits: 0,
      paidUnits: quantity,
      subtotal: unitPrice * quantity,
      isFreeReward: false,
    };
  }
  const n = Number(prod.free_after_sales);
  const cycle = n + 1;
  const startCounter = Number(prod.sales_counter || 0);
  let freeUnits = 0;
  for (let i = 0; i < quantity; i++) {
    if ((startCounter + i) % cycle === n) {
      freeUnits++;
    }
  }
  const paidUnits = Math.max(0, quantity - freeUnits);
  return {
    freeUnits,
    paidUnits,
    subtotal: paidUnits * unitPrice,
    isFreeReward: freeUnits > 0,
  };
}

function recalculateCartPromotions() {
  // 1. Recalcular cada línea del carrito (incluyendo Servicios Especiales gratis)
  for (const item of state.cart) {
    if (item.product_id) {
      const prod = state.products.find((p) => Number(p.id) === Number(item.product_id));
      if (prod) {
        const calc = calculateSpecialServicePricing(prod, item.quantity);
        item.free_units = calc.freeUnits;
        item.is_free_reward = calc.isFreeReward;
        item.subtotal = calc.subtotal;
        continue;
      }
    }
    item.free_units = 0;
    item.is_free_reward = false;
    item.subtotal = item.unit_price * item.quantity;
  }

  const subtotal = state.cart.reduce((sum, it) => sum + Number(it.subtotal), 0);

  // 2. Evaluar promociones A + B activas
  const qtyByProd = {};
  for (const it of state.cart) {
    if (it.product_id) {
      const pid = Number(it.product_id);
      qtyByProd[pid] = (qtyByProd[pid] || 0) + Number(it.quantity);
    }
  }

  let discountTotal = 0;
  const appliedList = [];

  for (const promo of state.promotions) {
    if (!promo.active) continue;
    const idA = Number(promo.product_a_id);
    const idB = Number(promo.product_b_id);
    const discount = Number(promo.discount_amount || 0);
    if (discount <= 0) continue;

    let times = 0;
    if (idA === idB) {
      times = Math.floor((qtyByProd[idA] || 0) / 2);
    } else {
      times = Math.min(qtyByProd[idA] || 0, qtyByProd[idB] || 0);
    }

    if (times > 0) {
      const promoDiscount = times * discount;
      discountTotal += promoDiscount;
      appliedList.push(`${promo.name}${times > 1 ? ` (x${times})` : ''}: -${formatMoney(promoDiscount)}`);
    }
  }

  // El descuento nunca puede superar el subtotal a pagar
  discountTotal = Math.min(subtotal, discountTotal);
  const finalTotal = Math.max(0, subtotal - discountTotal);

  return {
    subtotal,
    discountTotal,
    promoSummary: appliedList.join(' | '),
    appliedList,
    total: finalTotal,
  };
}

// ==========================================
// PANTALLA DE LOGIN Y CONTROL DE PERMISOS
// ==========================================
function renderLoginScreen() {
  const grid = document.getElementById('login-users-grid');
  const pinForm = document.getElementById('form-login-pin');

  grid.classList.remove('hidden');
  pinForm.classList.add('hidden');

  grid.innerHTML = state.users
    .map((u) => {
      const isAdmin = u.role === 'admin';
      return `
        <div class="login-user-card" data-id="${u.id}">
          <div class="user-avatar">${isAdmin ? '🛡️' : '🧑‍💼'}</div>
          <strong>${escapeHtml(u.name)}</strong>
          <span class="role-badge ${u.role}">${isAdmin ? 'Administrador' : 'Cajero'}</span>
        </div>
      `;
    })
    .join('');

  grid.querySelectorAll('.login-user-card').forEach((card) => {
    card.addEventListener('click', () => {
      const user = state.users.find((u) => Number(u.id) === Number(card.dataset.id));
      if (!user) return;
      state.selectedLoginUser = user;
      document.getElementById('login-selected-name').textContent = `${
        user.role === 'admin' ? '🛡️' : '🧑‍💼'
      } ${user.name}`;
      document.getElementById('login-pin-input').value = '';
      grid.classList.add('hidden');
      pinForm.classList.remove('hidden');
      setTimeout(() => document.getElementById('login-pin-input').focus(), 80);
    });
  });
}

function applyRolePermissions() {
  const user = state.currentUser;
  if (!user) return;

  const isAdmin = user.role === 'admin';

  document.querySelectorAll('.admin-only').forEach((el) => {
    el.classList.toggle('hidden', !isAdmin);
  });

  document.getElementById('active-user-name').textContent = user.name;
  const badge = document.getElementById('active-user-role-badge');
  badge.textContent = isAdmin ? 'ADMIN' : 'CAJERO';
  badge.className = `role-badge ${user.role}`;

  document.getElementById('cart-cashier-name').textContent = user.name;

  if (isAdmin) {
    document.getElementById('nav-history-label').textContent = 'Corte General (Admin)';
    document.getElementById('history-section-title').textContent = 'Corte General de Caja e Historial';
    document.getElementById('history-section-subtitle').textContent =
      'Vista de Administrador: Filtra por cajero, imprime cortes y administra ventas';
    state.selectedCashierFilter = 'all';
    renderCashierFilterDropdown();
  } else {
    document.getElementById('nav-history-label').textContent = 'Mi Turno';
    document.getElementById('history-section-title').textContent = `Mi Corte de Turno (${user.name})`;
    document.getElementById('history-section-subtitle').textContent =
      'Ventas cobradas únicamente en tu turno actual';
    state.selectedCashierFilter = String(user.id);
  }

  switchTab('pos');
}

function switchTab(tabName) {
  const isAdmin = state.currentUser && state.currentUser.role === 'admin';
  if (!isAdmin && ['catalog', 'promos', 'cashiers'].includes(tabName)) {
    showToast('🔒 Acceso exclusivo para Administrador');
    return;
  }

  document.querySelectorAll('.nav-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === tabName);
  });
  document.querySelectorAll('.tab-view').forEach((v) => {
    v.classList.toggle('active', v.id === `tab-${tabName}`);
  });

  if (tabName === 'history') loadSales();
  if (tabName === 'promos' && isAdmin) renderPromosTable();
  if (tabName === 'cashiers' && isAdmin) renderCashiersTable();
}

function renderCashierFilterDropdown() {
  const sel = document.getElementById('history-cashier-filter');
  sel.innerHTML = `<option value="all">👥 Todos los Cajeros</option>`;
  state.users.forEach((u) => {
    const opt = document.createElement('option');
    opt.value = String(u.id);
    opt.textContent = `${u.role === 'admin' ? '🛡️' : '🧑‍💼'} ${u.name}`;
    sel.appendChild(opt);
  });
  sel.value = state.selectedCashierFilter;
}

// ==========================================
// MÓDULO 1: CAJA / PUNTO DE VENTA
// ==========================================
function renderActivePromosBanner() {
  const bar = document.getElementById('pos-active-promos-bar');
  if (!state.promotions || state.promotions.length === 0) {
    bar.classList.add('hidden');
    return;
  }
  bar.classList.remove('hidden');
  bar.innerHTML = state.promotions
    .map(
      (pr) => `
      <span class="promo-pill">
        🎁 <strong>${escapeHtml(pr.name)}:</strong> ${escapeHtml(pr.product_a_name || 'A')} + ${escapeHtml(
        pr.product_b_name || 'B'
      )} = <strong>-${formatMoney(pr.discount_amount)}</strong>
      </span>
    `
    )
    .join('');
}

function renderCategories() {
  const cats = new Set(['Todos']);
  state.products.forEach((p) => {
    if (p.category) cats.add(p.category);
  });
  const container = document.getElementById('category-chips');
  container.innerHTML = '';
  cats.forEach((cat) => {
    const btn = document.createElement('button');
    btn.className = `cat-chip ${state.selectedCategory === cat ? 'active' : ''}`;
    btn.textContent = cat;
    btn.onclick = () => {
      state.selectedCategory = cat;
      renderCategories();
      renderPosProducts();
    };
    container.appendChild(btn);
  });
}

function renderPosProducts() {
  const grid = document.getElementById('pos-products-grid');
  const q = state.searchQuery.toLowerCase().trim();

  const filtered = state.products.filter((p) => {
    const matchCat = state.selectedCategory === 'Todos' || p.category === state.selectedCategory;
    const matchSearch =
      !q || p.name.toLowerCase().includes(q) || (p.category && p.category.toLowerCase().includes(q));
    return matchCat && matchSearch;
  });

  if (filtered.length === 0) {
    grid.innerHTML = `<div class="cart-empty" style="grid-column: 1/-1;">No hay productos o servicios que coincidan.</div>`;
    return;
  }

  grid.innerHTML = filtered
    .map((p) => {
      const pType = p.product_type || (p.is_service ? 'servicio' : 'producto');
      const isProduct = pType === 'producto';
      const stockNum = isProduct && p.stock !== null ? Number(p.stock) : null;
      const outOfStock = isProduct && stockNum !== null && stockNum <= 0;

      // Cantidad ya en el carrito para calcular si la siguiente unidad de Servicio Especial es gratis
      const inCartItem = state.cart.find((it) => it.product_id && Number(it.product_id) === Number(p.id));
      const inCartQty = inCartItem ? Number(inCartItem.quantity) : 0;

      let badgeHtml = `<span class="prod-stock-badge service">⚡ Servicio</span>`;
      let priceHtml = `<div class="prod-card-price">${formatMoney(p.price)}</div>`;

      if (pType === 'servicio_especial' && p.free_after_sales > 0) {
        const n = Number(p.free_after_sales);
        const cycle = n + 1;
        const effectiveCounter = (Number(p.sales_counter || 0) + inCartQty) % cycle;
        if (effectiveCounter === n) {
          badgeHtml = `<span class="prod-stock-badge free-now">🎁 ¡SIGUIENTE GRATIS!</span>`;
          priceHtml = `<div class="prod-card-price"><span style="text-decoration:line-through; color:var(--text-muted); font-size:0.9rem; margin-right:6px;">${formatMoney(
            p.price
          )}</span>$0.00 GRATIS</div>`;
        } else {
          badgeHtml = `<span class="prod-stock-badge special">🌟 Promo: ${effectiveCounter}/${n} ventas</span>`;
        }
      } else if (isProduct && stockNum !== null) {
        const lowClass = stockNum <= 5 ? 'low' : '';
        badgeHtml = `<span class="prod-stock-badge ${lowClass}">Stock: ${stockNum}</span>`;
      }

      return `
        <div class="product-card ${outOfStock ? 'out-of-stock' : ''}" data-id="${p.id}">
          <div class="prod-card-top">
            <span class="prod-category-tag">${escapeHtml(p.category || 'General')}</span>
            ${badgeHtml}
          </div>
          <div class="prod-card-name">${escapeHtml(p.name)}</div>
          ${priceHtml}
        </div>
      `;
    })
    .join('');

  grid.querySelectorAll('.product-card').forEach((card) => {
    card.addEventListener('click', () => {
      const id = Number(card.dataset.id);
      const prod = state.products.find((p) => Number(p.id) === id);
      if (prod) addToCart(prod);
    });
  });
}

function addToCart(prod, customQty = 1) {
  const pType = prod.product_type || (prod.is_service ? 'servicio' : 'producto');
  const isProduct = pType === 'producto';
  const existing = state.cart.find((item) => item.product_id && Number(item.product_id) === Number(prod.id));

  if (isProduct && prod.stock !== null && Number(prod.stock) <= 0) {
    showToast(`⚠️ "${prod.name}" no tiene stock disponible`);
    return;
  }

  if (existing) {
    if (isProduct && prod.stock !== null && existing.quantity + customQty > Number(prod.stock)) {
      showToast(`⚠️ Stock máximo alcanzado (${prod.stock})`);
      return;
    }
    existing.quantity += customQty;
  } else {
    state.cart.push({
      key: prod.id ? `prod-${prod.id}` : `free-${Date.now()}-${Math.random()}`,
      product_id: prod.id || null,
      product_name: prod.name,
      unit_price: Number(prod.price),
      quantity: customQty,
      max_stock: isProduct && prod.stock !== null ? Number(prod.stock) : null,
      free_units: 0,
      is_free_reward: false,
      subtotal: Number(prod.price) * customQty,
    });
  }

  renderCart();
  renderPosProducts();
}

function updateCartQty(key, delta) {
  const idx = state.cart.findIndex((it) => it.key === key);
  if (idx === -1) return;
  const item = state.cart[idx];
  const nextQty = item.quantity + delta;
  if (nextQty <= 0) {
    state.cart.splice(idx, 1);
  } else if (item.max_stock !== null && nextQty > item.max_stock) {
    showToast(`⚠️ Stock disponible máximo: ${item.max_stock}`);
    return;
  } else {
    item.quantity = nextQty;
  }
  renderCart();
  renderPosProducts();
}

function renderCart() {
  const totals = recalculateCartPromotions();

  const listEl = document.getElementById('cart-items-list');
  const subtotalEl = document.getElementById('cart-subtotal');
  const promoBoxEl = document.getElementById('cart-promo-discount-box');
  const promoNamesEl = document.getElementById('cart-promo-names');
  const discountAmtEl = document.getElementById('cart-discount-amount');
  const totalEl = document.getElementById('cart-total');
  const btnCheckout = document.getElementById('btn-open-checkout');
  const btnCheckoutAmt = document.getElementById('btn-checkout-amount');
  const mobileBar = document.getElementById('mobile-cart-bar');

  const totalItems = state.cart.reduce((sum, it) => sum + it.quantity, 0);

  subtotalEl.textContent = formatMoney(totals.subtotal);
  totalEl.textContent = formatMoney(totals.total);
  btnCheckoutAmt.textContent = formatMoney(totals.total);
  btnCheckout.disabled = state.cart.length === 0;

  if (totals.discountTotal > 0) {
    promoBoxEl.classList.remove('hidden');
    promoNamesEl.textContent = totals.appliedList.join(' • ');
    discountAmtEl.textContent = `-${formatMoney(totals.discountTotal)}`;
  } else {
    promoBoxEl.classList.add('hidden');
  }

  document.getElementById('mobile-cart-count').textContent = `${totalItems} concepto(s)`;
  document.getElementById('mobile-cart-total').textContent = formatMoney(totals.total);
  mobileBar.classList.toggle('hidden', state.cart.length === 0);

  if (state.cart.length === 0) {
    listEl.innerHTML = `<div class="cart-empty">Selecciona productos o servicios del catálogo para comenzar a cobrar.</div>`;
    return;
  }

  listEl.innerHTML = state.cart
    .map((it) => {
      const freeTag =
        it.free_units > 0
          ? `<div style="color:var(--success); font-size:0.76rem; font-weight:700;">🎁 ¡Incluye ${it.free_units} GRATIS por Servicio Especial!</div>`
          : '';
      return `
        <div class="cart-item">
          <div class="cart-item-info">
            <div class="cart-item-title">${escapeHtml(it.product_name)}</div>
            <div class="cart-item-meta">${formatMoney(it.unit_price)} c/u</div>
            ${freeTag}
          </div>
          <div class="cart-item-controls">
            <button class="qty-btn" data-key="${it.key}" data-delta="-1">−</button>
            <span class="qty-val">${it.quantity}</span>
            <button class="qty-btn" data-key="${it.key}" data-delta="1">+</button>
          </div>
          <div class="cart-item-subtotal">${formatMoney(it.subtotal)}</div>
        </div>
      `;
    })
    .join('');

  listEl.querySelectorAll('.qty-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      updateCartQty(btn.dataset.key, Number(btn.dataset.delta));
    });
  });
}

// ==========================================
// MÓDULO 2 (SOLO ADMIN): CATÁLOGO E INVENTARIO
// ==========================================
function renderCatalogTable() {
  const tbody = document.getElementById('catalog-table-body');
  const q = state.catalogFilter.toLowerCase().trim();

  const filtered = state.products.filter(
    (p) => !q || p.name.toLowerCase().includes(q) || (p.category && p.category.toLowerCase().includes(q))
  );

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; padding: 2rem;">No se encontraron registros.</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered
    .map((p) => {
      const pType = p.product_type || (p.is_service ? 'servicio' : 'producto');
      let typeLabel = '📦 Producto';
      let stockOrPromoHtml = '';

      if (pType === 'servicio_especial') {
        typeLabel = '🌟 Servicio Especial';
        const n = Number(p.free_after_sales || 5);
        const c = Number(p.sales_counter || 0);
        stockOrPromoHtml = `
          <div>
            <span class="prod-stock-badge special">Cada ${n} ventas → el #${n + 1} Gratis</span>
            <div style="font-size:0.78rem; color:var(--text-muted); margin-top:4px;">
              Contador actual: <strong>${c} / ${n}</strong>
              ${c === n ? '<strong style="color:var(--success)"> (¡Siguiente Gratis!)</strong>' : ''}
            </div>
          </div>
        `;
      } else if (pType === 'servicio') {
        typeLabel = '⚡ Servicio';
        stockOrPromoHtml = '<span style="color:var(--text-muted)">Sin límite</span>';
      } else {
        stockOrPromoHtml = `
          <div style="display:flex; align-items:center; gap:0.4rem;">
            <button class="qty-btn btn-stock-adj" data-id="${p.id}" data-delta="-1">−</button>
            <strong style="min-width:28px; text-align:center;">${p.stock ?? 0}</strong>
            <button class="qty-btn btn-stock-adj" data-id="${p.id}" data-delta="1">+</button>
          </div>
        `;
      }

      return `
        <tr>
          <td><strong>${escapeHtml(p.name)}</strong></td>
          <td><span class="prod-category-tag">${escapeHtml(p.category || 'General')}</span></td>
          <td>${typeLabel}</td>
          <td><strong>${formatMoney(p.price)}</strong></td>
          <td>${stockOrPromoHtml}</td>
          <td>
            <div style="display:flex; gap:0.4rem;">
              <button class="btn btn-secondary btn-sm btn-edit-prod" data-id="${p.id}">Editar</button>
              <button class="btn btn-danger btn-sm btn-del-prod" data-id="${p.id}">Eliminar</button>
            </div>
          </td>
        </tr>
      `;
    })
    .join('');

  tbody.querySelectorAll('.btn-stock-adj').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = Number(btn.dataset.id);
      const delta = Number(btn.dataset.delta);
      const prod = state.products.find((p) => Number(p.id) === id);
      if (!prod) return;
      const newStock = Math.max(0, Number(prod.stock || 0) + delta);
      await DataService.saveProduct({ ...prod, stock: newStock });
      await loadProducts();
      showToast(`Stock de "${prod.name}" actualizado a ${newStock}`);
    });
  });

  tbody.querySelectorAll('.btn-edit-prod').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = Number(btn.dataset.id);
      const prod = state.products.find((p) => Number(p.id) === id);
      if (prod) openProductModal(prod);
    });
  });

  tbody.querySelectorAll('.btn-del-prod').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = Number(btn.dataset.id);
      const prod = state.products.find((p) => Number(p.id) === id);
      if (!prod) return;
      if (confirm(`¿Eliminar "${prod.name}" del catálogo?`)) {
        await DataService.deleteProduct(id);
        await loadProducts();
        showToast('Eliminado del catálogo');
      }
    });
  });
}

// ==========================================
// MÓDULO 3 (SOLO ADMIN): PROMOCIONES (COMPRA A + B = -$ DESCUENTO)
// ==========================================
function renderPromosTable() {
  const tbody = document.getElementById('promos-table-body');
  if (state.promotions.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; padding: 2rem;">No hay promociones registradas. Crea una arriba.</td></tr>`;
    return;
  }

  tbody.innerHTML = state.promotions
    .map((pr) => {
      const prodA = state.products.find((p) => Number(p.id) === Number(pr.product_a_id));
      const prodB = state.products.find((p) => Number(p.id) === Number(pr.product_b_id));
      return `
        <tr>
          <td><strong>🎁 ${escapeHtml(pr.name)}</strong></td>
          <td>${escapeHtml(prodA ? prodA.name : pr.product_a_name || `#${pr.product_a_id}`)}</td>
          <td>${escapeHtml(prodB ? prodB.name : pr.product_b_name || `#${pr.product_b_id}`)}</td>
          <td><strong style="color:var(--success)">-${formatMoney(pr.discount_amount)}</strong></td>
          <td>
            <div style="display:flex; gap:0.4rem;">
              <button class="btn btn-secondary btn-sm btn-edit-promo" data-id="${pr.id}">Editar</button>
              <button class="btn btn-danger btn-sm btn-del-promo" data-id="${pr.id}">Eliminar</button>
            </div>
          </td>
        </tr>
      `;
    })
    .join('');

  tbody.querySelectorAll('.btn-edit-promo').forEach((btn) => {
    btn.addEventListener('click', () => {
      const promo = state.promotions.find((p) => Number(p.id) === Number(btn.dataset.id));
      if (promo) openPromoModal(promo);
    });
  });

  tbody.querySelectorAll('.btn-del-promo').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = Number(btn.dataset.id);
      if (confirm('¿Eliminar esta promoción?')) {
        await DataService.deletePromotion(id);
        await loadPromotions();
        renderPromosTable();
        renderCart();
        showToast('Promoción eliminada');
      }
    });
  });
}

function openPromoModal(promo = null) {
  const selA = document.getElementById('promo-prod-a');
  const selB = document.getElementById('promo-prod-b');

  const optionsHtml = state.products
    .map((p) => `<option value="${p.id}">${escapeHtml(p.name)} (${formatMoney(p.price)})</option>`)
    .join('');

  selA.innerHTML = optionsHtml;
  selB.innerHTML = optionsHtml;

  document.getElementById('modal-promo-title').textContent = promo
    ? 'Editar Promoción (A + B)'
    : 'Nueva Promoción (Compra A + B)';
  document.getElementById('promo-id').value = promo ? promo.id : '';
  document.getElementById('promo-name').value = promo ? promo.name : '';
  if (promo) {
    selA.value = String(promo.product_a_id);
    selB.value = String(promo.product_b_id);
  } else if (state.products.length >= 2) {
    selA.value = String(state.products[0].id);
    selB.value = String(state.products[1].id);
  }
  document.getElementById('promo-discount').value = promo ? promo.discount_amount : 10;
  document.getElementById('modal-promo').classList.remove('hidden');
}

// ==========================================
// MÓDULO 4 (SOLO ADMIN): GESTIÓN DE CAJEROS
// ==========================================
function renderCashiersTable() {
  const tbody = document.getElementById('cashiers-table-body');
  tbody.innerHTML = state.users
    .map((u) => {
      const isAdmin = u.role === 'admin';
      return `
        <tr>
          <td><strong>${escapeHtml(u.name)}</strong></td>
          <td>
            <span class="role-badge ${u.role}">
              ${isAdmin ? '🛡️ Administrador (Acceso Total)' : '🛒 Cajero (Solo Caja y Turno)'}
            </span>
          </td>
          <td><code>${escapeHtml(u.pin)}</code></td>
          <td>
            <div style="display:flex; gap:0.4rem;">
              <button class="btn btn-secondary btn-sm btn-edit-user" data-id="${u.id}">Editar / PIN</button>
              <button class="btn btn-danger btn-sm btn-del-user" data-id="${u.id}">Dar de baja</button>
            </div>
          </td>
        </tr>
      `;
    })
    .join('');

  tbody.querySelectorAll('.btn-edit-user').forEach((btn) => {
    btn.addEventListener('click', () => {
      const user = state.users.find((u) => Number(u.id) === Number(btn.dataset.id));
      if (user) openCashierModal(user);
    });
  });

  tbody.querySelectorAll('.btn-del-user').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = Number(btn.dataset.id);
      const user = state.users.find((u) => Number(u.id) === id);
      if (!user) return;
      const adminsCount = state.users.filter((u) => u.role === 'admin').length;
      if (user.role === 'admin' && adminsCount <= 1) {
        alert('No puedes eliminar al único Administrador activo.');
        return;
      }
      if (confirm(`¿Dar de baja a "${user.name}"?`)) {
        await DataService.deleteUser(id);
        await loadUsers();
        renderCashiersTable();
        showToast(`Usuario "${user.name}" dado de baja`);
      }
    });
  });
}

function openCashierModal(user = null) {
  document.getElementById('modal-cashier-title').textContent = user
    ? 'Editar Cajero / Usuario'
    : 'Nuevo Cajero / Usuario';
  document.getElementById('cashier-id').value = user ? user.id : '';
  document.getElementById('cashier-name').value = user ? user.name : '';
  document.getElementById('cashier-role').value = user ? user.role : 'cajero';
  document.getElementById('cashier-pin').value = user ? user.pin : '';
  document.getElementById('modal-cashier').classList.remove('hidden');
}

// ==========================================
// MÓDULO 5: HISTORIAL Y CORTE DE CAJA
// ==========================================
function renderSalesHistory() {
  const isAdmin = state.currentUser && state.currentUser.role === 'admin';
  const listEl = document.getElementById('sales-history-list');

  const totalSales = state.sales.reduce((sum, s) => sum + Number(s.total), 0);
  const cashSales = state.sales
    .filter((s) => s.payment_method === 'efectivo')
    .reduce((sum, s) => sum + Number(s.total), 0);
  const digitalSales = state.sales
    .filter((s) => s.payment_method !== 'efectivo')
    .reduce((sum, s) => sum + Number(s.total), 0);

  document.getElementById('kpi-total-sales').textContent = formatMoney(totalSales);
  document.getElementById('kpi-sales-count').textContent = `${state.sales.length} venta(s) registrada(s)`;
  document.getElementById('kpi-cash-sales').textContent = formatMoney(cashSales);
  document.getElementById('kpi-digital-sales').textContent = formatMoney(digitalSales);

  if (isAdmin) {
    const byCashier = {};
    for (const s of state.sales) {
      const cName = s.cashier_name || 'General';
      if (!byCashier[cName]) {
        byCashier[cName] = { count: 0, cash: 0, digital: 0, total: 0 };
      }
      byCashier[cName].count += 1;
      byCashier[cName].total += Number(s.total);
      if (s.payment_method === 'efectivo') {
        byCashier[cName].cash += Number(s.total);
      } else {
        byCashier[cName].digital += Number(s.total);
      }
    }
    const breakdownTbody = document.getElementById('cashier-breakdown-tbody');
    const names = Object.keys(byCashier);
    if (names.length === 0) {
      breakdownTbody.innerHTML = `<tr><td colspan="5" style="text-align:center;">Sin ventas en esta fecha</td></tr>`;
    } else {
      breakdownTbody.innerHTML = names
        .map(
          (name) => `
          <tr>
            <td><strong>🧑‍💼 ${escapeHtml(name)}</strong></td>
            <td>${byCashier[name].count} venta(s)</td>
            <td><strong>${formatMoney(byCashier[name].cash)}</strong></td>
            <td>${formatMoney(byCashier[name].digital)}</td>
            <td><strong style="color:var(--success)">${formatMoney(byCashier[name].total)}</strong></td>
          </tr>
        `
        )
        .join('');
    }
  }

  if (state.sales.length === 0) {
    listEl.innerHTML = `<div class="cart-empty">No hay ventas registradas para mostrar (${state.selectedDate}).</div>`;
    return;
  }

  listEl.innerHTML = state.sales
    .map((s) => {
      const timeStr = new Date(s.created_at).toLocaleTimeString('es-MX', {
        hour: '2-digit',
        minute: '2-digit',
      });
      const itemsSummary = (s.items || [])
        .map((it) => `${it.quantity}x ${it.product_name}${it.is_free_reward ? ' (🎁 Gratis)' : ''}`)
        .join(', ');

      return `
        <div class="sale-card">
          <div>
            <div class="sale-card-header">
              <strong>Folio #${s.id}</strong>
              <span class="sale-badge ${s.payment_method}">${s.payment_method}</span>
              <span class="cashier-tag">🧑‍💼 ${escapeHtml(s.cashier_name || 'General')}</span>
              <span style="color:var(--text-muted); font-size:0.85rem;">🕒 ${timeStr}</span>
            </div>
            <div class="sale-items-summary">${escapeHtml(itemsSummary || 'Venta general')}</div>
            <div class="sale-meta">
              ${
                Number(s.discount_total) > 0
                  ? `<span style="color:var(--success); font-weight:700;">🎁 ${escapeHtml(
                      s.promo_summary || 'Descuento promo'
                    )} • </span>`
                  : ''
              }
              ${
                s.payment_method === 'efectivo'
                  ? `Recibido: ${formatMoney(s.amount_received)} | Cambio: ${formatMoney(s.change_given)}`
                  : `Cobro con ${s.payment_method}`
              }
              ${s.note ? ` • Nota: ${escapeHtml(s.note)}` : ''}
            </div>
          </div>
          <div class="sale-card-right">
            <span class="sale-total-amount">${formatMoney(s.total)}</span>
            <button class="btn btn-secondary btn-sm btn-view-ticket" data-id="${s.id}">🧾 Ticket</button>
            ${
              isAdmin
                ? `<button class="btn btn-danger btn-sm btn-cancel-sale" data-id="${s.id}">Cancelar</button>`
                : ''
            }
          </div>
        </div>
      `;
    })
    .join('');

  listEl.querySelectorAll('.btn-view-ticket').forEach((btn) => {
    btn.addEventListener('click', () => {
      const sale = state.sales.find((s) => Number(s.id) === Number(btn.dataset.id));
      if (sale) showSaleTicketModal(sale);
    });
  });

  if (isAdmin) {
    listEl.querySelectorAll('.btn-cancel-sale').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = Number(btn.dataset.id);
        if (confirm(`¿Cancelar la venta Folio #${id}? Se devolverá el stock y el contador de promociones.`)) {
          await DataService.deleteSale(id);
          await Promise.all([loadProducts(), loadSales()]);
          showToast(`Venta #${id} cancelada`);
        }
      });
    });
  }
}

function showSaleTicketModal(sale) {
  const dateStr = new Date(sale.created_at).toLocaleString('es-MX');
  const itemsHtml = (sale.items || [])
    .map(
      (it) => `
      <div style="display:flex; justify-content:space-between; margin: 4px 0;">
        <span>${it.quantity} x ${escapeHtml(it.product_name)}${it.is_free_reward ? ' (🎁 PROMO GRATIS)' : ''}</span>
        <strong>${formatMoney(it.subtotal)}</strong>
      </div>`
    )
    .join('');

  const discountHtml =
    Number(sale.discount_total) > 0
      ? `<div style="display:flex; justify-content:space-between; margin: 4px 0;">
           <span>Subtotal:</span>
           <span>${formatMoney(sale.subtotal)}</span>
         </div>
         <div style="display:flex; justify-content:space-between; margin: 4px 0;">
           <span>🎁 Promo (${escapeHtml(sale.promo_summary)}):</span>
           <strong>-${formatMoney(sale.discount_total)}</strong>
         </div>`
      : '';

  document.getElementById('receipt-title').textContent = `Ticket de Venta #${sale.id}`;
  document.getElementById('receipt-content').innerHTML = `
    <div style="text-align:center; border-bottom:1px dashed #9ca3af; padding-bottom:8px; margin-bottom:8px;">
      <h3 style="margin:0;">PUNTO DE VENTA CARLOS</h3>
      <div>Folio #${sale.id}</div>
      <div>Atendió: <strong>${escapeHtml(sale.cashier_name || 'General')}</strong></div>
      <div style="font-size:0.8rem;">${dateStr}</div>
    </div>
    <div style="border-bottom:1px dashed #9ca3af; padding-bottom:8px; margin-bottom:8px;">
      ${itemsHtml}
    </div>
    ${discountHtml}
    <div style="display:flex; justify-content:space-between; font-size:1.1rem; font-weight:bold;">
      <span>TOTAL:</span>
      <span>${formatMoney(sale.total)}</span>
    </div>
    <div style="margin-top:6px; font-size:0.85rem;">
      <div>Método de pago: <strong>${sale.payment_method.toUpperCase()}</strong></div>
      ${
        sale.payment_method === 'efectivo'
          ? `<div>Recibido: ${formatMoney(sale.amount_received)}</div>
             <div>Cambio: ${formatMoney(sale.change_given)}</div>`
          : ''
      }
      ${sale.note ? `<div>Nota: ${escapeHtml(sale.note)}</div>` : ''}
    </div>
    <div style="text-align:center; margin-top:12px; font-size:0.8rem;">
      ¡Gracias por su preferencia!
    </div>
  `;
  document.getElementById('modal-receipt').classList.remove('hidden');
}

function showDailyCorteModal() {
  const totalSales = state.sales.reduce((sum, s) => sum + Number(s.total), 0);
  const cashSales = state.sales
    .filter((s) => s.payment_method === 'efectivo')
    .reduce((sum, s) => sum + Number(s.total), 0);
  const cardSales = state.sales
    .filter((s) => s.payment_method === 'tarjeta')
    .reduce((sum, s) => sum + Number(s.total), 0);
  const transferSales = state.sales
    .filter((s) => s.payment_method === 'transferencia')
    .reduce((sum, s) => sum + Number(s.total), 0);

  const isAdmin = state.currentUser && state.currentUser.role === 'admin';
  const scopeLabel = !isAdmin
    ? `Cajero: ${state.currentUser.name}`
    : state.selectedCashierFilter === 'all'
    ? 'Todos los Cajeros (General)'
    : `Cajero filtrado`;

  document.getElementById('receipt-title').textContent = `Corte de Caja (${state.selectedDate})`;
  document.getElementById('receipt-content').innerHTML = `
    <div style="text-align:center; border-bottom:1px dashed #9ca3af; padding-bottom:8px; margin-bottom:8px;">
      <h3 style="margin:0;">CORTE DE CAJA</h3>
      <div>Fecha: <strong>${state.selectedDate}</strong></div>
      <div>Alcance: <strong>${escapeHtml(scopeLabel)}</strong></div>
      <div>Operaciones: <strong>${state.sales.length}</strong></div>
    </div>
    <div style="border-bottom:1px dashed #9ca3af; padding-bottom:8px; margin-bottom:8px;">
      <div style="display:flex; justify-content:space-between; margin:4px 0;">
        <span>💵 Efectivo en Caja:</span>
        <strong>${formatMoney(cashSales)}</strong>
      </div>
      <div style="display:flex; justify-content:space-between; margin:4px 0;">
        <span>💳 Tarjeta:</span>
        <strong>${formatMoney(cardSales)}</strong>
      </div>
      <div style="display:flex; justify-content:space-between; margin:4px 0;">
        <span>📲 Transferencia:</span>
        <strong>${formatMoney(transferSales)}</strong>
      </div>
    </div>
    <div style="display:flex; justify-content:space-between; font-size:1.15rem; font-weight:bold;">
      <span>TOTAL INGRESOS:</span>
      <span>${formatMoney(totalSales)}</span>
    </div>
  `;
  document.getElementById('modal-receipt').classList.remove('hidden');
}

// Modal de Cobro
function openCheckoutModal() {
  if (state.cart.length === 0) return;
  const totals = recalculateCartPromotions();

  document.getElementById('checkout-modal-total').textContent = formatMoney(totals.total);
  document.getElementById('checkout-received').value = totals.total.toFixed(2);
  document.getElementById('checkout-note').value = '';

  const promoBanner = document.getElementById('checkout-promo-banner');
  if (totals.discountTotal > 0) {
    promoBanner.classList.remove('hidden');
    promoBanner.innerHTML = `🎁 <strong>Promoción aplicada:</strong> ${escapeHtml(totals.promoSummary)}`;
  } else {
    promoBanner.classList.add('hidden');
  }

  setPaymentMethod('efectivo');
  updateChangeCalculation();
  document.getElementById('modal-checkout').classList.remove('hidden');
  setTimeout(() => document.getElementById('checkout-received').select(), 100);
}

function setPaymentMethod(method) {
  state.paymentMethod = method;
  document.querySelectorAll('.pay-method-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.method === method);
  });
  const cashSection = document.getElementById('cash-payment-section');
  if (method === 'efectivo') {
    cashSection.classList.remove('hidden');
    updateChangeCalculation();
  } else {
    cashSection.classList.add('hidden');
    document.getElementById('btn-confirm-sale').disabled = false;
  }
}

function updateChangeCalculation() {
  const totals = recalculateCartPromotions();
  const received = Number(document.getElementById('checkout-received').value || 0);
  const diff = received - totals.total;
  const changeEl = document.getElementById('checkout-change');
  const confirmBtn = document.getElementById('btn-confirm-sale');

  if (state.paymentMethod === 'efectivo') {
    if (diff < -0.009) {
      changeEl.textContent = `Faltan ${formatMoney(Math.abs(diff))}`;
      changeEl.style.color = '#fca5a5';
      confirmBtn.disabled = true;
    } else {
      changeEl.textContent = formatMoney(Math.max(0, diff));
      changeEl.style.color = '#93c5fd';
      confirmBtn.disabled = false;
    }
  } else {
    confirmBtn.disabled = false;
  }
}

function syncProductModalFields() {
  const typeVal = document.getElementById('prod-type').value;
  document.getElementById('prod-stock-group').classList.toggle('hidden', typeVal !== 'producto');
  document.getElementById('prod-special-group').classList.toggle('hidden', typeVal !== 'servicio_especial');
}

function openProductModal(prod = null) {
  document.getElementById('modal-product-title').textContent = prod
    ? 'Editar Producto / Servicio'
    : 'Nuevo Producto / Servicio';
  document.getElementById('prod-id').value = prod ? prod.id : '';
  document.getElementById('prod-name').value = prod ? prod.name : '';
  document.getElementById('prod-category').value = prod ? prod.category : 'General';
  document.getElementById('prod-price').value = prod ? prod.price : '';

  const pType = prod ? prod.product_type || (prod.is_service ? 'servicio' : 'producto') : 'producto';
  document.getElementById('prod-type').value = pType;
  document.getElementById('prod-stock').value = prod && prod.stock !== null ? prod.stock : 15;
  document.getElementById('prod-free-after').value = prod && prod.free_after_sales ? prod.free_after_sales : 5;
  document.getElementById('prod-sales-counter').value = prod ? Number(prod.sales_counter || 0) : 0;

  syncProductModalFields();
  document.getElementById('modal-product').classList.remove('hidden');
}

// Carga de datos desde Neon
async function loadUsers() {
  state.users = await DataService.getUsers();
  renderLoginScreen();
  if (state.currentUser && state.currentUser.role === 'admin') {
    renderCashierFilterDropdown();
  }
}

async function loadProducts() {
  state.products = await DataService.getProducts();
  renderCategories();
  renderPosProducts();
  renderCatalogTable();
  renderCart();
}

async function loadPromotions() {
  state.promotions = await DataService.getPromotions();
  renderActivePromosBanner();
  renderCart();
}

async function loadSales() {
  if (!state.currentUser) return;
  const cashierFilter =
    state.currentUser.role === 'admin' ? state.selectedCashierFilter : String(state.currentUser.id);
  state.sales = await DataService.getSales(state.selectedDate, cashierFilter);
  renderSalesHistory();
}

// Inicialización general y eventos
async function initApp() {
  const dateInput = document.getElementById('history-date');
  dateInput.value = state.selectedDate;

  // Login por PIN
  document.getElementById('btn-change-login-user').addEventListener('click', () => {
    state.selectedLoginUser = null;
    renderLoginScreen();
  });

  document.querySelectorAll('.key-btn[data-key]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.key;
      const input = document.getElementById('login-pin-input');
      if (key === 'clear') {
        input.value = '';
      } else if (input.value.length < 8) {
        input.value += key;
      }
      input.focus();
    });
  });

  document.getElementById('form-login-pin').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!state.selectedLoginUser) return;
    const pin = document.getElementById('login-pin-input').value.trim();
    try {
      const verifiedUser = await DataService.verifyPin(state.selectedLoginUser.id, pin);
      state.currentUser = verifiedUser;
      document.getElementById('login-screen').classList.add('hidden');
      document.getElementById('app-shell').classList.remove('hidden');
      applyRolePermissions();
      await loadSales();
      showToast(`👋 Bienvenido, ${verifiedUser.name}`);
    } catch {
      showToast('❌ PIN incorrecto, intenta de nuevo');
      document.getElementById('login-pin-input').value = '';
      document.getElementById('login-pin-input').focus();
    }
  });

  document.getElementById('btn-logout').addEventListener('click', async () => {
    state.currentUser = null;
    state.cart = [];
    renderCart();
    document.getElementById('app-shell').classList.add('hidden');
    document.getElementById('login-screen').classList.remove('hidden');
    await loadUsers();
  });

  document.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  document.querySelectorAll('[data-close]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.getElementById(btn.dataset.close).classList.add('hidden');
    });
  });

  document.getElementById('pos-search').addEventListener('input', (e) => {
    state.searchQuery = e.target.value;
    renderPosProducts();
  });

  document.getElementById('catalog-search').addEventListener('input', (e) => {
    state.catalogFilter = e.target.value;
    renderCatalogTable();
  });

  document.getElementById('btn-clear-cart').addEventListener('click', () => {
    if (state.cart.length > 0 && confirm('¿Vaciar el ticket actual?')) {
      state.cart = [];
      renderCart();
      renderPosProducts();
    }
  });

  document.getElementById('btn-open-checkout').addEventListener('click', openCheckoutModal);
  document.getElementById('btn-mobile-checkout').addEventListener('click', openCheckoutModal);

  document.querySelectorAll('.pay-method-btn').forEach((btn) => {
    btn.addEventListener('click', () => setPaymentMethod(btn.dataset.method));
  });

  document.getElementById('checkout-received').addEventListener('input', updateChangeCalculation);

  document.querySelectorAll('.chip-btn[data-cash]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const val = btn.dataset.cash;
      const totals = recalculateCartPromotions();
      document.getElementById('checkout-received').value =
        val === 'exact' ? totals.total.toFixed(2) : Number(val).toFixed(2);
      updateChangeCalculation();
    });
  });

  // Confirmar venta en Neon
  document.getElementById('btn-confirm-sale').addEventListener('click', async () => {
    const btn = document.getElementById('btn-confirm-sale');
    btn.disabled = true;
    btn.textContent = 'Guardando en Neon...';
    try {
      const totals = recalculateCartPromotions();
      const sale = await DataService.createSale({
        items: state.cart,
        subtotal: totals.subtotal,
        discount_total: totals.discountTotal,
        promo_summary: totals.promoSummary,
        payment_method: state.paymentMethod,
        amount_received: Number(document.getElementById('checkout-received').value || totals.total),
        note: document.getElementById('checkout-note').value,
        cashier_id: state.currentUser ? state.currentUser.id : null,
        cashier_name: state.currentUser ? state.currentUser.name : 'General',
      });
      state.cart = [];
      renderCart();
      document.getElementById('modal-checkout').classList.add('hidden');
      showToast(`✅ Venta #${sale.id} registrada por ${sale.cashier_name}`);
      showSaleTicketModal(sale);
      await Promise.all([loadProducts(), loadSales()]);
    } catch (err) {
      alert('Error al guardar la venta: ' + err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = '✅ Registrar Venta';
    }
  });

  // Concepto Libre
  document.getElementById('btn-quick-item').addEventListener('click', () => {
    document.getElementById('form-quick-item').reset();
    document.getElementById('quick-qty').value = 1;
    document.getElementById('modal-quick-item').classList.remove('hidden');
    setTimeout(() => document.getElementById('quick-name').focus(), 80);
  });

  document.getElementById('form-quick-item').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = document.getElementById('quick-name').value.trim();
    const price = Number(document.getElementById('quick-price').value || 0);
    const qty = Number(document.getElementById('quick-qty').value || 1);
    if (!name || price <= 0) return;
    addToCart({ id: null, name, price, is_service: true, product_type: 'servicio', stock: null }, qty);
    document.getElementById('modal-quick-item').classList.add('hidden');
    showToast(`Agregado: ${qty}x ${name}`);
  });

  // Admin: Crear / Editar Producto o Servicio Especial
  document.getElementById('btn-new-product').addEventListener('click', () => openProductModal(null));
  document.getElementById('prod-type').addEventListener('change', syncProductModalFields);

  document.getElementById('form-product').addEventListener('submit', async (e) => {
    e.preventDefault();
    const pType = document.getElementById('prod-type').value;
    const payload = {
      id: document.getElementById('prod-id').value || null,
      name: document.getElementById('prod-name').value.trim(),
      category: document.getElementById('prod-category').value.trim() || 'General',
      price: Number(document.getElementById('prod-price').value || 0),
      product_type: pType,
      is_service: pType !== 'producto',
      stock: document.getElementById('prod-stock').value,
      free_after_sales: document.getElementById('prod-free-after').value,
      sales_counter: document.getElementById('prod-sales-counter').value,
    };
    await DataService.saveProduct(payload);
    document.getElementById('modal-product').classList.add('hidden');
    await loadProducts();
    showToast('✅ Catálogo actualizado en Neon');
  });

  // Admin: Crear / Editar Promoción (A + B)
  document.getElementById('btn-new-promo').addEventListener('click', () => openPromoModal(null));

  document.getElementById('form-promo').addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {
      id: document.getElementById('promo-id').value || null,
      name: document.getElementById('promo-name').value.trim(),
      product_a_id: Number(document.getElementById('promo-prod-a').value),
      product_b_id: Number(document.getElementById('promo-prod-b').value),
      discount_amount: Number(document.getElementById('promo-discount').value || 10),
    };
    await DataService.savePromotion(payload);
    document.getElementById('modal-promo').classList.add('hidden');
    await loadPromotions();
    renderPromosTable();
    showToast('✅ Promoción guardada en Neon');
  });

  // Admin: Crear / Editar Cajero
  document.getElementById('btn-new-cashier').addEventListener('click', () => openCashierModal(null));

  document.getElementById('form-cashier').addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {
      id: document.getElementById('cashier-id').value || null,
      name: document.getElementById('cashier-name').value.trim(),
      role: document.getElementById('cashier-role').value,
      pin: document.getElementById('cashier-pin').value.trim(),
    };
    await DataService.saveUser(payload);
    document.getElementById('modal-cashier').classList.add('hidden');
    await loadUsers();
    renderCashiersTable();
    showToast('✅ Usuario guardado en Neon');
  });

  // Historial y Corte
  dateInput.addEventListener('change', (e) => {
    state.selectedDate = e.target.value;
    loadSales();
  });

  document.getElementById('history-cashier-filter').addEventListener('change', (e) => {
    state.selectedCashierFilter = e.target.value;
    loadSales();
  });

  document.getElementById('btn-refresh-history').addEventListener('click', () => {
    loadSales();
    showToast('Historial actualizado');
  });

  document.getElementById('btn-print-corte').addEventListener('click', showDailyCorteModal);
  document.getElementById('btn-print-receipt').addEventListener('click', () => window.print());

  // Atajos de teclado en PC
  window.addEventListener('keydown', (e) => {
    if (!state.currentUser) return;
    if (e.key === 'F2') {
      e.preventDefault();
      if (state.cart.length > 0) openCheckoutModal();
    } else if (e.key === 'F4') {
      e.preventDefault();
      document.getElementById('btn-quick-item').click();
    } else if (e.key === 'Escape') {
      document.querySelectorAll('.modal-backdrop').forEach((m) => m.classList.add('hidden'));
    }
  });

  // Conectar a Neon
  const dotEl = document.getElementById('db-status-dot');
  const txtEl = document.getElementById('db-status-text');
  try {
    renderCart();
    const info = await DataService.init();
    await Promise.all([loadUsers(), loadProducts(), loadPromotions()]);
    dotEl.className = 'status-dot connected';
    txtEl.textContent = `Conectado: ${info.mode}`;
  } catch (err) {
    dotEl.className = 'status-dot error';
    txtEl.textContent = 'Error de conexión a Neon';
    console.error(err);
  }
}

initApp();
