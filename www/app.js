// Conexión directa a Neon Serverless HTTP API + Respaldo Offline Automático (LocalStorage + Auto-Sync)
const NEON_CONN_STR =
  'postgresql://neondb_owner:npg_v80ptgIKUSzN@ep-billowing-shape-bex6iinx-pooler.c-9.us-east-2.aws.neon.tech/neondb?sslmode=require';
const NEON_HTTP_URL =
  'https://ep-billowing-shape-bex6iinx-pooler.c-9.us-east-2.aws.neon.tech/sql';

// ==========================================
// ALMACENAMIENTO OFFLINE Y COLA DE SINCRONIZACIÓN
// ==========================================
const OfflineStore = {
  KEYS: {
    USERS: 'pos_cache_users_v1',
    PRODUCTS: 'pos_cache_products_v1',
    PROMOS: 'pos_cache_promos_v1',
    SALES: 'pos_cache_sales_v1',
    CUTS: 'pos_cache_cuts_v1',
    EXPENSES: 'pos_cache_expenses_v1',
    QUEUE: 'pos_pending_sales_queue_v1',
    LOGS: 'pos_pending_logs_v1',
  },

  get(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  },

  set(key, val) {
    try {
      localStorage.setItem(key, JSON.stringify(val));
    } catch (e) {
      console.warn('Error guardando caché local:', e);
    }
  },

  getPendingQueue() {
    return this.get(this.KEYS.QUEUE, []);
  },

  addPendingSale(salePayload) {
    const queue = this.getPendingQueue();
    const localSale = {
      ...salePayload,
      id: `LOCAL-${Date.now().toString().slice(-4)}`,
      pending_sync: true,
      created_at: new Date().toISOString(),
    };
    queue.push(localSale);
    this.set(this.KEYS.QUEUE, queue);

    // Actualizar stock y contador de Servicio Especial en el caché local para que las siguientes ventas offline sean exactas
    const cachedProducts = this.get(this.KEYS.PRODUCTS, []);
    for (const it of salePayload.items || []) {
      if (it.product_id) {
        const p = cachedProducts.find((prod) => Number(prod.id) === Number(it.product_id));
        if (p) {
          const qty = Number(it.quantity) || 1;
          if (p.product_type === 'servicio_especial' && p.free_after_sales > 0) {
            const cycle = Number(p.free_after_sales) + 1;
            p.sales_counter = (Number(p.sales_counter || 0) + qty) % cycle;
          } else if (p.product_type === 'producto' && p.stock !== null) {
            p.stock = Math.max(0, Number(p.stock) - qty);
          }
        }
      }
    }
    this.set(this.KEYS.PRODUCTS, cachedProducts);
    return localSale;
  },

  removePendingSale(localId) {
    const queue = this.getPendingQueue().filter((s) => s.id !== localId);
    this.set(this.KEYS.QUEUE, queue);
  },
};

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

