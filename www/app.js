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
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await neonQuery(`
    CREATE TABLE IF NOT EXISTS sales (
      id SERIAL PRIMARY KEY,
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
      subtotal NUMERIC(10, 2) NOT NULL
    );
  `);

  const existingUsers = await neonQuery('SELECT COUNT(*)::int AS total FROM users WHERE active = TRUE');
  if (existingUsers[0] && Number(existingUsers[0].total) === 0) {
    const defaultUsers = [
      ['Administrador', 'admin', '1234'],
      ['Cajero 1', 'cajero', '1111'],
      ['Cajero 2', 'cajero', '2222'],
    ];
    for (const [name, role, pin] of defaultUsers) {
      await neonQuery('INSERT INTO users (name, role, pin) VALUES ($1, $2, $3)', [name, role, pin]);
    }
  }
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
      SELECT id, name, category, price::float AS price, stock, is_service, created_at
      FROM products
      WHERE active = TRUE
      ORDER BY category ASC, name ASC
    `);
    return rows.map((r) => ({ ...r, price: Number(r.price), stock: r.stock !== null ? Number(r.stock) : null }));
  },

  async saveProduct(prod) {
    const isService = Boolean(prod.is_service);
    const stock = isService || prod.stock === null || prod.stock === '' ? null : Number(prod.stock);
    if (!this.useDirectNeon) {
      const url = prod.id ? `/api/products/${prod.id}` : '/api/products';
      const method = prod.id ? 'PUT' : 'POST';
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...prod, stock, is_service: isService }),
      });
      if (res.ok) return res.json();
    }
    if (prod.id) {
      const rows = await neonQuery(
        `UPDATE products
         SET name = $1, category = $2, price = $3, stock = $4, is_service = $5
         WHERE id = $6
         RETURNING id, name, category, price::float AS price, stock, is_service`,
        [prod.name, prod.category || 'General', Number(prod.price), stock, isService, Number(prod.id)]
      );
      return rows[0];
    } else {
      const rows = await neonQuery(
        `INSERT INTO products (name, category, price, stock, is_service)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, name, category, price::float AS price, stock, is_service`,
        [prod.name, prod.category || 'General', Number(prod.price), stock, isService]
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
    const total = items.reduce((acc, it) => acc + Number(it.unit_price) * Number(it.quantity), 0);
    const paymentMethod = salePayload.payment_method || 'efectivo';
    const amountReceived = paymentMethod === 'efectivo' ? Number(salePayload.amount_received ?? total) : total;
    const changeGiven = paymentMethod === 'efectivo' ? Math.max(0, amountReceived - total) : 0;
    const note = String(salePayload.note || '').trim();
    const cashierId = salePayload.cashier_id ? Number(salePayload.cashier_id) : null;
    const cashierName = String(salePayload.cashier_name || 'General').trim();

    const saleRows = await neonQuery(
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

      const itemRow = await neonQuery(
        `INSERT INTO sale_items (sale_id, product_id, product_name, quantity, unit_price, subtotal)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, sale_id, product_id, product_name, quantity, unit_price::float AS unit_price, subtotal::float AS subtotal`,
        [sale.id, productId, it.product_name, qty, unitPrice, subtotal]
      );
      insertedItems.push(itemRow[0]);

      if (productId) {
        await neonQuery(
          `UPDATE products
           SET stock = CASE WHEN is_service = FALSE AND stock IS NOT NULL THEN GREATEST(0, stock - $1) ELSE stock END
           WHERE id = $2`,
          [qty, productId]
        );
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
        `SELECT id, total::float AS total, payment_method, amount_received::float AS amount_received,
                change_given::float AS change_given, note, cashier_id, COALESCE(cashier_name, 'General') AS cashier_name, created_at
         FROM sales
         WHERE (created_at AT TIME ZONE 'America/Mexico_City')::date = $1::date
           AND cashier_id = $2
         ORDER BY created_at DESC`,
        [dateStr, Number(cashierId)]
      );
    } else if (dateStr) {
      salesRows = await neonQuery(
        `SELECT id, total::float AS total, payment_method, amount_received::float AS amount_received,
                change_given::float AS change_given, note, cashier_id, COALESCE(cashier_name, 'General') AS cashier_name, created_at
         FROM sales
         WHERE (created_at AT TIME ZONE 'America/Mexico_City')::date = $1::date
         ORDER BY created_at DESC`,
        [dateStr]
      );
    } else {
      salesRows = await neonQuery(
        `SELECT id, total::float AS total, payment_method, amount_received::float AS amount_received,
                change_given::float AS change_given, note, cashier_id, COALESCE(cashier_name, 'General') AS cashier_name, created_at
         FROM sales
         ORDER BY created_at DESC
         LIMIT 100`
      );
    }
    if (salesRows.length === 0) return [];
    const saleIds = salesRows.map((s) => Number(s.id));
    const itemsRows = await neonQuery(
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
    return salesRows.map((s) => ({
      ...s,
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
        await neonQuery(
          `UPDATE products
           SET stock = CASE WHEN is_service = FALSE AND stock IS NOT NULL THEN stock + $1 ELSE stock END
           WHERE id = $2`,
          [Number(it.quantity), Number(it.product_id)]
        );
      }
    }
    await neonQuery('DELETE FROM sales WHERE id = $1', [Number(saleId)]);
    return true;
  },
};

// Estado de la aplicación
const state = {
  users: [],
  currentUser: null, // { id, name, role: 'admin' | 'cajero' }
  selectedLoginUser: null,
  products: [],
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
  setTimeout(() => el.remove(), 3200);
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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

  // Mostrar/ocultar todos los elementos marcados como exclusivos de Admin
  document.querySelectorAll('.admin-only').forEach((el) => {
    el.classList.toggle('hidden', !isAdmin);
  });

  // Etiquetas dinámicas según rol
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

  // Ir a la pestaña de Caja por defecto al iniciar turno
  switchTab('pos');
}

function switchTab(tabName) {
  const isAdmin = state.currentUser && state.currentUser.role === 'admin';
  if (!isAdmin && (tabName === 'catalog' || tabName === 'cashiers')) {
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
      const isService = Boolean(p.is_service) || p.stock === null;
      const stockNum = isService ? null : Number(p.stock);
      const outOfStock = !isService && stockNum <= 0;

      let badgeHtml = `<span class="prod-stock-badge service">Servicio</span>`;
      if (!isService) {
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
          <div class="prod-card-price">${formatMoney(p.price)}</div>
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
  const isService = Boolean(prod.is_service) || prod.stock === null;
  const existing = state.cart.find((item) => item.product_id && Number(item.product_id) === Number(prod.id));

  if (!isService && Number(prod.stock) <= 0) {
    showToast(`⚠️ "${prod.name}" no tiene stock disponible`);
    return;
  }

  if (existing) {
    if (!isService && existing.quantity + customQty > Number(prod.stock)) {
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
      max_stock: isService ? null : Number(prod.stock),
    });
  }
  renderCart();
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
}

function getCartTotal() {
  return state.cart.reduce((sum, it) => sum + it.unit_price * it.quantity, 0);
}

function renderCart() {
  const listEl = document.getElementById('cart-items-list');
  const countEl = document.getElementById('cart-count');
  const totalEl = document.getElementById('cart-total');
  const btnCheckout = document.getElementById('btn-open-checkout');
  const btnCheckoutAmt = document.getElementById('btn-checkout-amount');
  const mobileBar = document.getElementById('mobile-cart-bar');

  const totalItems = state.cart.reduce((sum, it) => sum + it.quantity, 0);
  const totalAmount = getCartTotal();

  countEl.textContent = totalItems;
  totalEl.textContent = formatMoney(totalAmount);
  btnCheckoutAmt.textContent = formatMoney(totalAmount);
  btnCheckout.disabled = state.cart.length === 0;

  document.getElementById('mobile-cart-count').textContent = `${totalItems} concepto(s)`;
  document.getElementById('mobile-cart-total').textContent = formatMoney(totalAmount);
  mobileBar.classList.toggle('hidden', state.cart.length === 0);

  if (state.cart.length === 0) {
    listEl.innerHTML = `<div class="cart-empty">Selecciona productos o servicios del catálogo para comenzar a cobrar.</div>`;
    return;
  }

  listEl.innerHTML = state.cart
    .map(
      (it) => `
      <div class="cart-item">
        <div class="cart-item-info">
          <div class="cart-item-title">${escapeHtml(it.product_name)}</div>
          <div class="cart-item-meta">${formatMoney(it.unit_price)} c/u</div>
        </div>
        <div class="cart-item-controls">
          <button class="qty-btn" data-key="${it.key}" data-delta="-1">−</button>
          <span class="qty-val">${it.quantity}</span>
          <button class="qty-btn" data-key="${it.key}" data-delta="1">+</button>
        </div>
        <div class="cart-item-subtotal">${formatMoney(it.unit_price * it.quantity)}</div>
      </div>
    `
    )
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
      const isService = Boolean(p.is_service) || p.stock === null;
      return `
        <tr>
          <td><strong>${escapeHtml(p.name)}</strong></td>
          <td><span class="prod-category-tag">${escapeHtml(p.category || 'General')}</span></td>
          <td>${isService ? '⚡ Servicio' : '📦 Producto'}</td>
          <td><strong>${formatMoney(p.price)}</strong></td>
          <td>
            ${
              isService
                ? '<span style="color:var(--text-muted)">Sin límite</span>'
                : `<div style="display:flex; align-items:center; gap:0.4rem;">
                     <button class="qty-btn btn-stock-adj" data-id="${p.id}" data-delta="-1">−</button>
                     <strong style="min-width:28px; text-align:center;">${p.stock}</strong>
                     <button class="qty-btn btn-stock-adj" data-id="${p.id}" data-delta="1">+</button>
                   </div>`
            }
          </td>
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
// MÓDULO 3 (SOLO ADMIN): GESTIÓN DE CAJEROS
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
// MÓDULO 4: HISTORIAL Y CORTE DE CAJA
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

  // Tabla de desglose por cajero (solo para Admin)
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
      const itemsSummary = (s.items || []).map((it) => `${it.quantity}x ${it.product_name}`).join(', ');

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
        if (confirm(`¿Cancelar la venta Folio #${id}? Se devolverá el stock al inventario.`)) {
          await DataService.deleteSale(id);
          await Promise.all([loadProducts(), loadSales()]);
          showToast(`Venta #${id} cancelada`);
        }
      });
    });
  }
}

