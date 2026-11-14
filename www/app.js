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
      unit_price NUMERIC(10, 2) NOT NULL,
      subtotal NUMERIC(10, 2) NOT NULL
    );
  `);

  const existing = await neonQuery('SELECT COUNT(*)::int AS total FROM products WHERE active = TRUE');
  if (existing[0] && Number(existing[0].total) === 0) {
    const samples = [
      ['Servicio General / Consulta', 'Servicios', 150.0, null, true],
      ['Mano de Obra / Instalación', 'Servicios', 300.0, null, true],
      ['Mantenimiento Preventivo', 'Servicios', 450.0, null, true],
      ['Artículo General A', 'Productos', 50.0, 25, false],
      ['Artículo General B', 'Productos', 120.0, 15, false],
      ['Accesorio / Refacción', 'Productos', 85.0, 30, false],
    ];
    for (const [name, category, price, stock, is_service] of samples) {
      await neonQuery(
        'INSERT INTO products (name, category, price, stock, is_service) VALUES ($1, $2, $3, $4, $5)',
        [name, category, price, stock, is_service]
      );
    }
  }
}

// Capa de datos unificada (usa API del servidor si está disponible, o Neon HTTP directo en APK/Web)
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

    const saleRows = await neonQuery(
      `INSERT INTO sales (total, payment_method, amount_received, change_given, note)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, total::float AS total, payment_method, amount_received::float AS amount_received,
                 change_given::float AS change_given, note, created_at`,
      [total, paymentMethod, amountReceived, changeGiven, note]
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

  async getSales(dateStr) {
    if (!this.useDirectNeon) {
      const url = dateStr ? `/api/sales?date=${encodeURIComponent(dateStr)}` : '/api/sales';
      const res = await fetch(url);
      if (res.ok) return res.json();
    }
    let salesRows;
    if (dateStr) {
      salesRows = await neonQuery(
        `SELECT id, total::float AS total, payment_method, amount_received::float AS amount_received,
                change_given::float AS change_given, note, created_at
         FROM sales
         WHERE (created_at AT TIME ZONE 'America/Mexico_City')::date = $1::date
         ORDER BY created_at DESC`,
        [dateStr]
      );
    } else {
      salesRows = await neonQuery(
        `SELECT id, total::float AS total, payment_method, amount_received::float AS amount_received,
                change_given::float AS change_given, note, created_at
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
  products: [],
  cart: [],
  sales: [],
  selectedCategory: 'Todos',
  searchQuery: '',
  catalogFilter: '',
  paymentMethod: 'efectivo',
  selectedDate: getTodayLocalISO(),
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

// Renderizado de Categorías y Productos en Caja
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

// Carrito de Venta
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

  // Mobile sticky bar
  document.getElementById('mobile-cart-count').textContent = `${totalItems} concepto(s)`;
  document.getElementById('mobile-cart-total').textContent = formatMoney(totalAmount);
  if (state.cart.length > 0) {
    mobileBar.classList.remove('hidden');
  } else {
    mobileBar.classList.add('hidden');
  }

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

// Renderizado de Catálogo e Inventario
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

// Renderizado de Historial y Corte de Caja
function renderSalesHistory() {
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

  if (state.sales.length === 0) {
    listEl.innerHTML = `<div class="cart-empty">No hay ventas registradas en esta fecha (${state.selectedDate}).</div>`;
    return;
  }

  listEl.innerHTML = state.sales
    .map((s) => {
      const timeStr = new Date(s.created_at).toLocaleTimeString('es-MX', {
        hour: '2-digit',
        minute: '2-digit',
      });
      const itemsSummary = (s.items || [])
        .map((it) => `${it.quantity}x ${it.product_name}`)
        .join(', ');

      return `
        <div class="sale-card">
          <div>
            <div class="sale-card-header">
              <strong>Folio #${s.id}</strong>
              <span class="sale-badge ${s.payment_method}">${s.payment_method}</span>
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
            <button class="btn btn-danger btn-sm btn-cancel-sale" data-id="${s.id}">Cancelar</button>
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

  document.getElementById('receipt-title').textContent = `Corte de Caja (${state.selectedDate})`;
  document.getElementById('receipt-content').innerHTML = `
    <div style="text-align:center; border-bottom:1px dashed #9ca3af; padding-bottom:8px; margin-bottom:8px;">
      <h3 style="margin:0;">CORTE DE CAJA DEL DÍA</h3>
      <div>Fecha: <strong>${state.selectedDate}</strong></div>
      <div>Operaciones registradas: <strong>${state.sales.length}</strong></div>
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

// Modal de Producto / Servicio
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

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Carga de datos desde Neon
async function loadProducts() {
  state.products = await DataService.getProducts();
  renderCategories();
  renderPosProducts();
  renderCatalogTable();
}

async function loadSales() {
  state.sales = await DataService.getSales(state.selectedDate);
  renderSalesHistory();
}

// Inicialización general y eventos
async function initApp() {
  // Fecha inicial en corte de caja
  const dateInput = document.getElementById('history-date');
  dateInput.value = state.selectedDate;

  // Navegación de pestañas
  document.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-btn').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.tab-view').forEach((v) => v.classList.remove('active'));
      btn.classList.add('active');
      const tab = btn.dataset.tab;
      document.getElementById(`tab-${tab}`).classList.add('active');
      if (tab === 'history') loadSales();
    });
  });

  // Cerrar modales
  document.querySelectorAll('[data-close]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.getElementById(btn.dataset.close).classList.add('hidden');
    });
  });

  // Búsqueda en POS
  document.getElementById('pos-search').addEventListener('input', (e) => {
    state.searchQuery = e.target.value;
    renderPosProducts();
  });

  // Búsqueda en Catálogo
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

  // Confirmar venta en Neon
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
      });
      state.cart = [];
      renderCart();
      document.getElementById('modal-checkout').classList.add('hidden');
      showToast(`✅ Venta #${sale.id} registrada con éxito`);
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

  // Crear / Editar Producto
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

  // Historial y Corte
  dateInput.addEventListener('change', (e) => {
    state.selectedDate = e.target.value;
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
    await Promise.all([loadProducts(), loadSales()]);
    dotEl.className = 'status-dot connected';
    txtEl.textContent = `Conectado: ${info.mode}`;
  } catch (err) {
    dotEl.className = 'status-dot error';
    txtEl.textContent = 'Error de conexión a Neon';
    console.error(err);
  }
}

initApp();