// Petición a Render con timeout corto (1.8s): si Render se durmió tras 15 min de inactividad,
// no congela la pantalla 30s sino que despierta Render en segundo plano y salta directo a Neon Cloud.
async function apiFetch(url, options = {}, timeoutMs = 1800) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);
    return res;
  } catch (err) {
    clearTimeout(timer);
    // Despertar Render silenciosamente para siguientes peticiones y activar Neon Directo al instante
    fetch('/api/health').catch(() => {});
    DataService.useDirectNeon = true;
    throw err;
  }
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
      status TEXT NOT NULL DEFAULT 'completada',
      refunded_total NUMERIC(10, 2) NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await neonQuery(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'completada';`);
  await neonQuery(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS refunded_total NUMERIC(10, 2) NOT NULL DEFAULT 0;`);
  await neonQuery(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS cut_id INTEGER DEFAULT NULL;`);
  await neonQuery(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS client_uid TEXT DEFAULT NULL;`);

  await neonQuery(`
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

  await neonQuery(`
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
  await neonQuery(`ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS returned_qty INTEGER NOT NULL DEFAULT 0;`);

  await neonQuery(`
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

  await neonQuery(`
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

  await neonQuery(`
    CREATE TABLE IF NOT EXISTS recurring_expenses (
      id SERIAL PRIMARY KEY,
      concept TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'estacionamiento',
      amount NUMERIC(10, 2) NOT NULL DEFAULT 0,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await neonQuery(`
    CREATE TABLE IF NOT EXISTS recurring_expense_skips (
      id SERIAL PRIMARY KEY,
      recurring_id INTEGER NOT NULL REFERENCES recurring_expenses(id) ON DELETE CASCADE,
      skip_date DATE NOT NULL,
      skipped_by TEXT DEFAULT 'General',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(recurring_id, skip_date)
    );
  `);

  await neonQuery(`
    CREATE TABLE IF NOT EXISTS expenses (
      id SERIAL PRIMARY KEY,
      concept TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'snack',
      amount NUMERIC(10, 2) NOT NULL DEFAULT 0,
      expense_date DATE NOT NULL DEFAULT (NOW() AT TIME ZONE 'America/Mexico_City')::date,
      cashier_id INTEGER,
      cashier_name TEXT DEFAULT 'General',
      cut_id INTEGER DEFAULT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await neonQuery(`ALTER TABLE cash_cuts ADD COLUMN IF NOT EXISTS expenses_snack NUMERIC(10, 2) NOT NULL DEFAULT 0;`);
  await neonQuery(`ALTER TABLE cash_cuts ADD COLUMN IF NOT EXISTS expenses_parking NUMERIC(10, 2) NOT NULL DEFAULT 0;`);
  await neonQuery(`ALTER TABLE cash_cuts ADD COLUMN IF NOT EXISTS expenses_total NUMERIC(10, 2) NOT NULL DEFAULT 0;`);
  await neonQuery(`ALTER TABLE cash_cuts ADD COLUMN IF NOT EXISTS free_money NUMERIC(10, 2) NOT NULL DEFAULT 0;`);
}

// ==========================================
// TELEMETRÍA Y LOGS SILENCIOSOS TRAS BAMBALINAS (VIGENCIA 15 DÍAS)
// ==========================================
const SystemLogger = {
  isFlushing: false,

  getDeviceInfo() {
    const ua = navigator.userAgent || '';
    let platform = 'PC';
    if (/iPad/i.test(ua)) platform = 'iPad';
    else if (/iPhone/i.test(ua)) platform = 'iPhone';
    else if (/Android/i.test(ua)) platform = /Mobile/i.test(ua) ? 'Android Phone' : 'Android Tablet';
    const connMode = DataService.useDirectNeon ? 'DirectNeon' : 'ServerAPI';
    return `${platform} (${window.innerWidth}x${window.innerHeight}) | online:${navigator.onLine} | mode:${connMode}`;
  },

  log(level, category, message, detailsObj = {}) {
    try {
      const entry = {
        level,
        category,
        message,
        details: typeof detailsObj === 'string' ? detailsObj : JSON.stringify(detailsObj || {}),
        cashier_name: state && state.currentUser ? `${state.currentUser.name} (${state.currentUser.role})` : 'Sin sesión',
        device_info: this.getDeviceInfo(),
        created_at: new Date().toISOString(),
      };

      const queue = OfflineStore.get(OfflineStore.KEYS.LOGS, []);
      queue.push(entry);
      if (queue.length > 80) queue.splice(0, queue.length - 80);
      OfflineStore.set(OfflineStore.KEYS.LOGS, queue);

      if (navigator.onLine) {
        this.flush();
      }
    } catch {
      // Silencioso para jamás interrumpir la operación
    }
  },

  async flush() {
    if (this.isFlushing || !navigator.onLine) return;
    const queue = OfflineStore.get(OfflineStore.KEYS.LOGS, []);
    if (queue.length === 0) return;

    this.isFlushing = true;
    const batch = queue.slice(0, 25);
    OfflineStore.set(OfflineStore.KEYS.LOGS, queue.slice(batch.length));

    try {
      if (!DataService.useDirectNeon) {
        const res = await fetch('/api/logs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ entries: batch }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      } else {
        for (const e of batch) {
          await neonQuery(
            `INSERT INTO system_logs (level, category, message, details, cashier_name, device_info, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz)`,
            [e.level, e.category, e.message, e.details, e.cashier_name, e.device_info, e.created_at]
          );
        }
        await neonQuery(`DELETE FROM system_logs WHERE created_at < NOW() - INTERVAL '15 days';`).catch(() => {});
      }
    } catch {
      const current = OfflineStore.get(OfflineStore.KEYS.LOGS, []);
      OfflineStore.set(OfflineStore.KEYS.LOGS, [...batch, ...current].slice(-80));
    } finally {
      this.isFlushing = false;
    }
  },
};

// Capa de datos unificada con soporte Offline-First + Auto-Sync
const DataService = {
  useDirectNeon: false,
  isOffline: false,
  isSyncing: false,
  isCreatingSale: false,

  async init() {
    if (!navigator.onLine) {
      this.isOffline = true;
      return { mode: 'Modo Sin Conexión (Respaldo Local)', offline: true };
    }

    if (window.location.protocol === 'file:' || window.Capacitor) {
      try {
        this.useDirectNeon = true;
        await ensureNeonSchemaDirect();
        this.isOffline = false;
        return { mode: 'Neon Cloud (Directo APK)', offline: false };
      } catch {
        this.isOffline = true;
        return { mode: 'Modo Sin Conexión (Respaldo Local)', offline: true };
      }
    }

    try {
      // Despertar Render silenciosamente en segundo plano pero NO esperar más de 1.2s
      fetch('/api/health').catch(() => {});
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1200);
      const res = await fetch('/api/health', { signal: controller.signal });
      clearTimeout(timer);
      if (res.ok) {
        this.useDirectNeon = false;
        this.isOffline = false;
        return { mode: 'Neon Cloud (Servidor Web)', offline: false };
      }
    } catch {
      // Si Render está despertando (>1.2s), conectar directo a Neon Cloud al instante sin esperar a Render
    }

    try {
      this.useDirectNeon = true;
      await neonQuery('SELECT 1');
      this.isOffline = false;
      return { mode: 'Neon Cloud (Directo)', offline: false };
    } catch {
      this.isOffline = true;
      return { mode: 'Modo Sin Conexión (Respaldo Local)', offline: true };
    }
  },

  async getUsers() {
    const defaultFallbackUsers = [
      { id: 1, name: 'Administrador', role: 'admin', pin: '1234' },
      { id: 2, name: 'Cajero 1', role: 'cajero', pin: '1111' },
      { id: 3, name: 'Cajero 2', role: 'cajero', pin: '2222' },
    ];
    try {
      let rows;
      if (!this.useDirectNeon) {
        try {
          const res = await apiFetch('/api/users');
          if (!res.ok) throw new Error('API offline');
          rows = await res.json();
        } catch {
          rows = await neonQuery(`
            SELECT id, name, role, pin, created_at
            FROM users
            WHERE active = TRUE
            ORDER BY CASE WHEN role = 'admin' THEN 0 ELSE 1 END, name ASC
          `);
        }
      } else {
        rows = await neonQuery(`
          SELECT id, name, role, pin, created_at
          FROM users
          WHERE active = TRUE
          ORDER BY CASE WHEN role = 'admin' THEN 0 ELSE 1 END, name ASC
        `);
      }
      this.isOffline = false;
      OfflineStore.set(OfflineStore.KEYS.USERS, rows);
      updateConnectionUI();
      return rows;
    } catch {
      this.isOffline = true;
      updateConnectionUI();
      return OfflineStore.get(OfflineStore.KEYS.USERS, defaultFallbackUsers);
    }
  },

  async verifyPin(userId, pin) {
    const cleanPin = String(pin).trim();
    if (!cleanPin) throw new Error('PIN incorrecto');

    // 1. Si ya tenemos el usuario y su PIN en caché local (sincronizado al abrir), validar en 0ms sin esperar a Render
    const cachedUsers = OfflineStore.get(OfflineStore.KEYS.USERS, []);
    const cachedMatch = cachedUsers.find((u) => Number(u.id) === Number(userId) && u.pin !== undefined);
    if (cachedMatch) {
      if (String(cachedMatch.pin) === cleanPin) {
        return { id: cachedMatch.id, name: cachedMatch.name, role: cachedMatch.role };
      }
      // Si no coincidió con el caché local, verificar contra Neon por si el Admin cambió el PIN recientemente
    }

    try {
      if (!this.isOffline) {
        if (!this.useDirectNeon) {
          try {
            const res = await apiFetch('/api/auth', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ user_id: userId, pin: cleanPin }),
            }, 1500);
            if (res.ok) return res.json();
            if (res.status === 401) throw new Error('PIN_INVALID');
          } catch (apiErr) {
            if (apiErr.message === 'PIN_INVALID') throw apiErr;
            // Si Render tardó >1.5s, validar directo en Neon Cloud al instante
            const rows = await neonQuery(
              'SELECT id, name, role FROM users WHERE id = $1 AND pin = $2 AND active = TRUE',
              [Number(userId), cleanPin]
            );
            if (rows.length === 0) throw new Error('PIN_INVALID');
            return rows[0];
          }
        } else {
          const rows = await neonQuery(
            'SELECT id, name, role FROM users WHERE id = $1 AND pin = $2 AND active = TRUE',
            [Number(userId), cleanPin]
          );
          if (rows.length === 0) throw new Error('PIN_INVALID');
          return rows[0];
        }
      }
    } catch (err) {
      if (err.message === 'PIN_INVALID') throw new Error('PIN incorrecto');
      this.isOffline = true;
      updateConnectionUI();
    }

    // Verificación offline contra el caché local de usuarios
    const fallbackUsers = OfflineStore.get(OfflineStore.KEYS.USERS, [
      { id: 1, name: 'Administrador', role: 'admin', pin: '1234' },
      { id: 2, name: 'Cajero 1', role: 'cajero', pin: '1111' },
      { id: 3, name: 'Cajero 2', role: 'cajero', pin: '2222' },
    ]);
    const match = fallbackUsers.find((u) => Number(u.id) === Number(userId) && String(u.pin) === cleanPin);
    if (!match) throw new Error('PIN incorrecto');
    return { id: match.id, name: match.name, role: match.role };
  },

  async saveUser(userObj) {
    const role = userObj.role === 'admin' ? 'admin' : 'cajero';
    if (!this.useDirectNeon) {
      try {
        const url = userObj.id ? `/api/users/${userObj.id}` : '/api/users';
        const method = userObj.id ? 'PUT' : 'POST';
        const res = await apiFetch(url, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...userObj, role }),
        });
        if (res.ok) return res.json();
      } catch {
        // Fallback inmediato a Neon Directo
      }
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
      try {
        const res = await apiFetch(`/api/users/${id}`, { method: 'DELETE' });
        if (res.ok) return true;
      } catch {
        // Fallback inmediato a Neon Directo
      }
    }
    await neonQuery('UPDATE users SET active = FALSE WHERE id = $1', [Number(id)]);
    return true;
  },

  async getProducts() {
    try {
      let rows;
      if (!this.useDirectNeon) {
        try {
          const res = await apiFetch('/api/products');
          if (!res.ok) throw new Error('Offline');
          rows = await res.json();
        } catch {
          rows = await neonQuery(`
            SELECT id, name, category, price::float AS price, stock, is_service,
                   COALESCE(product_type, CASE WHEN is_service THEN 'servicio' ELSE 'producto' END) AS product_type,
                   free_after_sales, COALESCE(sales_counter, 0) AS sales_counter, created_at
            FROM products
            WHERE active = TRUE
            ORDER BY category ASC, name ASC
          `);
        }
      } else {
        rows = await neonQuery(`
          SELECT id, name, category, price::float AS price, stock, is_service,
                 COALESCE(product_type, CASE WHEN is_service THEN 'servicio' ELSE 'producto' END) AS product_type,
                 free_after_sales, COALESCE(sales_counter, 0) AS sales_counter, created_at
          FROM products
          WHERE active = TRUE
          ORDER BY category ASC, name ASC
        `);
      }
      const normalized = rows.map((r) => ({
        ...r,
        price: Number(r.price),
        stock: r.stock !== null ? Number(r.stock) : null,
        free_after_sales: r.free_after_sales !== null ? Number(r.free_after_sales) : null,
        sales_counter: Number(r.sales_counter || 0),
      }));
      this.isOffline = false;
      OfflineStore.set(OfflineStore.KEYS.PRODUCTS, normalized);
      updateConnectionUI();
      return normalized;
    } catch {
      this.isOffline = true;
      updateConnectionUI();
      return OfflineStore.get(OfflineStore.KEYS.PRODUCTS, []);
    }
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
      try {
        const url = prod.id ? `/api/products/${prod.id}` : '/api/products';
        const method = prod.id ? 'PUT' : 'POST';
        const res = await apiFetch(url, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (res.ok) return res.json();
      } catch {
        // Fallback inmediato a Neon Directo
      }
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
      try {
        const res = await apiFetch(`/api/products/${id}`, { method: 'DELETE' });
        if (res.ok) return true;
      } catch {
        // Fallback inmediato a Neon Directo
      }
    }
    await neonQuery('UPDATE products SET active = FALSE WHERE id = $1', [Number(id)]);
    return true;
  },

  async getPromotions() {
    try {
      let rows;
      if (!this.useDirectNeon) {
        try {
          const res = await apiFetch('/api/promotions');
          if (!res.ok) throw new Error('Offline');
          rows = await res.json();
        } catch {
          rows = await neonQuery(`
            SELECT pr.id, pr.name, pr.product_a_id, pr.product_b_id,
                   pr.discount_amount::float AS discount_amount, pr.active,
                   pa.name AS product_a_name, pb.name AS product_b_name
            FROM promotions pr
            LEFT JOIN products pa ON pa.id = pr.product_a_id
            LEFT JOIN products pb ON pb.id = pr.product_b_id
            WHERE pr.active = TRUE
            ORDER BY pr.id DESC
          `);
        }
      } else {
        rows = await neonQuery(`
          SELECT pr.id, pr.name, pr.product_a_id, pr.product_b_id,
                 pr.discount_amount::float AS discount_amount, pr.active,
                 pa.name AS product_a_name, pb.name AS product_b_name
          FROM promotions pr
          LEFT JOIN products pa ON pa.id = pr.product_a_id
          LEFT JOIN products pb ON pb.id = pr.product_b_id
          WHERE pr.active = TRUE
          ORDER BY pr.id DESC
        `);
      }
      const normalized = rows.map((r) => ({ ...r, discount_amount: Number(r.discount_amount) }));
      OfflineStore.set(OfflineStore.KEYS.PROMOS, normalized);
      return normalized;
    } catch {
      return OfflineStore.get(OfflineStore.KEYS.PROMOS, []);
    }
  },

  async savePromotion(promo) {
    if (!this.useDirectNeon) {
      try {
        const url = promo.id ? `/api/promotions/${promo.id}` : '/api/promotions';
        const method = promo.id ? 'PUT' : 'POST';
        const res = await apiFetch(url, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(promo),
        });
        if (res.ok) return res.json();
      } catch {
        // Fallback inmediato a Neon Directo
      }
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
      try {
        const res = await apiFetch(`/api/promotions/${id}`, { method: 'DELETE' });
        if (res.ok) return true;
      } catch {
        // Fallback inmediato a Neon Directo
      }
    }
    await neonQuery('UPDATE promotions SET active = FALSE WHERE id = $1', [Number(id)]);
    return true;
  },

  async sendSaleToCloud(salePayload) {
    if (!this.useDirectNeon) {
      try {
        const res = await apiFetch('/api/sales', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(salePayload),
        }, 2200);
        if (res.ok) return res.json();
      } catch {
        // Si Render estaba dormido (>2.2s), guardar directo en Neon Cloud sin mandar a cola Offline
      }
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
    const clientUid = salePayload.client_uid ? String(salePayload.client_uid).trim() : null;
    const createdAt =
      salePayload.created_at && !Number.isNaN(Date.parse(salePayload.created_at))
        ? new Date(salePayload.created_at).toISOString()
        : new Date().toISOString();

    if (clientUid) {
      await ensureNeonSchemaDirect();
      const existingRows = await neonQuery(
        `SELECT id, subtotal::float AS subtotal, discount_total::float AS discount_total, promo_summary,
                total::float AS total, payment_method, amount_received::float AS amount_received,
                change_given::float AS change_given, note, cashier_id, cashier_name, created_at
         FROM sales WHERE client_uid = $1 LIMIT 1`,
        [clientUid]
      );
      if (existingRows.length > 0) {
        const existingItems = await neonQuery(
          `SELECT id, sale_id, product_id, product_name, quantity,
                  unit_price::float AS unit_price, subtotal::float AS subtotal, is_free_reward
           FROM sale_items WHERE sale_id = $1 ORDER BY id ASC`,
          [existingRows[0].id]
        );
        if (existingItems.length === items.length && existingItems.length > 0) {
          return { ...existingRows[0], items: existingItems };
        }
        // Si una venta anterior quedó truncada a mitad de camino por caída de red, limpiarla antes de reinsertar
        await neonQuery('DELETE FROM sales WHERE id = $1', [existingRows[0].id]);
      }
    }

    const saleRows = await neonQuery(
      `INSERT INTO sales (subtotal, discount_total, promo_summary, total, payment_method, amount_received, change_given, note, cashier_id, cashier_name, created_at, client_uid)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::timestamptz, $12)
       RETURNING id, subtotal::float AS subtotal, discount_total::float AS discount_total, promo_summary,
                 total::float AS total, payment_method, amount_received::float AS amount_received,
                 change_given::float AS change_given, note, cashier_id, cashier_name, created_at`,
      [subtotal, discountTotal, promoSummary, total, paymentMethod, amountReceived, changeGiven, note, cashierId, cashierName, createdAt, clientUid]
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

  async createSale(salePayload) {
    const items = salePayload.items || [];
    const subtotal = items.reduce((acc, it) => acc + Number(it.subtotal ?? Number(it.unit_price) * Number(it.quantity)), 0);
    const discountTotal = Math.max(0, Number(salePayload.discount_total || 0));
    const total = Math.max(0, subtotal - discountTotal);
    const paymentMethod = salePayload.payment_method || 'efectivo';
    const amountReceived = paymentMethod === 'efectivo' ? Number(salePayload.amount_received ?? total) : total;
    const changeGiven = paymentMethod === 'efectivo' ? Math.max(0, amountReceived - total) : 0;

    const fullPayload = {
      ...salePayload,
      subtotal,
      discount_total: discountTotal,
      total,
      amount_received: amountReceived,
      change_given: changeGiven,
      created_at: salePayload.created_at || new Date().toISOString(),
      client_uid:
        salePayload.client_uid ||
        `UID-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    };

    try {
      if (!navigator.onLine) throw new Error('navigator.onLine es false');
      const cloudSale = await this.sendSaleToCloud(fullPayload);
      this.isOffline = false;
      updateConnectionUI();
      SystemLogger.log('info', 'sale_created', `Venta #${cloudSale.id} registrada en línea`, {
        sale_id: cloudSale.id,
        client_uid: fullPayload.client_uid,
        total: fullPayload.total,
        items_count: items.length,
      });
      return cloudSale;
    } catch (err) {
      // Guardar venta en cola local segura sin perder nada (conservando su created_at original)
      this.isOffline = true;
      const localSale = OfflineStore.addPendingSale(fullPayload);
      updateConnectionUI();
      SystemLogger.log('warn', 'network_fallback_offline', `Fallo al subir venta; guardada en cola offline (${localSale.id})`, {
        reason: err && err.message ? err.message : 'Error de red desconocido',
        client_uid: fullPayload.client_uid,
        total: fullPayload.total,
        items_count: items.length,
      });
      return localSale;
    }
  },

  async syncPendingSales() {
    if (this.isSyncing) return 0;
    const queue = OfflineStore.getPendingQueue();
    if (queue.length === 0 || !navigator.onLine) return 0;

    this.isSyncing = true;
    let syncedCount = 0;
    try {
      for (const pendingSale of queue) {
        try {
          // Retirar de la cola antes de enviar para evitar doble subida si ocurre otro evento
          OfflineStore.removePendingSale(pendingSale.id);
          const syncedSale = await this.sendSaleToCloud(pendingSale);
          syncedCount++;
          SystemLogger.log('info', 'offline_sale_synced', `Venta offline ${pendingSale.id} sincronizada como Folio #${syncedSale.id}`, {
            local_id: pendingSale.id,
            cloud_id: syncedSale.id,
            client_uid: pendingSale.client_uid,
            original_created_at: pendingSale.created_at,
            total: pendingSale.total,
          });
        } catch (err) {
          // Si falló la red al enviar, volver a ponerla en la cola sin perderla
          const currentQueue = OfflineStore.getPendingQueue();
          if (!currentQueue.some((s) => s.id === pendingSale.id)) {
            currentQueue.unshift(pendingSale);
            OfflineStore.set(OfflineStore.KEYS.QUEUE, currentQueue);
          }
          SystemLogger.log('error', 'offline_sync_failed', `Fallo al intentar sincronizar venta offline ${pendingSale.id}`, {
            reason: err && err.message ? err.message : 'Error de red',
            client_uid: pendingSale.client_uid,
          });
          break;
        }
      }
      if (syncedCount > 0) {
        this.isOffline = false;
        updateConnectionUI();
        await Promise.all([loadProducts(), loadSales()]);
        showToast(`☁️ ${syncedCount} venta(s) offline sincronizada(s) con Neon`);
      }
    } finally {
      this.isSyncing = false;
    }
    return syncedCount;
  },

  async getSales(startDateStr, endDateStr, cashierId = 'all') {
    const startParam = startDateStr || getTodayLocalISO();
    const endParam = endDateStr || startParam;

    const pendingQueue = OfflineStore.getPendingQueue().filter((s) => {
      if (cashierId && cashierId !== 'all' && Number(s.cashier_id) !== Number(cashierId)) return false;
      return true;
    });

    try {
      let cloudSales = [];
      if (!this.useDirectNeon) {
        const params = new URLSearchParams();
        if (startParam) params.set('start_date', startParam);
        if (endParam) params.set('end_date', endParam);
        if (cashierId && cashierId !== 'all') params.set('cashier_id', cashierId);
        const res = await fetch(`/api/sales?${params.toString()}`);
        if (!res.ok) throw new Error('Offline');
        cloudSales = await res.json();
      } else {
        let salesRows;
        if (startParam && endParam && cashierId && cashierId !== 'all') {
          salesRows = await neonQuery(
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
            [startParam, endParam, Number(cashierId)]
          );
        } else if (startParam && endParam) {
          salesRows = await neonQuery(
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
            [startParam, endParam]
          );
        } else {
          salesRows = await neonQuery(
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
        if (salesRows.length > 0) {
          const saleIds = salesRows.map((s) => Number(s.id));
          const itemsRows = await neonQuery(
            `SELECT id, sale_id, product_id, product_name, quantity, COALESCE(returned_qty, 0) AS returned_qty,
                    unit_price::float AS unit_price, subtotal::float AS subtotal, COALESCE(is_free_reward, FALSE) AS is_free_reward
             FROM sale_items
             WHERE sale_id = ANY($1::int[])
             ORDER BY id ASC`,
            [saleIds]
          );
          let returnsRows = [];
          try {
            returnsRows = await neonQuery(
              `SELECT id, sale_id, refund_amount::float AS refund_amount, reason, return_to_stock,
                      items_summary, processed_by_name, authorized_by_name, created_at
               FROM sale_returns
               WHERE sale_id = ANY($1::int[])
               ORDER BY created_at ASC`,
              [saleIds]
            );
          } catch {
            // Si aún no existe la tabla sale_returns en sesión directa, crearla al vuelo
            await ensureNeonSchemaDirect();
          }
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
          cloudSales = salesRows.map((s) => ({
            ...s,
            subtotal: Number(s.subtotal),
            discount_total: Number(s.discount_total || 0),
            total: Number(s.total),
            refunded_total: Number(s.refunded_total || 0),
            status: s.status || 'completada',
            amount_received: Number(s.amount_received),
            change_given: Number(s.change_given),
            items: itemsBySale[s.id] || [],
            returns: returnsBySale[s.id] || [],
          }));
        }
      }
      this.isOffline = false;
      OfflineStore.set(OfflineStore.KEYS.SALES, cloudSales);
      updateConnectionUI();
      return [...pendingQueue, ...cloudSales];
    } catch {
      this.isOffline = true;
      updateConnectionUI();
      const cachedSales = OfflineStore.get(OfflineStore.KEYS.SALES, []).filter((s) => {
        if (cashierId && cashierId !== 'all' && Number(s.cashier_id) !== Number(cashierId)) return false;
        return true;
      });
      return [...pendingQueue, ...cachedSales];
    }
  },

  async processSaleReturn(saleId, payload) {
    const returnItems = Array.isArray(payload.items) ? payload.items : [];
    const reason = String(payload.reason || '').trim();
    const refundAmount = Math.max(0, Number(payload.refund_amount || 0));
    const processedByName = String(payload.processed_by_name || 'General').trim();
    let authorizedByName = String(payload.authorized_by_name || '').trim();
    const isAdminSession = Boolean(payload.is_admin_session);
    const adminPin = String(payload.admin_pin || '').trim();

    if (!reason) throw new Error('El motivo de la devolución es obligatorio');

    // Si es venta en cola local sin subir aún
    if (String(saleId).startsWith('LOCAL-')) {
      if (!isAdminSession) {
        const cachedUsers = OfflineStore.get(OfflineStore.KEYS.USERS, [
          { id: 1, name: 'Administrador', role: 'admin', pin: '1234' },
        ]);
        const adminUser = cachedUsers.find((u) => u.role === 'admin' && String(u.pin) === adminPin);
        if (!adminUser) throw new Error('PIN de Administrador incorrecto');
        authorizedByName = adminUser.name;
      } else if (!authorizedByName) {
        authorizedByName = processedByName;
      }
      OfflineStore.removePendingSale(String(saleId));
      updateConnectionUI();
      return { ok: true, status: 'devuelta_total', authorized_by_name: authorizedByName };
    }

    if (!this.useDirectNeon) {
      try {
        const res = await apiFetch(`/api/sales/${saleId}/return`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }, 2200);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(data.error || 'Error al procesar la devolución');
        }
        return data;
      } catch (apiErr) {
        if (apiErr.message && !apiErr.message.includes('aborted') && !apiErr.message.includes('fetch')) {
          throw apiErr;
        }
        // Si fue timeout porque Render dormía, continuar abajo con Direct Neon
      }
    }

    // Modo Directo Neon (APK / Serverless)
    if (!isAdminSession) {
      if (!adminPin) {
        throw new Error('Se requiere el PIN de un Administrador para autorizar la devolución');
      }
      const adminRows = await neonQuery(
        "SELECT id, name FROM users WHERE role = 'admin' AND pin = $1 AND active = TRUE LIMIT 1",
        [adminPin]
      );
      if (adminRows.length === 0) {
        throw new Error('PIN de Administrador incorrecto');
      }
      authorizedByName = adminRows[0].name;
    } else if (!authorizedByName) {
      authorizedByName = processedByName;
    }

    const numSaleId = Number(saleId);
    const summaryParts = [];
    let anyToStock = false;

    for (const reqItem of returnItems) {
      const retQty = Number(reqItem.return_qty || 0);
      if (retQty <= 0) continue;

      const saleItemId = Number(reqItem.sale_item_id);
      const returnToStock = Boolean(reqItem.return_to_stock);
      if (returnToStock) anyToStock = true;

      const dbItemRows = await neonQuery(
        'SELECT id, product_id, product_name, quantity, COALESCE(returned_qty, 0) AS returned_qty FROM sale_items WHERE id = $1 AND sale_id = $2',
        [saleItemId, numSaleId]
      );
      if (!dbItemRows[0]) continue;
      const dbItem = dbItemRows[0];
      const availableQty = Math.max(0, Number(dbItem.quantity) - Number(dbItem.returned_qty));
      const effectiveRetQty = Math.min(retQty, availableQty);
      if (effectiveRetQty <= 0) continue;

      await neonQuery(
        'UPDATE sale_items SET returned_qty = COALESCE(returned_qty, 0) + $1 WHERE id = $2',
        [effectiveRetQty, saleItemId]
      );

      let destinoTag = '';
      if (dbItem.product_id) {
        const prodRows = await neonQuery(
          'SELECT product_type, is_service, stock, free_after_sales, COALESCE(sales_counter, 0) AS sales_counter FROM products WHERE id = $1',
          [Number(dbItem.product_id)]
        );
        if (prodRows[0]) {
          const p = prodRows[0];
          if (p.product_type === 'servicio_especial' && p.free_after_sales > 0) {
            const cycle = Number(p.free_after_sales) + 1;
            const prevCounter = (Number(p.sales_counter) - effectiveRetQty + cycle * 10) % cycle;
            await neonQuery('UPDATE products SET sales_counter = $1 WHERE id = $2', [prevCounter, Number(dbItem.product_id)]);
            destinoTag = ' (contador revertido)';
          } else if (!p.is_service && p.stock !== null) {
            if (returnToStock) {
              await neonQuery('UPDATE products SET stock = stock + $1 WHERE id = $2', [effectiveRetQty, Number(dbItem.product_id)]);
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
      throw new Error('Selecciona al menos una unidad para devolver');
    }

    const itemsSummary = summaryParts.join(', ');

    await neonQuery(
      `INSERT INTO sale_returns (sale_id, refund_amount, reason, return_to_stock, items_summary, processed_by_name, authorized_by_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [numSaleId, refundAmount, reason, anyToStock, itemsSummary, processedByName, authorizedByName]
    );

    const allSaleItems = await neonQuery(
      'SELECT quantity, COALESCE(returned_qty, 0) AS returned_qty FROM sale_items WHERE sale_id = $1',
      [numSaleId]
    );
    const allReturned = allSaleItems.every((it) => Number(it.returned_qty) >= Number(it.quantity));
    const newStatus = allReturned ? 'devuelta_total' : 'devuelta_parcial';

    await neonQuery(
      `UPDATE sales
       SET refunded_total = LEAST(total, COALESCE(refunded_total, 0) + $1),
           status = $2
       WHERE id = $3`,
      [refundAmount, newStatus, numSaleId]
    );

    return {
      ok: true,
      status: newStatus,
      authorized_by_name: authorizedByName,
      items_summary: itemsSummary,
    };
  },

  async deleteSale(saleId) {
    if (String(saleId).startsWith('LOCAL-')) {
      OfflineStore.removePendingSale(String(saleId));
      updateConnectionUI();
      return true;
    }
    if (!this.useDirectNeon) {
      const res = await fetch(`/api/sales/${saleId}`, { method: 'DELETE' });
      if (res.ok) return true;
    }
    const numId = Number(saleId);
    const saleInfoRows = await neonQuery('SELECT id, cut_id FROM sales WHERE id = $1', [numId]);
    const cutId = saleInfoRows[0]?.cut_id ? Number(saleInfoRows[0].cut_id) : null;

    const items = await neonQuery(
      'SELECT product_id, quantity, COALESCE(returned_qty, 0) AS returned_qty FROM sale_items WHERE sale_id = $1',
      [numId]
    );
    for (const it of items) {
      const netSoldQty = Math.max(0, Number(it.quantity) - Number(it.returned_qty || 0));
      if (it.product_id && netSoldQty > 0) {
        const prodRows = await neonQuery(
          'SELECT product_type, is_service, stock, free_after_sales, COALESCE(sales_counter, 0) AS sales_counter FROM products WHERE id = $1',
          [Number(it.product_id)]
        );
        if (prodRows[0]) {
          const p = prodRows[0];
          if (p.product_type === 'servicio_especial' && p.free_after_sales > 0) {
            const cycle = Number(p.free_after_sales) + 1;
            const prevCounter = (Number(p.sales_counter) - netSoldQty + cycle * 10) % cycle;
            await neonQuery('UPDATE products SET sales_counter = $1 WHERE id = $2', [prevCounter, Number(it.product_id)]);
          } else if (!p.is_service && p.stock !== null) {
            await neonQuery('UPDATE products SET stock = stock + $1 WHERE id = $2', [netSoldQty, Number(it.product_id)]);
          }
        }
      }
    }
    await neonQuery('DELETE FROM sales WHERE id = $1', [numId]);

    if (cutId) {
      const remaining = await neonQuery(
        `SELECT COUNT(*)::int AS cnt,
                COALESCE(SUM(total), 0)::float AS gross,
                COALESCE(SUM(refunded_total), 0)::float AS refunded,
                COALESCE(SUM(GREATEST(0, total - COALESCE(refunded_total, 0))), 0)::float AS net,
                COALESCE(SUM(CASE WHEN payment_method = 'efectivo' THEN GREATEST(0, total - COALESCE(refunded_total, 0)) ELSE 0 END), 0)::float AS cash,
                COALESCE(SUM(CASE WHEN payment_method = 'tarjeta' THEN GREATEST(0, total - COALESCE(refunded_total, 0)) ELSE 0 END), 0)::float AS card,
                COALESCE(SUM(CASE WHEN payment_method = 'transferencia' THEN GREATEST(0, total - COALESCE(refunded_total, 0)) ELSE 0 END), 0)::float AS transfer
         FROM sales WHERE cut_id = $1`,
        [cutId]
      );
      const r = remaining[0];
      if (!r || Number(r.cnt) === 0) {
        await neonQuery('DELETE FROM cash_cuts WHERE id = $1', [cutId]);
      } else {
        await neonQuery(
          `UPDATE cash_cuts
           SET sales_count = $1, gross_sales = $2, refunded_total = $3, net_sales = $4,
               expected_cash = $5, counted_cash = $5, cash_difference = 0, card_sales = $6, transfer_sales = $7
           WHERE id = $8`,
          [r.cnt, r.gross, r.refunded, r.net, r.cash, r.card, r.transfer, cutId]
        );
      }
    }
    return true;
  },

  async getCashCuts(startDateStr, endDateStr, cashierId = 'all') {
    const startParam = startDateStr || getTodayLocalISO();
    const endParam = endDateStr || startParam;
    try {
      if (!this.useDirectNeon) {
        try {
          const params = new URLSearchParams();
          if (startParam) params.set('start_date', startParam);
          if (endParam) params.set('end_date', endParam);
          if (cashierId && cashierId !== 'all') params.set('cashier_id', cashierId);
          const res = await apiFetch(`/api/cash-cuts?${params.toString()}`);
          if (res.ok) {
            const rows = await res.json();
            OfflineStore.set(OfflineStore.KEYS.CUTS, rows);
            return rows;
          }
        } catch {
          // Fallback inmediato a Neon Directo
        }
      }
      await ensureNeonSchemaDirect();
      let rows;
      if (startParam && endDateStr && cashierId && cashierId !== 'all') {
        rows = await neonQuery(
          `SELECT id, cashier_id, cashier_name, sales_count, gross_sales::float AS gross_sales,
                  refunded_total::float AS refunded_total, net_sales::float AS net_sales,
                  expected_cash::float AS expected_cash, counted_cash::float AS counted_cash,
                  cash_difference::float AS cash_difference, card_sales::float AS card_sales,
                  transfer_sales::float AS transfer_sales,
                  COALESCE(expenses_snack, 0)::float AS expenses_snack,
                  COALESCE(expenses_parking, 0)::float AS expenses_parking,
                  COALESCE(expenses_total, 0)::float AS expenses_total,
                  COALESCE(free_money, net_sales)::float AS free_money,
                  note, created_at
           FROM cash_cuts
           WHERE (created_at AT TIME ZONE 'America/Mexico_City')::date >= $1::date
             AND (created_at AT TIME ZONE 'America/Mexico_City')::date <= $2::date
             AND cashier_id = $3
           ORDER BY created_at DESC`,
          [startParam, endParam, Number(cashierId)]
        );
      } else {
        rows = await neonQuery(
          `SELECT id, cashier_id, cashier_name, sales_count, gross_sales::float AS gross_sales,
                  refunded_total::float AS refunded_total, net_sales::float AS net_sales,
                  expected_cash::float AS expected_cash, counted_cash::float AS counted_cash,
                  cash_difference::float AS cash_difference, card_sales::float AS card_sales,
                  transfer_sales::float AS transfer_sales,
                  COALESCE(expenses_snack, 0)::float AS expenses_snack,
                  COALESCE(expenses_parking, 0)::float AS expenses_parking,
                  COALESCE(expenses_total, 0)::float AS expenses_total,
                  COALESCE(free_money, net_sales)::float AS free_money,
                  note, created_at
           FROM cash_cuts
           WHERE (created_at AT TIME ZONE 'America/Mexico_City')::date >= $1::date
             AND (created_at AT TIME ZONE 'America/Mexico_City')::date <= $2::date
           ORDER BY created_at DESC`,
          [startParam, endParam]
        );
      }
      OfflineStore.set(OfflineStore.KEYS.CUTS, rows);
      return rows;
    } catch {
      return OfflineStore.get(OfflineStore.KEYS.CUTS, []);
    }
  },

  async createCashCut(payload) {
    try {
      if (!this.useDirectNeon) {
        try {
          const res = await apiFetch('/api/cash-cuts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
          if (res.ok) return res.json();
        } catch {
          // Fallback inmediato a Neon Directo
        }
      }
      await ensureNeonSchemaDirect();
      const cashierId = payload.cashier_id ? Number(payload.cashier_id) : null;
      const cashierName = String(payload.cashier_name || 'General').trim();
      const salesCount = Number(payload.sales_count || 0);
      const grossSales = Number(payload.gross_sales || 0);
      const refundedTotal = Number(payload.refunded_total || 0);
      const netSales = Number(payload.net_sales || 0);
      const expectedCash = Number(payload.expected_cash || 0);
      const countedCash = Number(payload.counted_cash ?? expectedCash);
      const cashDifference = Number((countedCash - expectedCash).toFixed(2));
      const cardSales = Number(payload.card_sales || 0);
      const transferSales = Number(payload.transfer_sales || 0);
      const expensesSnack = Number(payload.expenses_snack || 0);
      const expensesParking = Number(payload.expenses_parking || 0);
      const expensesTotal = Number(payload.expenses_total ?? expensesSnack + expensesParking);
      const freeMoney = Number(payload.free_money ?? netSales - expensesTotal);
      const note = String(payload.note || '').trim();
      const saleIds = Array.isArray(payload.sale_ids)
        ? payload.sale_ids.map(Number).filter((n) => Number.isInteger(n) && n > 0)
        : [];

      const rows = await neonQuery(
        `INSERT INTO cash_cuts (
           cashier_id, cashier_name, sales_count, gross_sales, refunded_total,
           net_sales, expected_cash, counted_cash, cash_difference, card_sales, transfer_sales,
           expenses_snack, expenses_parking, expenses_total, free_money, note
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
         RETURNING id, cashier_id, cashier_name, sales_count, gross_sales::float AS gross_sales,
                   refunded_total::float AS refunded_total, net_sales::float AS net_sales,
                   expected_cash::float AS expected_cash, counted_cash::float AS counted_cash,
                   cash_difference::float AS cash_difference, card_sales::float AS card_sales,
                   transfer_sales::float AS transfer_sales,
                   COALESCE(expenses_snack, 0)::float AS expenses_snack,
                   COALESCE(expenses_parking, 0)::float AS expenses_parking,
                   COALESCE(expenses_total, 0)::float AS expenses_total,
                   COALESCE(free_money, net_sales)::float AS free_money,
                   note, created_at`,
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
          expensesSnack,
          expensesParking,
          expensesTotal,
          freeMoney,
          note,
        ]
      );
      const cut = rows[0];
      if (saleIds.length > 0) {
        await neonQuery('UPDATE sales SET cut_id = $1 WHERE id = ANY($2::int[])', [cut.id, saleIds]);
      }
      return cut;
    } catch {
      const localCut = {
        id: `LOCAL-${Date.now().toString().slice(-4)}`,
        ...payload,
        cash_difference: Number((Number(payload.counted_cash || 0) - Number(payload.expected_cash || 0)).toFixed(2)),
        created_at: new Date().toISOString(),
      };
      const cuts = OfflineStore.get(OfflineStore.KEYS.CUTS, []);
      cuts.unshift(localCut);
      OfflineStore.set(OfflineStore.KEYS.CUTS, cuts);
      return localCut;
    }
  },

  async getExpensesData(startDateStr, endDateStr) {
    const startParam = startDateStr || getTodayLocalISO();
    const endParam = endDateStr || startParam;
    const fallback = OfflineStore.get(OfflineStore.KEYS.EXPENSES, { punctual: [], recurring: [], skips: [] });
    try {
      if (!this.useDirectNeon) {
        try {
          const params = new URLSearchParams({ start_date: startParam, end_date: endParam });
          const res = await apiFetch(`/api/expenses?${params.toString()}`);
          if (res.ok) {
            const data = await res.json();
            OfflineStore.set(OfflineStore.KEYS.EXPENSES, data);
            return data;
          }
        } catch {
          // Fallback a Neon Directo
        }
      }
      await ensureNeonSchemaDirect();
      const [punctual, recurring, skips] = await Promise.all([
        neonQuery(
          `SELECT id, concept, category, amount::float AS amount,
                  expense_date::text AS expense_date, cashier_id, cashier_name, cut_id, created_at
           FROM expenses
           WHERE expense_date >= $1::date AND expense_date <= $2::date
           ORDER BY expense_date DESC, created_at DESC`,
          [startParam, endParam]
        ),
        neonQuery(
          `SELECT id, concept, category, amount::float AS amount, active,
                  (created_at AT TIME ZONE 'America/Mexico_City')::date::text AS start_date, created_at
           FROM recurring_expenses
           WHERE active = TRUE
           ORDER BY id ASC`
        ),
        neonQuery(
          `SELECT id, recurring_id, skip_date::text AS skip_date, skipped_by, created_at
           FROM recurring_expense_skips
           WHERE skip_date >= $1::date AND skip_date <= $2::date`,
          [startParam, endParam]
        ),
      ]);
      const data = { punctual, recurring, skips };
      OfflineStore.set(OfflineStore.KEYS.EXPENSES, data);
      return data;
    } catch {
      return fallback;
    }
  },

  async saveExpense(payload) {
    const expenseType = payload.expense_type === 'recurrente' ? 'recurrente' : 'puntual';
    const concept = String(payload.concept || '').trim();
    const category = payload.category === 'estacionamiento' ? 'estacionamiento' : 'snack';
    const amount = Number(payload.amount || 0);
    const expenseDate = payload.expense_date || getTodayLocalISO();
    const cashierId = payload.cashier_id ? Number(payload.cashier_id) : null;
    const cashierName = String(payload.cashier_name || 'General').trim();

    if (!this.useDirectNeon) {
      try {
        const res = await apiFetch('/api/expenses', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            expense_type: expenseType,
            concept,
            category,
            amount,
            expense_date: expenseDate,
            cashier_id: cashierId,
            cashier_name: cashierName,
          }),
        });
        if (res.ok) return res.json();
      } catch {
        // Fallback inmediato a Neon Directo
      }
    }
    await ensureNeonSchemaDirect();
    if (expenseType === 'recurrente') {
      const rows = await neonQuery(
        `INSERT INTO recurring_expenses (concept, category, amount, active)
         VALUES ($1, $2, $3, TRUE)
         RETURNING id, concept, category, amount::float AS amount, active,
                   (created_at AT TIME ZONE 'America/Mexico_City')::date::text AS start_date, created_at`,
        [concept, category, amount]
      );
      return { type: 'recurrente', item: rows[0] };
    } else {
      const rows = await neonQuery(
        `INSERT INTO expenses (concept, category, amount, expense_date, cashier_id, cashier_name)
         VALUES ($1, $2, $3, $4::date, $5, $6)
         RETURNING id, concept, category, amount::float AS amount,
                   expense_date::text AS expense_date, cashier_id, cashier_name, cut_id, created_at`,
        [concept, category, amount, expenseDate, cashierId, cashierName]
      );
      return { type: 'puntual', item: rows[0] };
    }
  },

  async toggleRecurringExpenseSkip(recurringId, skipDate, skip, skippedBy) {
    if (!this.useDirectNeon) {
      try {
        const res = await apiFetch('/api/expenses/recurring-skip', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            recurring_id: Number(recurringId),
            skip_date: skipDate,
            skip: Boolean(skip),
            skipped_by: skippedBy,
          }),
        });
        if (res.ok) return res.json();
      } catch {
        // Fallback inmediato a Neon Directo
      }
    }
    await ensureNeonSchemaDirect();
    if (skip) {
      await neonQuery(
        `INSERT INTO recurring_expense_skips (recurring_id, skip_date, skipped_by)
         VALUES ($1, $2::date, $3)
         ON CONFLICT (recurring_id, skip_date) DO NOTHING`,
        [Number(recurringId), skipDate, skippedBy]
      );
    } else {
      await neonQuery(
        `DELETE FROM recurring_expense_skips WHERE recurring_id = $1 AND skip_date = $2::date`,
        [Number(recurringId), skipDate]
      );
    }
    return { ok: true };
  },

  async deleteExpense(id) {
    if (!this.useDirectNeon) {
      try {
        const res = await apiFetch(`/api/expenses/${id}`, { method: 'DELETE' });
        if (res.ok) return true;
      } catch {
        // Fallback inmediato a Neon Directo
      }
    }
    await neonQuery('DELETE FROM expenses WHERE id = $1', [Number(id)]);
    return true;
  },

  async deleteRecurringExpense(id) {
    if (!this.useDirectNeon) {
      try {
        const res = await apiFetch(`/api/expenses/recurring/${id}`, { method: 'DELETE' });
        if (res.ok) return true;
      } catch {
        // Fallback inmediato a Neon Directo
      }
    }
    await neonQuery('UPDATE recurring_expenses SET active = FALSE WHERE id = $1', [Number(id)]);
    return true;
  },
};

function updateConnectionUI() {
  const dotEl = document.getElementById('db-status-dot');
  const txtEl = document.getElementById('db-status-text');
  const syncBtn = document.getElementById('btn-sync-pending');
  const syncCountEl = document.getElementById('pending-sync-count');

  const pendingCount = OfflineStore.getPendingQueue().length;
  if (syncCountEl) syncCountEl.textContent = pendingCount;
  if (syncBtn) syncBtn.classList.toggle('hidden', pendingCount === 0);

  if (!dotEl || !txtEl) return;
  if (DataService.isOffline || !navigator.onLine) {
    dotEl.className = 'status-dot offline';
    txtEl.textContent =
      pendingCount > 0
        ? `Modo Sin Conexión (${pendingCount} venta(s) en equipo)`
        : 'Modo Sin Conexión (Respaldo Local Activo)';
  } else {
    dotEl.className = 'status-dot connected';
    txtEl.textContent = 'Conectado: Neon Cloud (Sincronizado)';
  }
}

// Estado de la aplicación
const state = {
  users: [],
  currentUser: null,
  selectedLoginUser: null,
  products: [],
  promotions: [],
  cart: [],
  sales: [],
  cashCuts: [],
  expensesData: { punctual: [], recurring: [], skips: [] },
  showAllDaySalesInHistory: false,
  selectedCategory: 'Todos',
  collapsedCategories: {},
  categoriesInitialized: false,
  mobileCartOpen: false,
  activeTab: 'pos',
  searchQuery: '',
  catalogFilter: '',
  paymentMethod: 'efectivo',
  selectedDate: getTodayLocalISO(),
  historyPeriod: 'day',
  selectedMonth: getTodayLocalISO().slice(0, 7),
  customStartDate: getTodayLocalISO(),
  customEndDate: getTodayLocalISO(),
  periodGroupBy: 'month',
  selectedCashierFilter: 'all',
};

function getTodayLocalISO() {
  const now = new Date();
  const offsetMs = now.getTimezoneOffset() * 60000;
  return new Date(now.getTime() - offsetMs).toISOString().slice(0, 10);
}

function toLocalISODate(dateObj) {
  const y = dateObj.getFullYear();
  const m = String(dateObj.getMonth() + 1).padStart(2, '0');
  const d = String(dateObj.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getActiveHistoryDateRange() {
  const todayStr = getTodayLocalISO();
  const [ty, tm, td] = todayStr.split('-').map(Number);
  const today = new Date(ty, tm - 1, td);
  const mode = state.historyPeriod || 'day';

  if (mode === 'day') {
    const d = state.selectedDate || todayStr;
    return { startDate: d, endDate: d, label: `Día: ${d}`, isMultiDay: false };
  }

  if (mode === 'this_week') {
    const dayOfWeek = today.getDay(); // 0=Dom, 1=Lun...
    const diffToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    const monday = new Date(today);
    monday.setDate(today.getDate() + diffToMonday);
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    const s = toLocalISODate(monday);
    const e = toLocalISODate(sunday);
    return { startDate: s, endDate: e, label: `Esta Semana (${s} al ${e})`, isMultiDay: true };
  }

  if (mode === 'last_week') {
    const dayOfWeek = today.getDay();
    const diffToLastMonday = (dayOfWeek === 0 ? -6 : 1 - dayOfWeek) - 7;
    const monday = new Date(today);
    monday.setDate(today.getDate() + diffToLastMonday);
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    const s = toLocalISODate(monday);
    const e = toLocalISODate(sunday);
    return { startDate: s, endDate: e, label: `Semana Pasada (${s} al ${e})`, isMultiDay: true };
  }

  if (mode === 'last_4_weeks') {
    const start = new Date(today);
    start.setDate(today.getDate() - 27);
    const s = toLocalISODate(start);
    return { startDate: s, endDate: todayStr, label: `Últimas 4 Semanas (${s} al ${todayStr})`, isMultiDay: true };
  }

  if (mode === 'this_month') {
    const firstDay = new Date(ty, tm - 1, 1);
    const lastDay = new Date(ty, tm, 0);
    const s = toLocalISODate(firstDay);
    const e = toLocalISODate(lastDay);
    return { startDate: s, endDate: e, label: `Este Mes (${s} al ${e})`, isMultiDay: true };
  }

  if (mode === 'last_month') {
    const firstDay = new Date(ty, tm - 2, 1);
    const lastDay = new Date(ty, tm - 1, 0);
    const s = toLocalISODate(firstDay);
    const e = toLocalISODate(lastDay);
    return { startDate: s, endDate: e, label: `Mes Pasado (${s} al ${e})`, isMultiDay: true };
  }

  if (mode === 'pick_month') {
    const ym = state.selectedMonth || todayStr.slice(0, 7);
    const [py, pm] = ym.split('-').map(Number);
    const firstDay = new Date(py, pm - 1, 1);
    const lastDay = new Date(py, pm, 0);
    const s = toLocalISODate(firstDay);
    const e = toLocalISODate(lastDay);
    return { startDate: s, endDate: e, label: `Mes ${ym} (${s} al ${e})`, isMultiDay: true };
  }

  const monthsMatch = mode.match(/^last_(\d+)_months$/);
  if (monthsMatch) {
    const numMonths = Number(monthsMatch[1]);
    const start = new Date(ty, tm - numMonths, 1);
    const s = toLocalISODate(start);
    return {
      startDate: s,
      endDate: todayStr,
      label: `Últimos ${numMonths} Meses (${s} al ${todayStr})`,
      isMultiDay: true,
    };
  }

  if (mode === 'custom_range') {
    const s = state.customStartDate || todayStr;
    const e = state.customEndDate || todayStr;
    const start = s <= e ? s : e;
    const end = s <= e ? e : s;
    return {
      startDate: start,
      endDate: end,
      label: `Rango Personalizado (${start} al ${end})`,
      isMultiDay: start !== end,
    };
  }

  return { startDate: todayStr, endDate: todayStr, label: `Día: ${todayStr}`, isMultiDay: false };
}

function getSalePeriodBucket(createdAtISO, groupBy = 'month') {
  const d = new Date(createdAtISO);
  if (groupBy === 'day') {
    const key = toLocalISODate(d);
    const label = d.toLocaleDateString('es-MX', {
      weekday: 'short',
      year: 'numeric',
      month: 'short',
      day: '2-digit',
    });
    return { key, label: `📅 ${label}` };
  }
  if (groupBy === 'week') {
    const dayOfWeek = d.getDay();
    const diffToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() + diffToMonday);
    const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);
    const key = toLocalISODate(monday);
    return { key, label: `📆 Semana ${toLocalISODate(monday)} al ${toLocalISODate(sunday)}` };
  }
  // Por mes (default)
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const key = `${y}-${m}`;
  const monthName = d.toLocaleDateString('es-MX', { month: 'long', year: 'numeric' });
  const capMonth = monthName.charAt(0).toUpperCase() + monthName.slice(1);
  return { key, label: `🗓️ ${capMonth}` };
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
function renderLoginScreen(preserveActivePinPad = false) {
  const grid = document.getElementById('login-users-grid');
  const pinForm = document.getElementById('form-login-pin');

  // Si el usuario ya había tocado su nombre y tiene abierto el teclado de PIN, NO cerrárselo cuando loadUsers() responda en segundo plano
  if (preserveActivePinPad && state.selectedLoginUser && !pinForm.classList.contains('hidden')) {
    const updatedUser = state.users.find((u) => Number(u.id) === Number(state.selectedLoginUser.id));
    if (updatedUser) {
      state.selectedLoginUser = updatedUser;
    }
    return;
  }

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
      document.getElementById('login-selected-name').textContent = `${user.role === 'admin' ? '🛡️' : '🧑‍💼'
        } ${user.name}`;
      document.getElementById('login-pin-input').value = '';
      grid.classList.add('hidden');
      pinForm.classList.remove('hidden');
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

function toggleMobileCartDrawer(open) {
  state.mobileCartOpen = typeof open === 'boolean' ? open : !state.mobileCartOpen;
  const pane = document.getElementById('pos-cart-pane');
  const backdrop = document.getElementById('mobile-cart-backdrop');
  if (pane) pane.classList.toggle('mobile-drawer-open', state.mobileCartOpen);
  if (backdrop) backdrop.classList.toggle('hidden', !state.mobileCartOpen);
}

function switchTab(tabName) {
  const isAdmin = state.currentUser && state.currentUser.role === 'admin';
  if (!isAdmin && ['catalog', 'promos', 'cashiers'].includes(tabName)) {
    showToast('🔒 Acceso exclusivo para Administrador');
    return;
  }

  state.activeTab = tabName;
  if (tabName !== 'pos') {
    toggleMobileCartDrawer(false);
  }

  document.querySelectorAll('.nav-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === tabName);
  });
  document.querySelectorAll('.tab-view').forEach((v) => {
    v.classList.toggle('active', v.id === `tab-${tabName}`);
  });

  const mobileBar = document.getElementById('mobile-cart-bar');
  if (mobileBar) {
    mobileBar.classList.toggle('hidden', tabName !== 'pos' || state.cart.length === 0);
  }

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

function getDistinctCategories() {
  const counts = {};
  state.products.forEach((p) => {
    const c = p.category || 'General';
    counts[c] = (counts[c] || 0) + 1;
  });
  return { list: Object.keys(counts), counts };
}

function syncCategoryCollapseState() {
  const { list } = getDistinctCategories();
  if (!state.categoriesInitialized && list.length > 0) {
    state.categoriesInitialized = true;
    const isMobileOrTablet = window.innerWidth <= 900;
    // En móvil/tablet con muchas categorías/productos, abrir la primera categoría por defecto para evitar saturación visual
    if (isMobileOrTablet && list.length > 1 && state.products.length > 6) {
      list.forEach((cat, idx) => {
        state.collapsedCategories[cat] = idx > 0;
      });
    } else {
      list.forEach((cat) => {
        if (state.collapsedCategories[cat] === undefined) {
          state.collapsedCategories[cat] = false;
        }
      });
    }
  }
}

function updateToggleAllCatsButton() {
  const btn = document.getElementById('btn-toggle-all-cats');
  if (!btn) return;
  const { list } = getDistinctCategories();
  const q = state.searchQuery.trim();
  if (state.selectedCategory !== 'Todos' || q || list.length <= 1) {
    btn.classList.add('hidden');
    return;
  }
  btn.classList.remove('hidden');
  const anyExpanded = list.some((cat) => !state.collapsedCategories[cat]);
  btn.innerHTML = anyExpanded ? '📂 Contraer' : '📂 Expandir';
  btn.title = anyExpanded ? 'Contraer todas las secciones de categoría' : 'Expandir todas las secciones de categoría';
}

function renderCategories() {
  syncCategoryCollapseState();
  const { list, counts } = getDistinctCategories();
  const cats = ['Todos', ...list];

  // Calcular cuántos artículos del carrito pertenecen a cada categoría
  const cartQtyByCat = {};
  for (const item of state.cart) {
    if (item.product_id) {
      const prod = state.products.find((p) => Number(p.id) === Number(item.product_id));
      if (prod) {
        const c = prod.category || 'General';
        cartQtyByCat[c] = (cartQtyByCat[c] || 0) + Number(item.quantity || 0);
      }
    }
  }

  const container = document.getElementById('category-chips');
  container.innerHTML = '';
  cats.forEach((cat) => {
    const btn = document.createElement('button');
    btn.className = `cat-chip ${state.selectedCategory === cat ? 'active' : ''}`;
    const totalCount = cat === 'Todos' ? state.products.length : counts[cat] || 0;
    const inCartCatQty = cat === 'Todos' ? 0 : cartQtyByCat[cat] || 0;
    const cartDot = inCartCatQty > 0 ? `<span class="cat-chip-cart-badge">${inCartCatQty}</span>` : '';
    btn.innerHTML = `<span>${escapeHtml(cat)}</span> <span class="cat-chip-count">${totalCount}</span>${cartDot}`;
    btn.onclick = () => {
      state.selectedCategory = cat;
      if (cat !== 'Todos') {
        state.collapsedCategories[cat] = false;
      }
      renderCategories();
      renderPosProducts();
    };
    container.appendChild(btn);
  });

  updateToggleAllCatsButton();
}

function buildProductCardHtml(p, hideCategoryTag = false) {
  const pType = p.product_type || (p.is_service ? 'servicio' : 'producto');
  const isProduct = pType === 'producto';
  const stockNum = isProduct && p.stock !== null ? Number(p.stock) : null;
  const outOfStock = isProduct && stockNum !== null && stockNum <= 0;

  const inCartItem = state.cart.find((it) => it.product_id && Number(it.product_id) === Number(p.id));
  const inCartQty = inCartItem ? Number(inCartItem.quantity) : 0;

  let badgeHtml = `<span class="prod-stock-badge service">⚡ Servicio</span>`;
  let priceHtml = `<div class="prod-card-price">${formatMoney(p.price)}</div>`;

  if (pType === 'servicio_especial' && p.free_after_sales > 0) {
    const n = Number(p.free_after_sales);
    const cycle = n + 1;
    const effectiveCounter = (Number(p.sales_counter || 0) + inCartQty) % cycle;
    if (effectiveCounter === n) {
      badgeHtml = `<span class="prod-stock-badge free-now">🎁 ¡GRATIS!</span>`;
      priceHtml = `<div class="prod-card-price"><span style="text-decoration:line-through; color:var(--text-muted); font-size:0.8rem; margin-right:4px;">${formatMoney(
        p.price
      )}</span>$0.00</div>`;
    } else {
      badgeHtml = `<span class="prod-stock-badge special">🌟 ${effectiveCounter}/${n}</span>`;
    }
  } else if (isProduct && stockNum !== null) {
    const lowClass = stockNum <= 5 ? 'low' : '';
    badgeHtml = `<span class="prod-stock-badge ${lowClass}">Stock: ${stockNum}</span>`;
  }

  const catTagHtml = hideCategoryTag
    ? ''
    : `<span class="prod-category-tag">${escapeHtml(p.category || 'General')}</span>`;

  const inCartControlsHtml =
    inCartQty > 0
      ? `
        <div class="prod-cart-controls">
          <button type="button" class="prod-minus-btn" data-minus-id="${p.id}" title="Restar 1 del ticket">−</button>
          <span class="prod-in-cart-badge">x${inCartQty}</span>
        </div>
      `
      : '';

  return `
    <div class="product-card ${outOfStock ? 'out-of-stock' : ''} ${inCartQty > 0 ? 'in-cart' : ''}" data-id="${p.id}">
      <div class="prod-card-top">
        ${catTagHtml}
        ${badgeHtml}
      </div>
      <div class="prod-card-name">${escapeHtml(p.name)}</div>
      <div class="prod-card-bottom">
        ${priceHtml}
        ${inCartControlsHtml}
      </div>
    </div>
  `;
}

function attachProductCardEvents(container) {
  container.querySelectorAll('.prod-minus-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = Number(btn.dataset.minusId);
      const item = state.cart.find((it) => it.product_id && Number(it.product_id) === id);
      if (item) {
        updateCartQty(item.key, -1);
      }
    });
  });

  container.querySelectorAll('.product-card').forEach((card) => {
    card.addEventListener('click', () => {
      const id = Number(card.dataset.id);
      const prod = state.products.find((p) => Number(p.id) === id);
      if (prod) addToCart(prod);
    });
  });
}

function renderPosProducts() {
  syncCategoryCollapseState();
  const grid = document.getElementById('pos-products-grid');
  const q = state.searchQuery.toLowerCase().trim();
  const clearSearchBtn = document.getElementById('btn-clear-search');
  if (clearSearchBtn) {
    clearSearchBtn.classList.toggle('hidden', !q);
  }

  updateToggleAllCatsButton();

  const filtered = state.products.filter((p) => {
    const matchCat = state.selectedCategory === 'Todos' || (p.category || 'General') === state.selectedCategory;
    const matchSearch =
      !q || p.name.toLowerCase().includes(q) || (p.category && p.category.toLowerCase().includes(q));
    return matchCat && matchSearch;
  });

  if (filtered.length === 0) {
    grid.className = 'products-grid';
    grid.innerHTML = `<div class="cart-empty" style="grid-column: 1/-1;">No hay productos o servicios que coincidan.</div>`;
    return;
  }

  const { list: distinctCats } = getDistinctCategories();
  const useGroupedAccordion = state.selectedCategory === 'Todos' && !q && distinctCats.length > 1;

  if (useGroupedAccordion) {
    grid.className = 'pos-categories-accordion';
    const grouped = {};
    filtered.forEach((p) => {
      const c = p.category || 'General';
      if (!grouped[c]) grouped[c] = [];
      grouped[c].push(p);
    });

    grid.innerHTML = Object.entries(grouped)
      .map(([catName, items]) => {
        const isCollapsed = Boolean(state.collapsedCategories[catName]);
        const catCartQty = items.reduce((sum, prod) => {
          const inCart = state.cart.find((it) => it.product_id && Number(it.product_id) === Number(prod.id));
          return sum + (inCart ? Number(inCart.quantity) : 0);
        }, 0);
        const cartPillHtml =
          catCartQty > 0
            ? `<span class="cat-in-cart-pill">🛒 ${catCartQty} en ticket</span>`
            : '';

        return `
          <div class="pos-category-group ${isCollapsed ? 'collapsed' : ''}">
            <button type="button" class="pos-cat-group-header" data-cat-group="${escapeHtml(catName)}">
              <div class="pos-cat-group-title">
                <span class="cat-chevron">${isCollapsed ? '▶' : '▼'}</span>
                <strong>📁 ${escapeHtml(catName)}</strong>
                <span class="cat-count-pill">${items.length}</span>
              </div>
              <div class="pos-cat-group-meta">
                ${cartPillHtml}
                <span class="cat-toggle-hint">${isCollapsed ? 'Ver' : 'Ocultar'}</span>
              </div>
            </button>
            <div class="products-grid pos-cat-group-body ${isCollapsed ? 'hidden' : ''}">
              ${items.map((p) => buildProductCardHtml(p, true)).join('')}
            </div>
          </div>
        `;
      })
      .join('');

    grid.querySelectorAll('.pos-cat-group-header').forEach((headerBtn) => {
      headerBtn.addEventListener('click', () => {
        const catName = headerBtn.dataset.catGroup;
        state.collapsedCategories[catName] = !state.collapsedCategories[catName];
        renderPosProducts();
      });
    });

    attachProductCardEvents(grid);
    return;
  }

  // Vista directa cuando se filtra por 1 categoría o cuando se usa el buscador
  grid.className = 'products-grid';
  const hideTag = state.selectedCategory !== 'Todos';
  grid.innerHTML = filtered.map((p) => buildProductCardHtml(p, hideTag)).join('');
  attachProductCardEvents(grid);
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
  renderCategories();
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
  renderCategories();
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

  document.getElementById('mobile-cart-count').textContent = `🛒 ${totalItems} concepto(s)`;
  document.getElementById('mobile-cart-total').textContent = formatMoney(totals.total);
  mobileBar.classList.toggle('hidden', state.activeTab !== 'pos' || state.cart.length === 0);

  if (state.cart.length === 0 && state.mobileCartOpen) {
    toggleMobileCartDrawer(false);
  }

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
// MÓDULO 5: HISTORIAL, CORTE DE CAJA Y DEVOLUCIONES (PUNTOS 1 AL 4)
// ==========================================
let activeReturnDraft = null;

function syncHistoryPeriodInputs() {
  const mode = state.historyPeriod || 'day';
  const dateInput = document.getElementById('history-date');
  const monthInput = document.getElementById('history-month-picker');
  const customBox = document.getElementById('history-custom-range-box');

  if (dateInput) dateInput.classList.toggle('hidden', mode !== 'day');
  if (monthInput) monthInput.classList.toggle('hidden', mode !== 'pick_month');
  if (customBox) customBox.classList.toggle('hidden', mode !== 'custom_range');
}

// ==========================================
// CÁLCULO DE GASTOS (RECURRENTES CON OPCIÓN A QUITAR UN DÍA + PUNTUALES DIARIOS)
// ==========================================
function getCalendarDaysInRange(startDateStr, endDateStr) {
  const todayStr = getTodayLocalISO();
  const effectiveEnd = endDateStr > todayStr ? todayStr : endDateStr;
  if (startDateStr > effectiveEnd) return [startDateStr];

  const days = [];
  const [sy, sm, sd] = startDateStr.split('-').map(Number);
  const [ey, em, ed] = effectiveEnd.split('-').map(Number);
  const curr = new Date(sy, sm - 1, sd);
  const endObj = new Date(ey, em - 1, ed);

  let guard = 0;
  while (curr <= endObj && guard < 800) {
    days.push(toLocalISODate(curr));
    curr.setDate(curr.getDate() + 1);
    guard++;
  }
  return days;
}

function computeExpensesForDateRange(startDateStr, endDateStr) {
  const expData = state.expensesData || { punctual: [], recurring: [], skips: [] };
  const punctualList = expData.punctual || [];
  const recurringList = expData.recurring || [];
  const skipsList = expData.skips || [];

  const skipSet = new Set(skipsList.map((sk) => `${sk.recurring_id}_${sk.skip_date.slice(0, 10)}`));
  const days = getCalendarDaysInRange(startDateStr, endDateStr);

  const effectiveEntries = [];
  let snackTotal = 0;
  let parkingTotal = 0;
  let snackCount = 0;
  let parkingCount = 0;

  // 1. Expandir gastos recurrentes por cada día del rango (excepto días quitados/omitidos)
  for (const rec of recurringList) {
    if (!rec.active) continue;
    const recStart = (rec.start_date || startDateStr).slice(0, 10);
    const cat = rec.category === 'estacionamiento' ? 'estacionamiento' : 'snack';
    const amt = Number(rec.amount || 0);

    for (const dayStr of days) {
      if (dayStr < recStart) continue;
      const isSkipped = skipSet.has(`${rec.id}_${dayStr}`);
      if (!isSkipped) {
        if (cat === 'snack') {
          snackTotal += amt;
          snackCount++;
        } else {
          parkingTotal += amt;
          parkingCount++;
        }
      }
      effectiveEntries.push({
        uid: `rec-${rec.id}-${dayStr}`,
        is_recurring: true,
        recurring_id: rec.id,
        id: rec.id,
        concept: rec.concept,
        category: cat,
        amount: isSkipped ? 0 : amt,
        original_amount: amt,
        is_skipped: isSkipped,
        expense_date: dayStr,
        cashier_name: '🔄 Recurrente Diario',
      });
    }
  }

  // 2. Sumar gastos diarios puntuales
  for (const p of punctualList) {
    const dayStr = (p.expense_date || startDateStr).slice(0, 10);
    if (dayStr < startDateStr || dayStr > endDateStr) continue;
    const cat = p.category === 'estacionamiento' ? 'estacionamiento' : 'snack';
    const amt = Number(p.amount || 0);
    if (cat === 'snack') {
      snackTotal += amt;
      snackCount++;
    } else {
      parkingTotal += amt;
      parkingCount++;
    }
    effectiveEntries.push({
      uid: `punc-${p.id}`,
      is_recurring: false,
      id: p.id,
      concept: p.concept,
      category: cat,
      amount: amt,
      original_amount: amt,
      is_skipped: false,
      expense_date: dayStr,
      cashier_name: p.cashier_name || 'General',
    });
  }

  effectiveEntries.sort((a, b) => b.expense_date.localeCompare(a.expense_date));

  return {
    snackTotal,
    parkingTotal,
    totalExpenses: snackTotal + parkingTotal,
    snackCount,
    parkingCount,
    entries: effectiveEntries,
    skipSet,
  };
}

function renderSalesHistory() {
  const isAdmin = state.currentUser && state.currentUser.role === 'admin';
  const listEl = document.getElementById('sales-history-list');
  const rangeInfo = getActiveHistoryDateRange();

  const openSales = state.sales.filter((s) => !s.cut_id);
  const closedSales = state.sales.filter((s) => Boolean(s.cut_id));
  const hasClosedCutsInView = closedSales.length > 0 || (state.cashCuts && state.cashCuts.length > 0);

  // En vista diaria ("day"), por defecto mostrar el Turno Abierto actual (para que al cerrar turno quede en $0.00)
  // con botón para alternar si desea ver todas las ventas del día incluyendo turnos cerrados
  const filterToOpenTurn = !rangeInfo.isMultiDay && hasClosedCutsInView && !state.showAllDaySalesInHistory;
  const activeSales = filterToOpenTurn ? openSales : state.sales;

  const bannerEl = document.getElementById('history-period-banner');
  if (bannerEl) {
    const toggleViewBtnHtml =
      !rangeInfo.isMultiDay && hasClosedCutsInView
        ? `<button type="button" id="btn-toggle-turn-view" class="chip-btn" style="font-size:0.78rem; padding:0.25rem 0.65rem;">
             ${filterToOpenTurn
               ? `📋 Ver todo el día (${state.sales.length} ventas)`
               : `🟢 Ver solo Turno Activo (${openSales.length} abiertas)`}
           </button>`
        : '';

    bannerEl.innerHTML = `
      <span>
        📅 <strong>${escapeHtml(rangeInfo.label)}</strong> •
        ${filterToOpenTurn
          ? `<strong style="color:var(--success);">🟢 Viendo Turno Activo (${openSales.length} venta(s) abiertas)</strong>`
          : `Operaciones mostradas: <strong>${activeSales.length}</strong>`}
      </span>
      <span style="display:flex; align-items:center; gap:0.5rem; flex-wrap:wrap;">
        ${hasClosedCutsInView ? `<span class="sale-badge tarjeta">🔒 ${state.cashCuts.length} corte(s) cerrado(s)</span>` : ''}
        ${toggleViewBtnHtml}
      </span>
    `;

    const toggleBtn = document.getElementById('btn-toggle-turn-view');
    if (toggleBtn) {
      toggleBtn.addEventListener('click', () => {
        state.showAllDaySalesInHistory = !state.showAllDaySalesInHistory;
        renderSalesHistory();
      });
    }
  }

  const grossSales = activeSales.reduce((sum, s) => sum + Number(s.total), 0);
  const totalRefunded = activeSales.reduce((sum, s) => sum + Number(s.refunded_total || 0), 0);
  const netSales = Math.max(0, grossSales - totalRefunded);

  const cashSalesNet = activeSales
    .filter((s) => s.payment_method === 'efectivo')
    .reduce((sum, s) => sum + Math.max(0, Number(s.total) - Number(s.refunded_total || 0)), 0);
  const digitalSalesNet = activeSales
    .filter((s) => s.payment_method !== 'efectivo')
    .reduce((sum, s) => sum + Math.max(0, Number(s.total) - Number(s.refunded_total || 0)), 0);

  const returnsCount = activeSales.reduce(
    (count, s) => count + ((s.returns && s.returns.length) || (Number(s.refunded_total || 0) > 0 ? 1 : 0)),
    0
  );

  // Calcular gastos del periodo y Dinero Libre (Dinero en Caja - Gastos Snack - Gastos Estacionamiento)
  const expSummary = computeExpensesForDateRange(rangeInfo.startDate, rangeInfo.endDate);
  const freeMoneyTotal = netSales - expSummary.totalExpenses;
  const freeCashHand = cashSalesNet - expSummary.totalExpenses;

  document.getElementById('kpi-total-sales').textContent = formatMoney(netSales);
  document.getElementById('kpi-sales-count').textContent =
    totalRefunded > 0
      ? `${activeSales.length} venta(s) • Bruto: ${formatMoney(grossSales)}`
      : `${activeSales.length} venta(s) ${filterToOpenTurn ? 'en turno activo' : 'registrada(s)'}`;
  document.getElementById('kpi-cash-sales').textContent = formatMoney(cashSalesNet);
  document.getElementById('kpi-digital-sales').textContent = formatMoney(digitalSalesNet);

  const kpiRetTotalEl = document.getElementById('kpi-returns-total');
  const kpiRetCountEl = document.getElementById('kpi-returns-count');
  if (kpiRetTotalEl) kpiRetTotalEl.textContent = `-${formatMoney(totalRefunded)}`;
  if (kpiRetCountEl) kpiRetCountEl.textContent = `${returnsCount} devolución(es) en vista`;

  const kpiSnackEl = document.getElementById('kpi-expenses-snack');
  const kpiSnackSubEl = document.getElementById('kpi-expenses-snack-sub');
  const kpiParkingEl = document.getElementById('kpi-expenses-parking');
  const kpiParkingSubEl = document.getElementById('kpi-expenses-parking-sub');
  const kpiFreeMoneyEl = document.getElementById('kpi-free-money-total');
  const kpiFreeCashEl = document.getElementById('kpi-free-cash-hand');

  if (kpiSnackEl) kpiSnackEl.textContent = `-${formatMoney(expSummary.snackTotal)}`;
  if (kpiSnackSubEl) kpiSnackSubEl.textContent = `${expSummary.snackCount} cargo(s) de snack`;
  if (kpiParkingEl) kpiParkingEl.textContent = `-${formatMoney(expSummary.parkingTotal)}`;
  if (kpiParkingSubEl) kpiParkingSubEl.textContent = `${expSummary.parkingCount} cargo(s) de estacionamiento`;
  if (kpiFreeMoneyEl) {
    kpiFreeMoneyEl.textContent = formatMoney(freeMoneyTotal);
    kpiFreeMoneyEl.style.color = freeMoneyTotal < 0 ? '#fca5a5' : '#34d399';
  }
  if (kpiFreeCashEl) {
    kpiFreeCashEl.textContent = formatMoney(freeCashHand);
    kpiFreeCashEl.style.color = freeCashHand < 0 ? '#fca5a5' : '#93c5fd';
  }

  renderExpensesSection(rangeInfo, expSummary, isAdmin);

  // Renderizar tabla de Cortes Cerrados en el periodo
  const closedCutsBox = document.getElementById('closed-cuts-box');
  const closedCutsTbody = document.getElementById('closed-cuts-tbody');
  if (closedCutsBox && closedCutsTbody) {
    const cuts = state.cashCuts || [];
    closedCutsBox.classList.toggle('hidden', cuts.length === 0);
    if (cuts.length > 0) {
      closedCutsTbody.innerHTML = cuts
        .map((c) => {
          const dt = new Date(c.created_at);
          const timeLabel = rangeInfo.isMultiDay
            ? dt.toLocaleDateString('es-MX', { day: '2-digit', month: '2-digit', year: 'numeric' }) +
              ' ' +
              dt.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })
            : dt.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
          const diff = Number(c.cash_difference || 0);
          let diffHtml = `<span style="color:var(--success); font-weight:700;">✅ Exacto ($0.00)</span>`;
          if (diff > 0.009) {
            diffHtml = `<span style="color:#6ee7b7; font-weight:700;">🟢 Sobrante +${formatMoney(diff)}</span>`;
          } else if (diff < -0.009) {
            diffHtml = `<span style="color:#fca5a5; font-weight:700;">🔴 Faltante -${formatMoney(Math.abs(diff))}</span>`;
          }
          const cSnack = Number(c.expenses_snack || 0);
          const cParking = Number(c.expenses_parking || 0);
          const cFree = Number(c.free_money ?? Number(c.net_sales) - cSnack - cParking);
          return `
            <tr>
              <td><strong>🔒 Corte #${c.id}</strong><div style="font-size:0.75rem; color:var(--text-muted);">🕒 ${timeLabel} (${c.sales_count} vta)</div></td>
              <td><strong>🧑‍💼 ${escapeHtml(c.cashier_name)}</strong>${c.note ? `<div style="font-size:0.75rem; color:var(--text-muted);">Nota: ${escapeHtml(c.note)}</div>` : ''}</td>
              <td><strong style="color:var(--primary);">${formatMoney(c.net_sales)}</strong></td>
              <td style="color:#fcd34d;">-${formatMoney(cSnack)}</td>
              <td style="color:#f9a8d4;">-${formatMoney(cParking)}</td>
              <td><strong style="color:var(--success);">${formatMoney(cFree)}</strong></td>
              <td><strong>${formatMoney(c.counted_cash)}</strong></td>
              <td>${diffHtml}</td>
              <td>
                <button type="button" class="btn btn-secondary btn-sm btn-print-closed-cut" data-cut-id="${c.id}">
                  🧾 Ver / Imprimir
                </button>
              </td>
            </tr>
          `;
        })
        .join('');

      closedCutsTbody.querySelectorAll('.btn-print-closed-cut').forEach((btn) => {
        btn.addEventListener('click', () => {
          const cut = (state.cashCuts || []).find((c) => String(c.id) === String(btn.dataset.cutId));
          if (cut) showClosedCutTicketModal(cut);
        });
      });
    }
  }

  // Tabla de Resumen Agrupado por Periodo (Por Mes / Por Semana / Por Día) con Gastos Snack, Estacionamiento y Dinero Libre
  const periodSummaryBox = document.getElementById('period-summary-box');
  if (periodSummaryBox) {
    periodSummaryBox.classList.toggle('hidden', !rangeInfo.isMultiDay);
    if (rangeInfo.isMultiDay) {
      const groupBy = state.periodGroupBy || 'month';
      document.querySelectorAll('.period-group-btn').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.group === groupBy);
      });
      const colHeader = document.getElementById('period-col-header');
      if (colHeader) {
        colHeader.textContent =
          groupBy === 'day' ? 'Día' : groupBy === 'week' ? 'Semana' : 'Mes / Año';
      }

      const byBucket = {};
      for (const s of state.sales) {
        const b = getSalePeriodBucket(s.created_at, groupBy);
        if (!byBucket[b.key]) {
          byBucket[b.key] = { label: b.label, count: 0, net: 0, expSnack: 0, expParking: 0 };
        }
        const saleRefund = Number(s.refunded_total || 0);
        const saleNet = Math.max(0, Number(s.total) - saleRefund);
        byBucket[b.key].count += 1;
        byBucket[b.key].net += saleNet;
      }

      // Agregar gastos (recurrentes activos y puntuales) a su cubo de fecha correspondiente
      for (const exp of expSummary.entries) {
        if (exp.is_skipped) continue;
        const b = getSalePeriodBucket(`${exp.expense_date}T12:00:00`, groupBy);
        if (!byBucket[b.key]) {
          byBucket[b.key] = { label: b.label, count: 0, net: 0, expSnack: 0, expParking: 0 };
        }
        if (exp.category === 'snack') {
          byBucket[b.key].expSnack += Number(exp.amount || 0);
        } else {
          byBucket[b.key].expParking += Number(exp.amount || 0);
        }
      }

      const bucketKeys = Object.keys(byBucket).sort((a, b) => b.localeCompare(a));
      const periodTbody = document.getElementById('period-summary-tbody');
      if (bucketKeys.length === 0) {
        periodTbody.innerHTML = `<tr><td colspan="6" style="text-align:center;">Sin movimientos registrados en este periodo</td></tr>`;
      } else {
        periodTbody.innerHTML = bucketKeys
          .map((k) => {
            const row = byBucket[k];
            const freeRow = row.net - row.expSnack - row.expParking;
            return `
              <tr>
                <td><strong>${escapeHtml(row.label)}</strong></td>
                <td>${row.count} venta(s)</td>
                <td><strong style="color:var(--primary);">${formatMoney(row.net)}</strong></td>
                <td style="color:#fcd34d;">-${formatMoney(row.expSnack)}</td>
                <td style="color:#f9a8d4;">-${formatMoney(row.expParking)}</td>
                <td><strong style="color:${freeRow < 0 ? '#fca5a5' : 'var(--success)'};">${formatMoney(freeRow)}</strong></td>
              </tr>
            `;
          })
          .join('');
      }
    }
  }

  if (isAdmin) {
    const byCashier = {};
    for (const s of activeSales) {
      const cName = s.cashier_name || 'General';
      if (!byCashier[cName]) {
        byCashier[cName] = { count: 0, cash: 0, digital: 0, refunded: 0, net: 0 };
      }
      const saleRefund = Number(s.refunded_total || 0);
      const saleNet = Math.max(0, Number(s.total) - saleRefund);
      byCashier[cName].count += 1;
      byCashier[cName].refunded += saleRefund;
      byCashier[cName].net += saleNet;
      if (s.payment_method === 'efectivo') {
        byCashier[cName].cash += saleNet;
      } else {
        byCashier[cName].digital += saleNet;
      }
    }
    const breakdownTbody = document.getElementById('cashier-breakdown-tbody');
    const names = Object.keys(byCashier);
    if (names.length === 0) {
      breakdownTbody.innerHTML = `<tr><td colspan="6" style="text-align:center;">Sin ventas abiertas en este turno</td></tr>`;
    } else {
      breakdownTbody.innerHTML = names
        .map(
          (name) => `
          <tr>
            <td><strong>🧑‍💼 ${escapeHtml(name)}</strong></td>
            <td>${byCashier[name].count} venta(s)</td>
            <td><strong>${formatMoney(byCashier[name].cash)}</strong></td>
            <td>${formatMoney(byCashier[name].digital)}</td>
            <td style="color:#fca5a5;">${byCashier[name].refunded > 0 ? `-${formatMoney(byCashier[name].refunded)}` : '$0.00'}</td>
            <td><strong style="color:var(--success)">${formatMoney(byCashier[name].net)}</strong></td>
          </tr>
        `
        )
        .join('');
    }
  }

  if (activeSales.length === 0) {
    listEl.innerHTML = `<div class="cart-empty">${
      filterToOpenTurn
        ? '✅ El turno actual ya fue cerrado y está en $0.00 (listo para nuevas ventas). Puedes ver o imprimir los cortes cerrados arriba.'
        : `No hay ventas registradas para mostrar en ${escapeHtml(rangeInfo.label)}.`
    }</div>`;
    return;
  }

  listEl.innerHTML = activeSales
    .map((s) => {
      const dObj = new Date(s.created_at);
      const timeStr = rangeInfo.isMultiDay
        ? dObj.toLocaleDateString('es-MX', { day: '2-digit', month: '2-digit', year: 'numeric' }) +
          ' ' +
          dObj.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })
        : dObj.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
      const itemsSummary = (s.items || [])
        .map((it) => {
          const retQty = Number(it.returned_qty || 0);
          const retLabel = retQty > 0 ? ` [↩️ ${retQty} dev.]` : '';
          return `${it.quantity}x ${it.product_name}${it.is_free_reward ? ' (🎁 Gratis)' : ''}${retLabel}`;
        })
        .join(', ');

      const pendingBadge = s.pending_sync
        ? `<span class="sale-badge transferencia">⏳ Guardada en equipo (Pendiente subir)</span>`
        : '';
      const cutBadge = s.cut_id
        ? `<span class="sale-badge tarjeta">🔒 Cerrada en Corte #${s.cut_id}</span>`
        : '';

      const refundedAmt = Number(s.refunded_total || 0);
      const netSaleAmt = Math.max(0, Number(s.total) - refundedAmt);
      const status = s.status || 'completada';

      let statusBadge = '';
      if (status === 'devuelta_total') {
        statusBadge = `<span class="sale-badge devuelta_total">🔴 DEVUELTA TOTAL (-${formatMoney(refundedAmt)})</span>`;
      } else if (status === 'devuelta_parcial' || refundedAmt > 0) {
        statusBadge = `<span class="sale-badge devuelta_parcial">🟠 DEVUELTA PARCIAL (-${formatMoney(refundedAmt)})</span>`;
      }

      const returnsHistoryHtml =
        s.returns && s.returns.length > 0
          ? `<div class="sale-returns-box">
               ${s.returns
            .map((ret) => {
              const rTime = new Date(ret.created_at).toLocaleTimeString('es-MX', {
                hour: '2-digit',
                minute: '2-digit',
              });
              return `<div>
                     <strong>↩️ [${rTime}] Reembolso -${formatMoney(ret.refund_amount)}:</strong>
                     ${escapeHtml(ret.items_summary)} •
                     <em>Motivo: ${escapeHtml(ret.reason)}</em> •
                     🛡️ Autorizó: <strong>${escapeHtml(ret.authorized_by_name)}</strong>
                     (Turno: ${escapeHtml(ret.processed_by_name)})
                   </div>`;
            })
            .join('')}
             </div>`
          : '';

      const canReturn = status !== 'devuelta_total';

      return `
        <div class="sale-card">
          <div style="flex:1; min-width:260px;">
            <div class="sale-card-header">
              <strong>Folio #${s.id}</strong>
              <span class="sale-badge ${s.payment_method}">${s.payment_method}</span>
              <span class="cashier-tag">🧑‍💼 ${escapeHtml(s.cashier_name || 'General')}</span>
              ${statusBadge}
              ${cutBadge}
              ${pendingBadge}
              <span style="color:var(--text-muted); font-size:0.85rem;">🕒 ${timeStr}</span>
            </div>
            <div class="sale-items-summary">${escapeHtml(itemsSummary || 'Venta general')}</div>
            <div class="sale-meta">
              ${Number(s.discount_total) > 0
          ? `<span style="color:var(--success); font-weight:700;">🎁 ${escapeHtml(
            s.promo_summary || 'Descuento promo'
          )} • </span>`
          : ''
        }
              ${s.payment_method === 'efectivo'
          ? `Recibido: ${formatMoney(s.amount_received)} | Cambio: ${formatMoney(s.change_given)}`
          : `Cobro con ${s.payment_method}`
        }
              ${s.note ? ` • Nota: ${escapeHtml(s.note)}` : ''}
            </div>
            ${returnsHistoryHtml}
          </div>
          <div class="sale-card-right">
            <div style="text-align:right;">
              ${refundedAmt > 0
          ? `<div style="font-size:0.78rem; color:var(--text-muted); text-decoration:line-through;">Bruto: ${formatMoney(
            s.total
          )}</div>`
          : ''
        }
              <span class="sale-total-amount" style="${status === 'devuelta_total' ? 'color:#fca5a5;' : ''}">
                ${formatMoney(netSaleAmt)}
              </span>
            </div>
            <button class="btn btn-secondary btn-sm btn-view-ticket" data-id="${s.id}">🧾 Ticket</button>
            ${canReturn
          ? `<button class="btn btn-danger btn-sm btn-open-return" data-id="${s.id}">↩️ Devolver</button>`
          : ''
        }
            ${isAdmin
          ? `<button class="btn btn-danger btn-sm btn-delete-sale" data-id="${s.id}" title="Eliminar folio permanentemente (Solo Admin)">🗑️ Eliminar</button>`
          : ''
        }
          </div>
        </div>
      `;
    })
    .join('');

  listEl.querySelectorAll('.btn-view-ticket').forEach((btn) => {
    btn.addEventListener('click', () => {
      const sale = state.sales.find((s) => String(s.id) === String(btn.dataset.id));
      if (sale) showSaleTicketModal(sale);
    });
  });

  listEl.querySelectorAll('.btn-open-return').forEach((btn) => {
    btn.addEventListener('click', () => {
      const sale = state.sales.find((s) => String(s.id) === String(btn.dataset.id));
      if (sale) openReturnModal(sale);
    });
  });

  listEl.querySelectorAll('.btn-delete-sale').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const sale = state.sales.find((s) => String(s.id) === String(btn.dataset.id));
      if (!sale) return;
      const msg =
        `¿Estás seguro de ELIMINAR permanentemente el Folio #${sale.id} por ${formatMoney(sale.total)}?\n\n` +
        `Esta acción borrará el registro de la base de datos y devolverá el stock de sus productos.`;
      if (!confirm(msg)) return;
      try {
        await DataService.deleteSale(sale.id);
        await Promise.all([loadProducts(), loadSales()]);
        showToast(`🗑️ Folio #${sale.id} eliminado permanentemente`);
      } catch (err) {
        showToast(`❌ Error al eliminar folio: ${err.message}`);
      }
    });
  });
}