// Modales de Ticket y Corte de Caja
function showSaleTicketModal(sale) {
  const dateStr = new Date(sale.created_at).toLocaleString('es-MX');
  const itemsHtml = (sale.items || [])
    .map(
      (it) => `
      <div style="display:flex; justify-content:space-between; margin: 4px 0;">
        <span>${it.quantity} x ${escapeHtml(it.product_name)}</span>
        <strong>${formatMoney(it.subtotal)}</strong>
      </div>`
    )
    .join('');

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
  const total = getCartTotal();
  document.getElementById('checkout-modal-total').textContent = formatMoney(total);
  document.getElementById('checkout-received').value = total.toFixed(2);
  document.getElementById('checkout-note').value = '';
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
  const total = getCartTotal();
  const received = Number(document.getElementById('checkout-received').value || 0);
  const diff = received - total;
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

function openProductModal(prod = null) {
  document.getElementById('modal-product-title').textContent = prod
    ? 'Editar Producto / Servicio'
    : 'Nuevo Producto / Servicio';
  document.getElementById('prod-id').value = prod ? prod.id : '';
  document.getElementById('prod-name').value = prod ? prod.name : '';
  document.getElementById('prod-category').value = prod ? prod.category : 'General';
  document.getElementById('prod-price').value = prod ? prod.price : '';
  const isService = prod ? Boolean(prod.is_service) || prod.stock === null : false;
  document.getElementById('prod-is-service').checked = isService;
  document.getElementById('prod-stock').value = prod && prod.stock !== null ? prod.stock : 15;
  document.getElementById('prod-stock-group').classList.toggle('hidden', isService);
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

  // Eventos de Login por PIN
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

  // Cambiar Turno / Cerrar Sesión
  document.getElementById('btn-logout').addEventListener('click', async () => {
    state.currentUser = null;
    state.cart = [];
    renderCart();
    document.getElementById('app-shell').classList.add('hidden');
    document.getElementById('login-screen').classList.remove('hidden');
    await loadUsers();
  });

  // Navegación de pestañas
  document.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // Cerrar modales
  document.querySelectorAll('[data-close]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.getElementById(btn.dataset.close).classList.add('hidden');
    });
  });

  // Búsqueda en POS y Catálogo
  document.getElementById('pos-search').addEventListener('input', (e) => {
    state.searchQuery = e.target.value;
    renderPosProducts();
  });

  document.getElementById('catalog-search').addEventListener('input', (e) => {
    state.catalogFilter = e.target.value;
    renderCatalogTable();
  });

  // Vaciar carrito
  document.getElementById('btn-clear-cart').addEventListener('click', () => {
    if (state.cart.length > 0 && confirm('¿Vaciar el ticket actual?')) {
      state.cart = [];
      renderCart();
    }
  });

  // Abrir cobro
  document.getElementById('btn-open-checkout').addEventListener('click', openCheckoutModal);
  document.getElementById('btn-mobile-checkout').addEventListener('click', openCheckoutModal);

  // Métodos de pago y cálculo de cambio
  document.querySelectorAll('.pay-method-btn').forEach((btn) => {
    btn.addEventListener('click', () => setPaymentMethod(btn.dataset.method));
  });

  document.getElementById('checkout-received').addEventListener('input', updateChangeCalculation);

  document.querySelectorAll('.chip-btn[data-cash]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const val = btn.dataset.cash;
      const total = getCartTotal();
      document.getElementById('checkout-received').value = val === 'exact' ? total.toFixed(2) : Number(val).toFixed(2);
      updateChangeCalculation();
    });
  });

  // Confirmar venta en Neon (guardando el cajero que cobró)
  document.getElementById('btn-confirm-sale').addEventListener('click', async () => {
    const btn = document.getElementById('btn-confirm-sale');
    btn.disabled = true;
    btn.textContent = 'Guardando en Neon...';
    try {
      const sale = await DataService.createSale({
        items: state.cart,
        payment_method: state.paymentMethod,
        amount_received: Number(document.getElementById('checkout-received').value || getCartTotal()),
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
    addToCart({ id: null, name, price, is_service: true, stock: null }, qty);
    document.getElementById('modal-quick-item').classList.add('hidden');
    showToast(`Agregado: ${qty}x ${name}`);
  });

  // Admin: Crear / Editar Producto
  document.getElementById('btn-new-product').addEventListener('click', () => openProductModal(null));

  document.getElementById('prod-is-service').addEventListener('change', (e) => {
    document.getElementById('prod-stock-group').classList.toggle('hidden', e.target.checked);
  });

  document.getElementById('form-product').addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {
      id: document.getElementById('prod-id').value || null,
      name: document.getElementById('prod-name').value.trim(),
      category: document.getElementById('prod-category').value.trim() || 'General',
      price: Number(document.getElementById('prod-price').value || 0),
      is_service: document.getElementById('prod-is-service').checked,
      stock: document.getElementById('prod-stock').value,
    };
    await DataService.saveProduct(payload);
    document.getElementById('modal-product').classList.add('hidden');
    await loadProducts();
    showToast('✅ Catálogo actualizado en Neon');
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

  // Atajos de teclado para uso rápido en PC
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
    await Promise.all([loadUsers(), loadProducts()]);
    dotEl.className = 'status-dot connected';
    txtEl.textContent = `Conectado: ${info.mode}`;
  } catch (err) {
    dotEl.className = 'status-dot error';
    txtEl.textContent = 'Error de conexión a Neon';
    console.error(err);
  }
}

initApp();
