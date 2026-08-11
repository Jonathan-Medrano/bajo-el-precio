# Keepa-ML — Historial de precios de MercadoLibre

Un "Keepa para MercadoLibre": pegás el link de un producto y ves cómo evolucionó su precio en el tiempo (gráfico), con mínimo/máximo/promedio y un veredicto de si es buen momento para comprar.

## Stack

- **Backend**: Node (ESM) + Express + Prisma 6 + Playwright (scraper)
- **DB**: PostgreSQL — local con `embedded-postgres` (sin Docker), en prod Supabase
- **Frontend**: HTML + Chart.js (estático, servido por Express). En prod → Vercel.
- **Deploy futuro**: Fly.io (backend) + Supabase (DB) + Vercel (frontend)

## Cómo correrlo en local (2 procesos)

```bash
# 1) Postgres local (dejar corriendo en una terminal)
node scripts/db.js
#    → levanta Postgres en localhost:5433/keepa

# 2) (solo la primera vez / si cambia el schema) crear tablas
node node_modules/prisma/build/index.js migrate dev

# 3) (opcional) sembrar datos demo para ver el gráfico
node --env-file=.env scripts/seed-demo.js

# 4) API + frontend
node --env-file=.env src/server.js
#    → abrir http://localhost:3000
```

## El tracker (motor que acumula historial)

```bash
node --env-file=.env src/tracker.js
```
Re-scrapea todos los productos trackeados y guarda un nuevo punto de precio.
Conviene correrlo en loop (cada X horas) — ahí se construye el "moat" de datos.

## Estructura

```
prisma/schema.prisma   modelo: Product + PricePoint (la serie temporal = el gráfico)
src/
  db.js                cliente Prisma
  link-parser.js       extrae el ID de cualquier link de ML (/up/, /p/, item)
  link-expander.js     resuelve links cortos (meli.la)
  ml/price-reader.js   lee el "Mejor precio" del producto (Playwright, anti-bot)
  service.js           trackProduct(link) + getHistory(id)
  server.js            API Express (/api/track, /api/product/:id, /api/products)
  tracker.js           ciclo del tracker (re-scrape)
public/index.html      frontend con el gráfico (Chart.js)
scripts/
  db.js                Postgres local (embedded)
  seed-demo.js         datos demo
  screenshot.js        captura del frontend (demo.png)
```

## API

- `POST /api/track`  body `{ "url": "https://..." }` → lee, guarda y devuelve historial
- `GET /api/product/:id` → historial de un producto ya trackeado
- `GET /api/products` → lista de productos trackeados

## Estado

✅ DB local + schema + migración
✅ Scraper (precio real, fix de centavos heredado)
✅ API end-to-end (verificado: trackea el A16 → guarda → devuelve)
✅ Frontend con gráfico (ver `demo.png`)
✅ Tracker (motor de re-scrape)

⚠️ El A16 (MLAU3829685373) tiene historial **DEMO** sembrado para mostrar el gráfico.
   Los datos reales se acumulan corriendo el tracker con el tiempo.

## Próximos pasos

1. **Tracker como servicio** (loop/cron) para acumular historial real.
2. **Deploy**: Supabase (DB) → cambiar `DATABASE_URL`/`DIRECT_URL` en `.env`;
   backend a Fly.io; frontend a Vercel (apuntando a la API de Fly).
3. **Descubrimiento**: sembrar productos populares (highlights/categorías) para
   trackear desde el arranque, no solo lo que consultan los usuarios.
4. **Features**: alertas de baja de precio, comparador (reusar el matcher de
   `precio-historico`), búsqueda por nombre, cuotas.
5. **Monetización**: link de afiliado en cada producto, premium (alertas), B2B.