function openReturnModal(sale) {
  const isAdmin = state.currentUser && state.currentUser.role === 'admin';
  const remainingSaleBalance = Math.max(0, Number(sale.total) - Number(sale.refunded_total || 0));

  // Construir borrador de conceptos disponibles para devolver (pre-seleccionando todos por defecto para agilizar)
  const draftItems = (sale.items || [])
    .map((it) => {
      const alreadyReturned = Number(it.returned_qty || 0);
      const availableQty = Math.max(0, Number(it.quantity) - alreadyReturned);
      const prod = it.product_id ? state.products.find((p) => Number(p.id) === Number(it.product_id)) : null;
      const isPhysicalProduct = prod
        ? (prod.product_type || (prod.is_service ? 'servicio' : 'producto')) === 'producto' && prod.stock !== null
        : false;
      const effectiveUnitPaid = Number(it.quantity) > 0 ? Number(it.subtotal) / Number(it.quantity) : Number(it.unit_price);

      return {
        sale_item_id: it.id,
        product_id: it.product_id,
        product_name: it.product_name,
        original_qty: Number(it.quantity),
        already_returned: alreadyReturned,
        available_qty: availableQty,
        return_qty: 0,
        unit_price_effective: effectiveUnitPaid,
        is_physical: isPhysicalProduct,
        return_to_stock: true,
      };
    })
    .filter((it) => it.available_qty > 0);

  if (draftItems.length === 0) {
    showToast('⚠️ Todos los artículos de esta venta ya fueron devueltos.');
    return;
  }

  // Si el ticket solo tiene 1 artículo con 1 pieza disponible, pre-seleccionarlo; si tiene más, iniciar en 0 para elegir 1 o 2 (o usar "Seleccionar Todo")
  if (draftItems.length === 1 && draftItems[0].available_qty === 1) {
    draftItems[0].return_qty = 1;
  }

  activeReturnDraft = {
    sale,
    remainingSaleBalance,
    items: draftItems,
  };

  document.getElementById('return-sale-id').value = sale.id;
  document.getElementById('modal-return-title').textContent = `↩️ Devolución de Venta Folio #${sale.id}`;
  document.getElementById('modal-return-subtitle').textContent = `Cobrada por ${sale.cashier_name || 'General'
    } (${sale.payment_method.toUpperCase()}) • Saldo disponible a devolver: ${formatMoney(remainingSaleBalance)}`;

  document.getElementById('return-reason').value = '';
  document.getElementById('return-admin-pin').value = '';

  const pinGroup = document.getElementById('return-admin-pin-group');
  const directBadge = document.getElementById('return-admin-direct-badge');
  if (isAdmin) {
    pinGroup.classList.add('hidden');
    directBadge.classList.remove('hidden');
    directBadge.textContent = `🛡️ Sesión de Administrador activa (${state.currentUser.name}): Autorización directa habilitada.`;
  } else {
    pinGroup.classList.remove('hidden');
    directBadge.classList.add('hidden');
  }

  renderReturnModalItems();
  document.getElementById('modal-return').classList.remove('hidden');
}

