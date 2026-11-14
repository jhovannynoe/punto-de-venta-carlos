# Punto de Venta Carlos (Web + APK con Neon PostgreSQL)

Sistema de Punto de Venta para **Ventas Generales y Servicios**, conectado en tiempo real a tu base de datos **Neon PostgreSQL**.

## Módulos Incluidos
1. **Caja / Cobrar (`pos`)**:
   - Búsqueda rápida y filtro por categorías.
   - Botón **⚡ Concepto Libre** para cobrar servicios o ventas rápidas al vuelo sin registrarlos previamente.
   - Carrito con cálculo de total, cobro en **Efectivo**, **Tarjeta** o **Transferencia**, botones de billetes rápidos y **cálculo automático de cambio**.
   - Comprobante/Ticket imprimible al instante.
2. **Catálogo e Inventario (`catalog`)**:
   - Alta, edición y baja de **Productos** (con control de stock automático) y **Servicios** (sin límite de stock).
   - Ajuste rápido de inventario (`+` / `-`) sincronizado con Neon.
3. **Corte de Caja e Historial (`history`)**:
   - Tarjetas de resumen del día: **Total Vendido**, **Efectivo en Caja** y **Tarjeta / Transferencia**.
   - Generación e impresión del **Corte de Caja del Día**.
   - Historial detallado de ventas por fecha con vista de ticket y cancelación (restaurando stock).

---

## Cómo usar la versión Web (PC)
- Haz doble clic en **`iniciar-pos.bat`** o ejecuta en terminal:
  ```powershell
  node server.js
  ```
- Abre en tu navegador: **http://localhost:3000**

---

## Cómo generar o instalar la APK en Android

La aplicación en `www/` incluye conexión directa a **Neon Serverless HTTPS**, por lo que **la APK en el celular se sincroniza con la misma base de datos Neon desde cualquier lugar con internet**, sin depender de que tu PC esté encendida.

### Opción A: Generar APK nativa con Capacitor
1. Ejecuta **`generar-proyecto-apk.bat`** (o corre `npm.cmd install` y `npx.cmd cap add android`).
2. Abre la carpeta `android/` en **Android Studio** (`npx.cmd cap open android`) y selecciona **Build > Build Bundle(s) / APK(s) > Build APK(s)**.

### Opción B: Compilar APK en la nube gratis (PWABuilder) o instalar como App Web (PWA)
- Si subes la carpeta `www/` a cualquier hosting gratuito (Netlify, Vercel o GitHub Pages), puedes abrir el enlace en tu celular Android y pulsar **"Instalar aplicación"**, o pegarlo en [PWABuilder.com](https://www.pwabuilder.com) para descargar el archivo `.apk` listo para instalar sin necesidad de Android Studio.