function renderReturnModalItems() {
  if (!activeReturnDraft) return;
  const listEl = document.getElementById('return-items-list');

  listEl.innerHTML = activeReturnDraft.items
    .map((it, idx) => {
      const isSelected = it.return_qty > 0;
      const stockSelectorHtml = it.is_physical
        ? `<select class="return-stock-select" data-idx="${idx}">
             <option value="stock" ${it.return_to_stock ? 'selected' : ''}>📦 Regresar a Stock vendible</option>
             <option value="merma" ${!it.return_to_stock ? 'selected' : ''}>⚠️ Merma / Dañado (No sumar a stock)</option>
           </select>`
        : `<span style="font-size:0.76rem; color:var(--text-muted);">⚡ Servicio</span>`;

      return `
        <div class="return-item-row ${isSelected ? 'active-return' : ''}">
          <div style="flex:1; min-width:180px;">
            <div style="font-weight:700; font-size:0.92rem;">${escapeHtml(it.product_name)}</div>
            <div style="font-size:0.78rem; color:var(--text-muted);">
              Disponibles para devolver: <strong>${it.available_qty}</strong> de ${it.original_qty}
              • (${formatMoney(it.unit_price_effective)} c/u)
            </div>
          </div>
          <div>${stockSelectorHtml}</div>
          <div class="cart-item-controls">
            <button type="button" class="qty-btn btn-ret-qty" data-idx="${idx}" data-delta="-1">−</button>
            <span class="qty-val">${it.return_qty}</span>
            <button type="button" class="qty-btn btn-ret-qty" data-idx="${idx}" data-delta="1">+</button>
          </div>
        </div>
      `;
    })
    .join('');

  listEl.querySelectorAll('.btn-ret-qty').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.dataset.idx);
      const delta = Number(btn.dataset.delta);
      const item = activeReturnDraft.items[idx];
      if (!item) return;
      item.return_qty = Math.max(0, Math.min(item.available_qty, item.return_qty + delta));
      renderReturnModalItems();
    });
  });

  listEl.querySelectorAll('.return-stock-select').forEach((sel) => {
    sel.addEventListener('change', (e) => {
      const idx = Number(sel.dataset.idx);
      const item = activeReturnDraft.items[idx];
      if (!item) return;
      item.return_to_stock = e.target.value === 'stock';
    });
  });

  // Calcular reembolso proporcional sugerido
  const allSelectedFull = activeReturnDraft.items.every((it) => it.return_qty === it.available_qty);
  const btnSelectAll = document.getElementById('btn-return-select-all');
  if (btnSelectAll) {
    btnSelectAll.textContent = allSelectedFull
      ? 'Limpiar Selección (Elegir Piezas)'
      : 'Seleccionar Todo (Devolución Total)';
  }
  let suggestedRefund = 0;
  if (allSelectedFull) {
    suggestedRefund = activeReturnDraft.remainingSaleBalance;
  } else {
    const rawSum = activeReturnDraft.items.reduce(
      (sum, it) => sum + it.return_qty * it.unit_price_effective,
      0
    );
    const saleSubtotal = Number(activeReturnDraft.sale.subtotal || activeReturnDraft.sale.total || 1);
    const ratio = saleSubtotal > 0 ? Number(activeReturnDraft.sale.total) / saleSubtotal : 1;
    suggestedRefund = Math.min(activeReturnDraft.remainingSaleBalance, rawSum * ratio);
  }

  const refundInput = document.getElementById('return-refund-amount');
  refundInput.max = activeReturnDraft.remainingSaleBalance.toFixed(2);
  refundInput.value = suggestedRefund.toFixed(2);
}

function showSaleTicketModal(sale) {
  const dateStr = new Date(sale.created_at).toLocaleString('es-MX');
  const itemsHtml = (sale.items || [])
    .map((it) => {
      const retQty = Number(it.returned_qty || 0);
      return `
      <div style="display:flex; justify-content:space-between; margin: 4px 0;">
        <span>${it.quantity} x ${escapeHtml(it.product_name)}${it.is_free_reward ? ' (🎁 PROMO GRATIS)' : ''}${retQty > 0 ? ` (↩️ ${retQty} dev.)` : ''
        }</span>
        <strong>${formatMoney(it.subtotal)}</strong>
      </div>`;
    })
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

  const refundedAmt = Number(sale.refunded_total || 0);
  const netTotal = Math.max(0, Number(sale.total) - refundedAmt);

  const returnsTicketHtml =
    refundedAmt > 0
      ? `<div style="border-top:1px dashed #9ca3af; margin-top:6px; padding-top:6px;">
           <div style="display:flex; justify-content:space-between;">
             <span>↩️ Devoluciones:</span>
             <strong>-${formatMoney(refundedAmt)}</strong>
           </div>
           ${(sale.returns || [])
        .map(
          (r) =>
            `<div style="font-size:0.75rem; margin-top:2px;">• ${escapeHtml(r.items_summary)} (${escapeHtml(
              r.reason
            )}) - Autorizó: ${escapeHtml(r.authorized_by_name)}</div>`
        )
        .join('')}
           <div style="display:flex; justify-content:space-between; font-weight:bold; margin-top:4px;">
             <span>TOTAL NETO:</span>
             <span>${formatMoney(netTotal)}</span>
           </div>
         </div>`
      : '';

  document.getElementById('receipt-title').textContent = `Ticket de Venta #${sale.id}`;
  document.getElementById('receipt-content').innerHTML = `
    <div style="text-align:center; border-bottom:1px dashed #9ca3af; padding-bottom:8px; margin-bottom:8px;">
      <h3 style="margin:0;">PUNTO DE VENTA CARLOS</h3>
      <div>Folio #${sale.id} ${sale.status === 'devuelta_total'
      ? '(DEVUELTA TOTAL)'
      : sale.status === 'devuelta_parcial'
        ? '(DEVUELTA PARCIAL)'
        : ''
    }</div>
      <div>Atendió: <strong>${escapeHtml(sale.cashier_name || 'General')}</strong></div>
      <div style="font-size:0.8rem;">${dateStr}</div>
    </div>
    <div style="border-bottom:1px dashed #9ca3af; padding-bottom:8px; margin-bottom:8px;">
      ${itemsHtml}
    </div>
    ${discountHtml}
    <div style="display:flex; justify-content:space-between; font-size:1.1rem; font-weight:bold;">
      <span>TOTAL COBRADO:</span>
      <span>${formatMoney(sale.total)}</span>
    </div>
    ${returnsTicketHtml}
    <div style="margin-top:6px; font-size:0.85rem;">
      <div>Método de pago: <strong>${sale.payment_method.toUpperCase()}</strong></div>
      ${sale.payment_method === 'efectivo'
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

function renderExpensesSection(rangeInfo, expSummary, isAdmin) {
  const recBar = document.getElementById('recurring-expenses-bar');
  const tbody = document.getElementById('expenses-table-tbody');
  if (!recBar || !tbody) return;

  const recurringList = (state.expensesData && state.expensesData.recurring) || [];
  const activeDayStr = rangeInfo.startDate;

  if (recurringList.length === 0) {
    recBar.innerHTML = `<div style="font-size:0.82rem; color:var(--text-muted);">No hay gastos diarios recurrentes configurados (Ej. Sueldo del tendero). Puedes agregar uno con "+ Nuevo Gasto".</div>`;
  } else {
    recBar.innerHTML = recurringList
      .map((rec) => {
        const catLabel = rec.category === 'estacionamiento' ? '🚗 Estacionamiento' : '🍿 Snack';
        const isSkippedOnActiveDay = expSummary.skipSet.has(`${rec.id}_${activeDayStr}`);
        const dayActionBtn = !rangeInfo.isMultiDay
          ? `<button type="button" class="btn btn-sm ${isSkippedOnActiveDay ? 'btn-primary' : 'btn-secondary'} btn-toggle-rec-skip" data-rec-id="${rec.id}" data-date="${activeDayStr}" data-skip="${!isSkippedOnActiveDay}">
               ${isSkippedOnActiveDay ? `↩️ Reactivar el ${activeDayStr}` : `🚫 Quitar el ${activeDayStr} (No acudió)`}
             </button>`
          : `<span style="font-size:0.76rem; color:var(--text-muted);">Selecciona "Por Día" para quitar un día específico</span>`;

        const adminDelRecBtn = isAdmin
          ? `<button type="button" class="btn btn-danger btn-sm btn-del-rec-template" data-rec-id="${rec.id}" title="Eliminar gasto recurrente permanentemente (Solo Admin)">🗑️ Eliminar Recurrente</button>`
          : '';

        return `
          <div class="recurring-exp-item ${!rangeInfo.isMultiDay && isSkippedOnActiveDay ? 'skipped' : ''}">
            <div style="display:flex; align-items:center; gap:0.55rem; flex-wrap:wrap;">
              <strong>🔄 ${escapeHtml(rec.concept)}</strong>
              <span class="exp-cat-badge ${rec.category}">${catLabel}</span>
              <strong style="color:#fcd34d;">-${formatMoney(rec.amount)} / día</strong>
              ${
                !rangeInfo.isMultiDay && isSkippedOnActiveDay
                  ? `<span class="sale-badge devuelta_parcial">⏸️ OMITIDO ESTE DÍA ($0.00)</span>`
                  : `<span class="sale-badge efectivo">✅ ACTIVO</span>`
              }
            </div>
            <div style="display:flex; align-items:center; gap:0.45rem; flex-wrap:wrap;">
              ${dayActionBtn}
              ${adminDelRecBtn}
            </div>
          </div>
        `;
      })
      .join('');

    recBar.querySelectorAll('.btn-toggle-rec-skip').forEach((btn) => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        const recId = Number(btn.dataset.recId);
        const dateStr = btn.dataset.date;
        const shouldSkip = btn.dataset.skip === 'true';
        const userName = state.currentUser ? state.currentUser.name : 'General';
        await DataService.toggleRecurringExpenseSkip(recId, dateStr, shouldSkip, userName);
        await loadSales();
        showToast(shouldSkip ? `🚫 Gasto recurrente quitado para el día ${dateStr}` : `✅ Gasto recurrente reactivado para el día ${dateStr}`);
      });
    });

    recBar.querySelectorAll('.btn-del-rec-template').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const recId = Number(btn.dataset.recId);
        const rec = recurringList.find((r) => Number(r.id) === recId);
        if (!rec) return;
        if (!confirm(`¿Eliminar permanentemente el gasto recurrente "${rec.concept}" (${formatMoney(rec.amount)}/día)?`)) return;
        btn.disabled = true;
        await DataService.deleteRecurringExpense(recId);
        await loadSales();
        showToast(`🗑️ Gasto recurrente "${rec.concept}" eliminado`);
      });
    });
  }

  if (expSummary.entries.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; padding:1.25rem; color:var(--text-muted);">No hay gastos registrados en este periodo.</td></tr>`;
    return;
  }

  tbody.innerHTML = expSummary.entries
    .map((e) => {
      const catLabel = e.category === 'estacionamiento' ? '🚗 Estacionamiento' : '🍿 Snack';
      const typeTag = e.is_recurring
        ? `<span class="sale-badge tarjeta">🔄 Recurrente</span>`
        : `<span class="sale-badge transferencia">🛒 Puntual</span>`;

      let actionHtml = '<span style="color:var(--text-muted); font-size:0.78rem;">—</span>';
      if (e.is_recurring) {
        actionHtml = `
          <button type="button" class="btn btn-sm ${e.is_skipped ? 'btn-primary' : 'btn-secondary'} btn-row-rec-skip" data-rec-id="${e.recurring_id}" data-date="${e.expense_date}" data-skip="${!e.is_skipped}">
            ${e.is_skipped ? '↩️ Reactivar día' : '🚫 Quitar este día'}
          </button>
        `;
      } else if (isAdmin) {
        actionHtml = `
          <button type="button" class="btn btn-danger btn-sm btn-del-punctual-exp" data-exp-id="${e.id}" title="Eliminar gasto (Solo Admin)">
            🗑️ Eliminar
          </button>
        `;
      }

      return `
        <tr style="${e.is_skipped ? 'opacity:0.55; text-decoration:line-through;' : ''}">
          <td><strong>📅 ${escapeHtml(e.expense_date)}</strong><div style="margin-top:3px;">${typeTag}</div></td>
          <td><strong>${escapeHtml(e.concept)}</strong></td>
          <td><span class="exp-cat-badge ${e.category}">${catLabel}</span></td>
          <td>${escapeHtml(e.cashier_name)}</td>
          <td><strong style="color:${e.is_skipped ? 'var(--text-muted)' : '#fca5a5'};">${e.is_skipped ? '$0.00 (Omitido)' : `-${formatMoney(e.amount)}`}</strong></td>
          <td>${actionHtml}</td>
        </tr>
      `;
    })
    .join('');

  tbody.querySelectorAll('.btn-row-rec-skip').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const recId = Number(btn.dataset.recId);
      const dateStr = btn.dataset.date;
      const shouldSkip = btn.dataset.skip === 'true';
      const userName = state.currentUser ? state.currentUser.name : 'General';
      await DataService.toggleRecurringExpenseSkip(recId, dateStr, shouldSkip, userName);
      await loadSales();
      showToast(shouldSkip ? `🚫 Gasto recurrente quitado el ${dateStr}` : `✅ Gasto recurrente reactivado el ${dateStr}`);
    });
  });

  tbody.querySelectorAll('.btn-del-punctual-exp').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const expId = Number(btn.dataset.expId);
      const exp = expSummary.entries.find((x) => !x.is_recurring && Number(x.id) === expId);
      if (!exp) return;
      if (!confirm(`¿Estás seguro de ELIMINAR el gasto "${exp.concept}" por -${formatMoney(exp.amount)} del día ${exp.expense_date}?`)) return;
      btn.disabled = true;
      await DataService.deleteExpense(expId);
      await loadSales();
      showToast(`🗑️ Gasto "${exp.concept}" eliminado`);
    });
  });
}

function showDailyCorteModal() {
  const rangeInfo = getActiveHistoryDateRange();
  const grossSales = state.sales.reduce((sum, s) => sum + Number(s.total), 0);
  const totalRefunded = state.sales.reduce((sum, s) => sum + Number(s.refunded_total || 0), 0);
  const netSales = Math.max(0, grossSales - totalRefunded);

  const cashSales = state.sales
    .filter((s) => s.payment_method === 'efectivo')
    .reduce((sum, s) => sum + Math.max(0, Number(s.total) - Number(s.refunded_total || 0)), 0);
  const cardSales = state.sales
    .filter((s) => s.payment_method === 'tarjeta')
    .reduce((sum, s) => sum + Math.max(0, Number(s.total) - Number(s.refunded_total || 0)), 0);
  const transferSales = state.sales
    .filter((s) => s.payment_method === 'transferencia')
    .reduce((sum, s) => sum + Math.max(0, Number(s.total) - Number(s.refunded_total || 0)), 0);

  const expSummary = computeExpensesForDateRange(rangeInfo.startDate, rangeInfo.endDate);
  const freeMoneyTotal = netSales - expSummary.totalExpenses;
  const freeCashInHand = cashSales - expSummary.totalExpenses;

  const allReturns = [];
  for (const s of state.sales) {
    for (const r of s.returns || []) {
      allReturns.push({ saleId: s.id, ...r });
    }
  }

  const isAdmin = state.currentUser && state.currentUser.role === 'admin';
  const scopeLabel = !isAdmin
    ? `Cajero: ${state.currentUser.name}`
    : state.selectedCashierFilter === 'all'
    ? 'Todos los Cajeros (General)'
    : `Cajero filtrado`;

  const activeExpensesList = expSummary.entries.filter((e) => !e.is_skipped);
  const expensesDetailHtml =
    activeExpensesList.length > 0
      ? `<div style="border-bottom:1px dashed #9ca3af; padding-bottom:8px; margin-bottom:8px; font-size:0.8rem;">
           <strong>DETALLE DE GASTOS (${activeExpensesList.length}):</strong>
           ${activeExpensesList
             .map(
               (e) =>
                 `<div style="display:flex; justify-content:space-between; margin-top:3px;">
                    <span>• [${e.category.toUpperCase()}] ${escapeHtml(e.concept)} (${e.expense_date}):</span>
                    <strong>-${formatMoney(e.amount)}</strong>
                  </div>`
             )
             .join('')}
         </div>`
      : '';

  const returnsDetailHtml =
    allReturns.length > 0
      ? `<div style="border-bottom:1px dashed #9ca3af; padding-bottom:8px; margin-bottom:8px; font-size:0.8rem;">
           <strong>DETALLE DE DEVOLUCIONES (${allReturns.length}):</strong>
           ${allReturns
             .map(
               (r) =>
                 `<div style="margin-top:4px;">
                    • Folio #${r.saleId}: <strong>-${formatMoney(r.refund_amount)}</strong> (${escapeHtml(
                   r.items_summary
                 )})<br/>
                    Motivo: ${escapeHtml(r.reason)} | Autorizó: ${escapeHtml(r.authorized_by_name)}
                  </div>`
             )
             .join('')}
         </div>`
      : '';

  document.getElementById('receipt-title').textContent = `Reporte / Corte (${rangeInfo.label})`;
  document.getElementById('receipt-content').innerHTML = `
    <div style="text-align:center; border-bottom:1px dashed #9ca3af; padding-bottom:8px; margin-bottom:8px;">
      <h3 style="margin:0;">REPORTE Y CORTE DE CAJA</h3>
      <div>Periodo: <strong>${escapeHtml(rangeInfo.label)}</strong></div>
      <div>Alcance: <strong>${escapeHtml(scopeLabel)}</strong></div>
      <div>Operaciones de Venta: <strong>${state.sales.length}</strong></div>
    </div>
    <div style="border-bottom:1px dashed #9ca3af; padding-bottom:8px; margin-bottom:8px;">
      <div style="display:flex; justify-content:space-between; margin:4px 0;">
        <span>Ventas Brutas:</span>
        <strong>${formatMoney(grossSales)}</strong>
      </div>
      <div style="display:flex; justify-content:space-between; margin:4px 0;">
        <span>↩️ Devoluciones (${allReturns.length}):</span>
        <strong>-${formatMoney(totalRefunded)}</strong>
      </div>
      <div style="display:flex; justify-content:space-between; margin:4px 0;">
        <span>💵 Efectivo Ventas:</span>
        <strong>${formatMoney(cashSales)}</strong>
      </div>
      <div style="display:flex; justify-content:space-between; margin:4px 0;">
        <span>💳 Tarjeta / Transferencia:</span>
        <strong>${formatMoney(cardSales + transferSales)}</strong>
      </div>
      <div style="display:flex; justify-content:space-between; margin:6px 0 2px 0; font-weight:bold;">
        <span>DINERO EN CAJA (VENTAS NETAS):</span>
        <span>${formatMoney(netSales)}</span>
      </div>
    </div>
    <div style="border-bottom:1px dashed #9ca3af; padding-bottom:8px; margin-bottom:8px;">
      <div style="display:flex; justify-content:space-between; margin:4px 0;">
        <span>🍿 (-) Gastos de Snack:</span>
        <strong>-${formatMoney(expSummary.snackTotal)}</strong>
      </div>
      <div style="display:flex; justify-content:space-between; margin:4px 0;">
        <span>🚗 (-) Gastos de Estacionamiento:</span>
        <strong>-${formatMoney(expSummary.parkingTotal)}</strong>
      </div>
      <div style="display:flex; justify-content:space-between; margin:4px 0;">
        <span>Total Gastos Descontados:</span>
        <strong>-${formatMoney(expSummary.totalExpenses)}</strong>
      </div>
    </div>
    ${expensesDetailHtml}
    ${returnsDetailHtml}
    <div style="display:flex; justify-content:space-between; font-size:1.15rem; font-weight:bold; margin-bottom:4px;">
      <span>(=) TOTAL DINERO LIBRE:</span>
      <span>${formatMoney(freeMoneyTotal)}</span>
    </div>
    <div style="display:flex; justify-content:space-between; font-size:0.95rem;">
      <span>💵 Efectivo Libre en Mano:</span>
      <strong>${formatMoney(freeCashInHand)}</strong>
    </div>
  `;
  document.getElementById('modal-receipt').classList.remove('hidden');
}

// ==========================================
// CIERRE FORMAL DE VENTA DEL DÍA / TURNO (CON GASTOS Y DINERO LIBRE)
// ==========================================
let activeCutDraft = null;

function getOpenShiftSummary() {
  const rangeInfo = getActiveHistoryDateRange();
  const openSales = state.sales.filter((s) => !s.cut_id);
  const grossSales = openSales.reduce((sum, s) => sum + Number(s.total), 0);
  const refundedTotal = openSales.reduce((sum, s) => sum + Number(s.refunded_total || 0), 0);
  const netSales = Math.max(0, grossSales - refundedTotal);
  const salesCash = openSales
    .filter((s) => s.payment_method === 'efectivo')
    .reduce((sum, s) => sum + Math.max(0, Number(s.total) - Number(s.refunded_total || 0)), 0);
  const cardSales = openSales
    .filter((s) => s.payment_method === 'tarjeta')
    .reduce((sum, s) => sum + Math.max(0, Number(s.total) - Number(s.refunded_total || 0)), 0);
  const transferSales = openSales
    .filter((s) => s.payment_method === 'transferencia')
    .reduce((sum, s) => sum + Math.max(0, Number(s.total) - Number(s.refunded_total || 0)), 0);

  const expSummary = computeExpensesForDateRange(rangeInfo.startDate, rangeInfo.endDate);
  const expensesSnack = expSummary.snackTotal;
  const expensesParking = expSummary.parkingTotal;
  const expensesTotal = expSummary.totalExpenses;
  const freeMoney = netSales - expensesTotal;
  const expectedCash = salesCash - expensesTotal;

  return {
    openSales,
    saleIds: openSales.map((s) => Number(s.id)).filter((id) => Number.isInteger(id) && id > 0),
    salesCount: openSales.length,
    grossSales,
    refundedTotal,
    netSales,
    salesCash,
    expectedCash,
    cardSales,
    transferSales,
    digitalTotal: cardSales + transferSales,
    expensesSnack,
    expensesParking,
    expensesTotal,
    freeMoney,
  };
}

function updateCloseCutDifference() {
  if (!activeCutDraft) return;
  const counted = Number(document.getElementById('close-cut-counted-cash').value || 0);
  const diff = Number((counted - activeCutDraft.expectedCash).toFixed(2));
  const diffTextEl = document.getElementById('close-cut-diff-text');

  if (Math.abs(diff) <= 0.009) {
    diffTextEl.textContent = '✅ Exacto ($0.00)';
    diffTextEl.style.color = 'var(--success)';
  } else if (diff > 0) {
    diffTextEl.textContent = `🟢 Sobrante: +${formatMoney(diff)}`;
    diffTextEl.style.color = '#6ee7b7';
  } else {
    diffTextEl.textContent = `🔴 Faltante: -${formatMoney(Math.abs(diff))}`;
    diffTextEl.style.color = '#fca5a5';
  }
}

function openCloseCutModal() {
  const summary = getOpenShiftSummary();
  if (summary.salesCount === 0) {
    showToast('⚠️ No hay ventas abiertas pendientes de cerrar en este turno.');
    return;
  }

  const isAdmin = state.currentUser && state.currentUser.role === 'admin';
  let scopeName = state.currentUser ? state.currentUser.name : 'General';
  if (isAdmin) {
    if (state.selectedCashierFilter === 'all') {
      scopeName = `Corte General (${state.currentUser.name})`;
    } else {
      const matchUser = state.users.find((u) => String(u.id) === String(state.selectedCashierFilter));
      scopeName = matchUser ? matchUser.name : state.currentUser.name;
    }
  }

  activeCutDraft = {
    ...summary,
    cashierId: state.currentUser ? state.currentUser.id : null,
    cashierName: scopeName,
  };

  document.getElementById('close-cut-subtitle').textContent = `Responsable: ${scopeName}`;
  document.getElementById('close-cut-sales-count').textContent = `${summary.salesCount} venta(s)`;
  document.getElementById('close-cut-net-total').textContent = formatMoney(summary.netSales);
  const snackEl = document.getElementById('close-cut-exp-snack');
  const parkingEl = document.getElementById('close-cut-exp-parking');
  const freeEl = document.getElementById('close-cut-free-money');
  if (snackEl) snackEl.textContent = `-${formatMoney(summary.expensesSnack)}`;
  if (parkingEl) parkingEl.textContent = `-${formatMoney(summary.expensesParking)}`;
  if (freeEl) freeEl.textContent = formatMoney(summary.freeMoney);
  document.getElementById('close-cut-digital-total').textContent = formatMoney(summary.digitalTotal);
  document.getElementById('close-cut-refunds-total').textContent = `-${formatMoney(summary.refundedTotal)}`;
  document.getElementById('close-cut-expected-cash').textContent = formatMoney(summary.expectedCash);

  const countedInput = document.getElementById('close-cut-counted-cash');
  countedInput.value = Math.max(0, summary.expectedCash).toFixed(2);
  document.getElementById('close-cut-note').value = '';

  const step1Fields = document.getElementById('close-cut-step-1-fields');
  if (step1Fields) step1Fields.classList.remove('hidden');
  document.getElementById('close-cut-step-1-footer').classList.remove('hidden');
  document.getElementById('close-cut-confirm-box').classList.add('hidden');

  updateCloseCutDifference();
  document.getElementById('modal-close-cut').classList.remove('hidden');
}

function showClosedCutTicketModal(cut) {
  const dtStr = new Date(cut.created_at).toLocaleString('es-MX');
  const diff = Number(cut.cash_difference || 0);
  let diffLabel = 'EXACTO ($0.00)';
  if (diff > 0.009) diffLabel = `SOBRANTE (+${formatMoney(diff)})`;
  else if (diff < -0.009) diffLabel = `FALTANTE (-${formatMoney(Math.abs(diff))})`;

  const expSnack = Number(cut.expenses_snack || 0);
  const expParking = Number(cut.expenses_parking || 0);
  const expTotal = Number(cut.expenses_total ?? expSnack + expParking);
  const freeMoney = Number(cut.free_money ?? Number(cut.net_sales) - expTotal);

  document.getElementById('receipt-title').textContent = `Comprobante de Cierre #${cut.id}`;
  document.getElementById('receipt-content').innerHTML = `
    <div style="text-align:center; border-bottom:1px dashed #9ca3af; padding-bottom:8px; margin-bottom:8px;">
      <h3 style="margin:0;">CIERRE DE TURNO / CORTE DE CAJA</h3>
      <div>Folio de Corte: <strong>#${cut.id}</strong></div>
      <div>Responsable: <strong>${escapeHtml(cut.cashier_name)}</strong></div>
      <div style="font-size:0.8rem;">Fecha y Hora: ${dtStr}</div>
    </div>
    <div style="border-bottom:1px dashed #9ca3af; padding-bottom:8px; margin-bottom:8px;">
      <div style="display:flex; justify-content:space-between; margin:4px 0;">
        <span>Ventas Cerradas:</span>
        <strong>${cut.sales_count} operación(es)</strong>
      </div>
      <div style="display:flex; justify-content:space-between; margin:4px 0;">
        <span>Ventas Brutas:</span>
        <strong>${formatMoney(cut.gross_sales)}</strong>
      </div>
      <div style="display:flex; justify-content:space-between; margin:4px 0;">
        <span>↩️ Devoluciones:</span>
        <strong>-${formatMoney(cut.refunded_total)}</strong>
      </div>
      <div style="display:flex; justify-content:space-between; margin:4px 0; font-size:1.02rem;">
        <span>DINERO EN CAJA (VENTAS NETAS):</span>
        <strong>${formatMoney(cut.net_sales)}</strong>
      </div>
    </div>
    <div style="border-bottom:1px dashed #9ca3af; padding-bottom:8px; margin-bottom:8px;">
      <div style="display:flex; justify-content:space-between; margin:4px 0;">
        <span>🍿 (-) Gastos de Snack:</span>
        <strong>-${formatMoney(expSnack)}</strong>
      </div>
      <div style="display:flex; justify-content:space-between; margin:4px 0;">
        <span>🚗 (-) Gastos de Estacionamiento:</span>
        <strong>-${formatMoney(expParking)}</strong>
      </div>
      <div style="display:flex; justify-content:space-between; margin:6px 0 2px 0; font-size:1.08rem; font-weight:bold;">
        <span>(=) TOTAL DINERO LIBRE:</span>
        <span>${formatMoney(freeMoney)}</span>
      </div>
    </div>
    <div style="border-bottom:1px dashed #9ca3af; padding-bottom:8px; margin-bottom:8px;">
      <div style="display:flex; justify-content:space-between; margin:4px 0;">
        <span>💳 Cobros con Tarjeta:</span>
        <strong>${formatMoney(cut.card_sales)}</strong>
      </div>
      <div style="display:flex; justify-content:space-between; margin:4px 0;">
        <span>📲 Transferencias:</span>
        <strong>${formatMoney(cut.transfer_sales)}</strong>
      </div>
      <div style="display:flex; justify-content:space-between; margin:4px 0;">
        <span>💵 Efectivo Esperado (Tras Gastos):</span>
        <strong>${formatMoney(cut.expected_cash)}</strong>
      </div>
      <div style="display:flex; justify-content:space-between; margin:4px 0;">
        <span>💵 Efectivo Físico Entregado:</span>
        <strong>${formatMoney(cut.counted_cash)}</strong>
      </div>
      <div style="display:flex; justify-content:space-between; margin:4px 0;">
        <span>Diferencia de Efectivo:</span>
        <strong>${diffLabel}</strong>
      </div>
    </div>
    ${cut.note ? `<div style="margin-bottom:10px; font-size:0.82rem;"><strong>Observaciones:</strong> ${escapeHtml(cut.note)}</div>` : ''}
    <div style="margin-top:26px; text-align:center; font-size:0.8rem;">
      ___________________________________<br/>
      Firma de Entrega / Conformidad
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

// Carga de datos desde Neon o Caché Local
async function loadUsers() {
  state.users = await DataService.getUsers();
  renderLoginScreen(true);
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
  const rangeInfo = getActiveHistoryDateRange();
  const [sales, cashCuts, expensesData] = await Promise.all([
    DataService.getSales(rangeInfo.startDate, rangeInfo.endDate, cashierFilter),
    DataService.getCashCuts(rangeInfo.startDate, rangeInfo.endDate, cashierFilter),
    DataService.getExpensesData(rangeInfo.startDate, rangeInfo.endDate),
  ]);
  state.sales = sales;
  state.cashCuts = cashCuts;
  state.expensesData = expensesData;
  renderSalesHistory();
}

// Inicialización general y eventos
async function initApp() {
  const dateInput = document.getElementById('history-date');
  const monthInput = document.getElementById('history-month-picker');
  const startDateInput = document.getElementById('history-start-date');
  const endDateInput = document.getElementById('history-end-date');

  dateInput.value = state.selectedDate;
  if (monthInput) monthInput.value = state.selectedMonth;
  if (startDateInput) startDateInput.value = state.customStartDate;
  if (endDateInput) endDateInput.value = state.customEndDate;
  syncHistoryPeriodInputs();

  // Eventos de Red (Auto-Sync cuando regresa el internet)
  window.addEventListener('online', async () => {
    SystemLogger.log('info', 'network_status', 'Conexión a internet restablecida (evento online)');
    showToast('🌐 Conexión a internet restablecida');
    await DataService.syncPendingSales();
    await SystemLogger.flush();
    await Promise.all([loadUsers(), loadProducts(), loadPromotions(), loadSales()]);
  });

  window.addEventListener('offline', () => {
    DataService.isOffline = true;
    updateConnectionUI();
    SystemLogger.log('warn', 'network_status', 'Dispositivo perdió conexión a internet (evento offline)');
    showToast('🟠 Sin internet: Modo Offline Activado (las ventas se guardarán en el equipo)');
  });

  // Capturar errores inesperados de JavaScript o promesas rechazadas tras bambalinas
  window.addEventListener('error', (e) => {
    SystemLogger.log('error', 'js_runtime_error', e.message || 'Error JS', {
      filename: e.filename,
      lineno: e.lineno,
      colno: e.colno,
    });
  });

  window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason && e.reason.message ? e.reason.message : String(e.reason || 'Unhandled rejection');
    SystemLogger.log('error', 'unhandled_promise', reason);
  });

  document.getElementById('btn-sync-pending').addEventListener('click', async () => {
    const count = await DataService.syncPendingSales();
    if (count === 0) {
      showToast('⚠️ Aún no hay conexión con el servidor para sincronizar');
    }
  });

  // Revisión automática de cola pendiente cada 20 segundos
  setInterval(() => {
    if (navigator.onLine && OfflineStore.getPendingQueue().length > 0) {
      DataService.syncPendingSales();
    }
  }, 20000);

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
    });
  });

  // Permitir teclear el PIN con teclado físico en PC sin abrir el teclado virtual en móvil/tablet
  window.addEventListener('keydown', (e) => {
    if (state.currentUser || !state.selectedLoginUser) return;
    const pinForm = document.getElementById('form-login-pin');
    if (!pinForm || pinForm.classList.contains('hidden')) return;
    const input = document.getElementById('login-pin-input');
    if (!input) return;

    if (/^[0-9]$/.test(e.key)) {
      e.preventDefault();
      if (input.value.length < 8) input.value += e.key;
    } else if (e.key === 'Backspace') {
      e.preventDefault();
      input.value = input.value.slice(0, -1);
    } else if (e.key === 'Delete' || e.key === 'Escape') {
      e.preventDefault();
      input.value = '';
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pinForm.requestSubmit();
    }
  });

  let isLoggingIn = false;
  document.getElementById('form-login-pin').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!state.selectedLoginUser || isLoggingIn) return;
    const pin = document.getElementById('login-pin-input').value.trim();
    if (!pin) {
      showToast('⚠️ Ingresa tu PIN con los números en pantalla');
      return;
    }

    isLoggingIn = true;
    const enterBtn = document.querySelector('#form-login-pin .key-enter');
    if (enterBtn) {
      enterBtn.disabled = true;
      enterBtn.textContent = 'Entrando...';
    }

    try {
      const verifiedUser = await DataService.verifyPin(state.selectedLoginUser.id, pin);
      state.currentUser = verifiedUser;
      document.getElementById('login-screen').classList.add('hidden');
      document.getElementById('app-shell').classList.remove('hidden');
      applyRolePermissions();
      await loadSales();
      showToast(`👋 Bienvenido, ${verifiedUser.name}`);
    } catch {
      SystemLogger.log('warn', 'login_pin_failed', `Intento de login con PIN incorrecto para usuario ${state.selectedLoginUser.name}`);
      showToast('❌ PIN incorrecto, intenta de nuevo');
      document.getElementById('login-pin-input').value = '';
    } finally {
      isLoggingIn = false;
      if (enterBtn) {
        enterBtn.disabled = false;
        enterBtn.textContent = 'Entrar →';
      }
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

  const btnClearSearch = document.getElementById('btn-clear-search');
  if (btnClearSearch) {
    btnClearSearch.addEventListener('click', () => {
      state.searchQuery = '';
      const searchInput = document.getElementById('pos-search');
      if (searchInput) {
        searchInput.value = '';
        searchInput.focus();
      }
      renderPosProducts();
    });
  }

  const btnToggleAllCats = document.getElementById('btn-toggle-all-cats');
  if (btnToggleAllCats) {
    btnToggleAllCats.addEventListener('click', () => {
      const { list } = getDistinctCategories();
      const anyExpanded = list.some((cat) => !state.collapsedCategories[cat]);
      list.forEach((cat) => {
        state.collapsedCategories[cat] = anyExpanded;
      });
      renderPosProducts();
    });
  }

  document.getElementById('catalog-search').addEventListener('input', (e) => {
    state.catalogFilter = e.target.value;
    renderCatalogTable();
  });

  document.getElementById('btn-clear-cart').addEventListener('click', () => {
    if (state.cart.length > 0 && confirm('¿Vaciar el ticket actual?')) {
      state.cart = [];
      renderCart();
      renderCategories();
      renderPosProducts();
    }
  });

  const btnMobileViewCart = document.getElementById('btn-mobile-view-cart');
  if (btnMobileViewCart) {
    btnMobileViewCart.addEventListener('click', () => toggleMobileCartDrawer(true));
  }
  const btnMobileOpenDrawer = document.getElementById('btn-mobile-open-drawer');
  if (btnMobileOpenDrawer) {
    btnMobileOpenDrawer.addEventListener('click', () => toggleMobileCartDrawer(true));
  }
  const btnCloseMobileCart = document.getElementById('btn-close-mobile-cart');
  if (btnCloseMobileCart) {
    btnCloseMobileCart.addEventListener('click', () => toggleMobileCartDrawer(false));
  }
  const mobileCartBackdrop = document.getElementById('mobile-cart-backdrop');
  if (mobileCartBackdrop) {
    mobileCartBackdrop.addEventListener('click', () => toggleMobileCartDrawer(false));
  }

  document.getElementById('btn-open-checkout').addEventListener('click', () => {
    toggleMobileCartDrawer(false);
    openCheckoutModal();
  });
  document.getElementById('btn-mobile-checkout').addEventListener('click', () => {
    toggleMobileCartDrawer(false);
    openCheckoutModal();
  });

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

  // Confirmar venta (Online en Neon u Offline en equipo)
  document.getElementById('btn-confirm-sale').addEventListener('click', async () => {
    const btn = document.getElementById('btn-confirm-sale');
    btn.disabled = true;
    btn.textContent = 'Procesando...';
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
      if (sale.pending_sync) {
        showToast(`🟠 Venta #${sale.id} guardada en el equipo (se subirá al volver el internet)`);
      } else {
        showToast(`✅ Venta #${sale.id} registrada en Neon`);
      }
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
    const submitBtn = e.target.querySelector('button[type="submit"]');
    if (submitBtn && submitBtn.disabled) return;
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = 'Guardando...';
    }
    try {
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
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Guardar en Neon';
      }
    }
  });

  // Admin: Crear / Editar Promoción (A + B)
  document.getElementById('btn-new-promo').addEventListener('click', () => openPromoModal(null));

  document.getElementById('form-promo').addEventListener('submit', async (e) => {
    e.preventDefault();
    const submitBtn = e.target.querySelector('button[type="submit"]');
    if (submitBtn && submitBtn.disabled) return;
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = 'Guardando...';
    }
    try {
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
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Guardar Promoción';
      }
    }
  });

  // Admin: Crear / Editar Cajero
  document.getElementById('btn-new-cashier').addEventListener('click', () => openCashierModal(null));

  document.getElementById('form-cashier').addEventListener('submit', async (e) => {
    e.preventDefault();
    const submitBtn = e.target.querySelector('button[type="submit"]');
    if (submitBtn && submitBtn.disabled) return;
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = 'Guardando...';
    }
    try {
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
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Guardar Usuario';
      }
    }
  });

  // Historial, Periodos (Día, Semana, Mes, 24 Meses, Rango) y Corte
  const periodSelect = document.getElementById('history-period-select');
  if (periodSelect) {
    periodSelect.addEventListener('change', (e) => {
      const mode = e.target.value;
      state.historyPeriod = mode;
      if (['this_week', 'last_week'].includes(mode)) {
        state.periodGroupBy = 'day';
      } else if (['last_4_weeks', 'this_month', 'last_month', 'pick_month'].includes(mode)) {
        state.periodGroupBy = 'week';
      } else {
        state.periodGroupBy = 'month';
      }
      syncHistoryPeriodInputs();
      loadSales();
    });
  }

  dateInput.addEventListener('change', (e) => {
    state.selectedDate = e.target.value;
    loadSales();
  });

  if (monthInput) {
    monthInput.addEventListener('change', (e) => {
      state.selectedMonth = e.target.value;
      loadSales();
    });
  }

  if (startDateInput) {
    startDateInput.addEventListener('change', (e) => {
      state.customStartDate = e.target.value;
      loadSales();
    });
  }

  if (endDateInput) {
    endDateInput.addEventListener('change', (e) => {
      state.customEndDate = e.target.value;
      loadSales();
    });
  }

  document.querySelectorAll('.period-group-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.periodGroupBy = btn.dataset.group;
      renderSalesHistory();
    });
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

  // Eventos del Módulo de Gastos (Recurrentes con opción a quitar un día + Puntuales Diarios)
  function openExpenseModal() {
    document.getElementById('form-expense').reset();
    document.getElementById('expense-type').value = 'puntual';
    document.getElementById('expense-category').value = 'snack';
    const rangeInfo = getActiveHistoryDateRange();
    document.getElementById('expense-date').value = rangeInfo.startDate || getTodayLocalISO();
    document.getElementById('expense-date-group').classList.remove('hidden');
    document.getElementById('modal-expense').classList.remove('hidden');
    setTimeout(() => document.getElementById('expense-concept').focus(), 80);
  }

  const btnOpenExpenseModal = document.getElementById('btn-open-expense-modal');
  if (btnOpenExpenseModal) btnOpenExpenseModal.addEventListener('click', openExpenseModal);
  const btnOpenExpenseInline = document.getElementById('btn-open-expense-inline');
  if (btnOpenExpenseInline) btnOpenExpenseInline.addEventListener('click', openExpenseModal);

  const expTypeSelect = document.getElementById('expense-type');
  if (expTypeSelect) {
    expTypeSelect.addEventListener('change', (e) => {
      document.getElementById('expense-date-group').classList.toggle('hidden', e.target.value === 'recurrente');
    });
  }

  document.querySelectorAll('.btn-expense-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.getElementById('expense-concept').value = btn.dataset.concept || '';
      document.getElementById('expense-category').value = btn.dataset.cat || 'snack';
      document.getElementById('expense-type').value = btn.dataset.type || 'puntual';
      document.getElementById('expense-date-group').classList.toggle('hidden', btn.dataset.type === 'recurrente');
      document.getElementById('expense-amount').focus();
    });
  });

  const formExpense = document.getElementById('form-expense');
  if (formExpense) {
    formExpense.addEventListener('submit', async (e) => {
      e.preventDefault();
      const submitBtn = document.getElementById('btn-save-expense');
      if (submitBtn && submitBtn.disabled) return;
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = 'Guardando...';
      }
      try {
        const expType = document.getElementById('expense-type').value;
        const cat = document.getElementById('expense-category').value;
        const concept = document.getElementById('expense-concept').value.trim();
        const amount = Number(document.getElementById('expense-amount').value || 0);
        const expDate = document.getElementById('expense-date').value || getTodayLocalISO();
        if (!concept || amount <= 0) return;

        await DataService.saveExpense({
          expense_type: expType,
          category: cat,
          concept,
          amount,
          expense_date: expDate,
          cashier_id: state.currentUser ? state.currentUser.id : null,
          cashier_name: state.currentUser ? state.currentUser.name : 'General',
        });

        document.getElementById('modal-expense').classList.add('hidden');
        await loadSales();
        showToast(
          expType === 'recurrente'
            ? `🔄 Gasto diario recurrente "${concept}" (-${formatMoney(amount)}/día) activado`
            : `💸 Gasto "${concept}" (-${formatMoney(amount)}) registrado`
        );
      } catch (err) {
        showToast(`❌ Error al guardar gasto: ${err.message}`);
      } finally {
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.textContent = '💾 Guardar Gasto';
        }
      }
    });
  }

  const btnOpenCloseCut = document.getElementById('btn-open-close-cut');
  if (btnOpenCloseCut) {
    btnOpenCloseCut.addEventListener('click', openCloseCutModal);
  }

  const countedCashInput = document.getElementById('close-cut-counted-cash');
  if (countedCashInput) {
    countedCashInput.addEventListener('input', updateCloseCutDifference);
  }

  const btnCloseCutExact = document.getElementById('btn-close-cut-exact');
  if (btnCloseCutExact) {
    btnCloseCutExact.addEventListener('click', () => {
      if (!activeCutDraft) return;
      document.getElementById('close-cut-counted-cash').value = activeCutDraft.expectedCash.toFixed(2);
      updateCloseCutDifference();
    });
  }

  const btnAskCloseCut = document.getElementById('btn-ask-close-cut');
  if (btnAskCloseCut) {
    btnAskCloseCut.addEventListener('click', () => {
      if (!activeCutDraft) return;
      const countedCash = Number(document.getElementById('close-cut-counted-cash').value || 0);
      const diff = Number((countedCash - activeCutDraft.expectedCash).toFixed(2));
      let diffMsg = 'Exacto ($0.00)';
      if (diff > 0.009) diffMsg = `Sobrante de +${formatMoney(diff)}`;
      else if (diff < -0.009) diffMsg = `Faltante de -${formatMoney(Math.abs(diff))}`;

      const noteVal = document.getElementById('close-cut-note').value.trim();
      document.getElementById('close-cut-confirm-detail').innerHTML =
        `Se cerrarán <strong>${activeCutDraft.salesCount} venta(s)</strong> (Ventas Netas: <strong>${formatMoney(
          activeCutDraft.netSales
        )}</strong>).<br/>` +
        `🍿 Gastos Snack: <strong>-${formatMoney(activeCutDraft.expensesSnack)}</strong> | 🚗 Gastos Estac.: <strong>-${formatMoney(
          activeCutDraft.expensesParking
        )}</strong><br/>` +
        `✨ <strong>TOTAL DINERO LIBRE: ${formatMoney(activeCutDraft.freeMoney)}</strong><br/>` +
        `💵 Efectivo esperado (tras gastos): <strong>${formatMoney(activeCutDraft.expectedCash)}</strong><br/>` +
        `💵 Efectivo entregado: <strong>${formatMoney(countedCash)}</strong> (${diffMsg}).` +
        (noteVal ? `<br/>📝 Nota: <em>${escapeHtml(noteVal)}</em>` : '') +
        `<br/><br/>Al confirmar, se generará el comprobante de corte y la caja activa iniciará en <strong>$0.00</strong>.`;

      const step1Fields = document.getElementById('close-cut-step-1-fields');
      if (step1Fields) step1Fields.classList.add('hidden');
      document.getElementById('close-cut-step-1-footer').classList.add('hidden');
      document.getElementById('close-cut-confirm-box').classList.remove('hidden');
    });
  }

  const btnCancelConfirmCut = document.getElementById('btn-cancel-confirm-cut');
  if (btnCancelConfirmCut) {
    btnCancelConfirmCut.addEventListener('click', () => {
      document.getElementById('close-cut-confirm-box').classList.add('hidden');
      const step1Fields = document.getElementById('close-cut-step-1-fields');
      if (step1Fields) step1Fields.classList.remove('hidden');
      document.getElementById('close-cut-step-1-footer').classList.remove('hidden');
    });
  }

  const formCloseCut = document.getElementById('form-close-cut');
  if (formCloseCut) {
    formCloseCut.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!activeCutDraft) return;

      const confirmBox = document.getElementById('close-cut-confirm-box');
      if (confirmBox && confirmBox.classList.contains('hidden')) {
        document.getElementById('btn-ask-close-cut').click();
        return;
      }

      const countedCash = Number(document.getElementById('close-cut-counted-cash').value || 0);

      const btn = document.getElementById('btn-confirm-close-cut');
      btn.disabled = true;
      btn.textContent = 'Cerrando turno...';

      try {
        const createdCut = await DataService.createCashCut({
          cashier_id: activeCutDraft.cashierId,
          cashier_name: activeCutDraft.cashierName,
          sales_count: activeCutDraft.salesCount,
          gross_sales: activeCutDraft.grossSales,
          refunded_total: activeCutDraft.refundedTotal,
          net_sales: activeCutDraft.netSales,
          expected_cash: activeCutDraft.expectedCash,
          counted_cash: countedCash,
          card_sales: activeCutDraft.cardSales,
          transfer_sales: activeCutDraft.transferSales,
          expenses_snack: activeCutDraft.expensesSnack,
          expenses_parking: activeCutDraft.expensesParking,
          expenses_total: activeCutDraft.expensesTotal,
          free_money: activeCutDraft.freeMoney,
          note: document.getElementById('close-cut-note').value.trim(),
          sale_ids: activeCutDraft.saleIds,
        });

        state.showAllDaySalesInHistory = false;
        document.getElementById('modal-close-cut').classList.add('hidden');
        await loadSales();
        showClosedCutTicketModal(createdCut);
        showToast(`🔒 Turno cerrado correctamente (Corte #${createdCut.id}). Caja reiniciada a $0.00`);
      } catch (err) {
        showToast(`❌ Error al cerrar turno: ${err.message}`);
      } finally {
        btn.disabled = false;
        btn.textContent = '✅ Sí, confirmar y cerrar';
      }
    });
  }

  // Eventos del Modal de Devoluciones (Puntos 1 al 4)
  document.getElementById('btn-return-select-all').addEventListener('click', () => {
    if (!activeReturnDraft) return;
    const allSelected = activeReturnDraft.items.every((it) => it.return_qty === it.available_qty);
    for (const item of activeReturnDraft.items) {
      item.return_qty = allSelected ? 0 : item.available_qty;
    }
    renderReturnModalItems();
  });

  document.querySelectorAll('.btn-reason-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.getElementById('return-reason').value = btn.dataset.reason;
      document.getElementById('return-reason').focus();
    });
  });

  document.getElementById('form-return').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!activeReturnDraft || !state.currentUser) return;

    const selectedItems = activeReturnDraft.items.filter((it) => it.return_qty > 0);
    if (selectedItems.length === 0) {
      SystemLogger.log('warn', 'return_validation_block', `Intento de devolución bloqueado: 0 artículos seleccionados en Folio #${activeReturnDraft.sale.id}`, {
        sale_id: activeReturnDraft.sale.id,
      });
      showToast('⚠️ Selecciona al menos 1 artículo/pieza para devolver');
      return;
    }

    const reason = document.getElementById('return-reason').value.trim();
    if (!reason) {
      SystemLogger.log('warn', 'return_validation_block', `Intento de devolución bloqueado: sin motivo en Folio #${activeReturnDraft.sale.id}`, {
        sale_id: activeReturnDraft.sale.id,
      });
      showToast('⚠️ Escribe o selecciona el motivo de la devolución');
      return;
    }

    const refundAmount = Number(document.getElementById('return-refund-amount').value || 0);
    const isAdminSession = state.currentUser.role === 'admin';
    const adminPin = document.getElementById('return-admin-pin').value.trim();

    if (!isAdminSession && !adminPin) {
      SystemLogger.log('warn', 'return_validation_block', `Intento de devolución bloqueado: cajero no ingresó PIN de Admin en Folio #${activeReturnDraft.sale.id}`, {
        sale_id: activeReturnDraft.sale.id,
      });
      showToast('🔒 Ingresa el PIN de un Administrador para autorizar la devolución');
      document.getElementById('return-admin-pin').focus();
      return;
    }

    const btn = document.getElementById('btn-confirm-return');
    btn.disabled = true;
    btn.textContent = 'Procesando devolución...';

    try {
      const res = await DataService.processSaleReturn(activeReturnDraft.sale.id, {
        items: selectedItems,
        refund_amount: refundAmount,
        reason,
        processed_by_name: state.currentUser.name,
        authorized_by_name: isAdminSession ? state.currentUser.name : '',
        is_admin_session: isAdminSession,
        admin_pin: adminPin,
      });

      SystemLogger.log('info', 'return_processed', `Devolución aplicada en Folio #${activeReturnDraft.sale.id} (-${refundAmount})`, {
        sale_id: activeReturnDraft.sale.id,
        refund_amount: refundAmount,
        reason,
        authorized_by: res.authorized_by_name,
      });

      document.getElementById('modal-return').classList.add('hidden');
      await Promise.all([loadProducts(), loadSales()]);
      showToast(
        `↩️ Devolución aplicada (-${formatMoney(refundAmount)}) • Autorizó: ${res.authorized_by_name || 'Admin'}`
      );
    } catch (err) {
      SystemLogger.log('error', 'return_failed', `Error al procesar devolución en Folio #${activeReturnDraft.sale.id}: ${err.message}`, {
        sale_id: activeReturnDraft.sale.id,
        error: err.message,
      });
      showToast(`❌ ${err.message}`);
    } finally {
      btn.disabled = false;
      btn.textContent = '↩️ Confirmar Devolución';
    }
  });

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

  // 1. Pintar inmediatamente desde caché local (0ms de espera, sin esperar a que Render despierte)
  state.users = OfflineStore.get(OfflineStore.KEYS.USERS, [
    { id: 1, name: 'Administrador', role: 'admin', pin: '1234' },
    { id: 2, name: 'Cajero 1', role: 'cajero', pin: '1111' },
    { id: 3, name: 'Cajero 2', role: 'cajero', pin: '2222' },
  ]);
  state.products = OfflineStore.get(OfflineStore.KEYS.PRODUCTS, []);
  state.promotions = OfflineStore.get(OfflineStore.KEYS.PROMOS, []);
  renderLoginScreen();
  renderCategories();
  renderPosProducts();
  renderActivePromosBanner();
  renderCart();

  // 2. Conectar en segundo plano (si Render tarda >1.2s en despertar, usa Neon Cloud directo al instante)
  await DataService.init();
  await Promise.all([loadUsers(), loadProducts(), loadPromotions()]);
  await DataService.syncPendingSales();
  await SystemLogger.flush();
  updateConnectionUI();
}

initApp();
