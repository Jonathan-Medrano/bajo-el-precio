# Bajó el Precio — Roadmap

## Goal

Tracker de precios #1 de MercadoLibre Argentina.
**Métrica de éxito**: 10.000 usuarios activos + $50.000 ARS/mes en ingresos recurrentes.

---

## Estado actual (v4.0 — deployada 2026-07-08)

- Fly.io: `bajoelprecio.fly.dev` corriendo ✅
- 2890 productos en DB (1 datapoint cada uno — historial real empieza ahora) ✅
- Chrome extension v1.0.0 (observa precios desde la página del producto) ✅
- Telegram bot `@bajoelprecio_bot`: alertas, `/start`, `/mis_alertas`, `/borrar` ✅
- Price intelligence: isDeal, trend, confidence, recommendation ✅
- `GET /deals` (SSR) + `GET /api/deals` ✅
- Freemium: 3 alertas free, premium via MP (incomplete) 🟡
- Auto-tracker: corre cada 6h sobre los productos con alertas activas ✅

---

## Fase 2 — Historial real y UX de datos (próximo sprint)

**Por qué primero**: sin historial acumulado, la price intelligence no tiene datos
reales y los deals son vacíos. Todo lo demás depende de esto.

### 2.1 Acumular historial automáticamente
- [ ] Verificar que el auto-tracker (6h loop) esté corriendo en Fly.io (check logs)
- [ ] Aumentar cobertura del tracker: trackear los 500 productos con más `queries`, no solo los que tienen alertas
- [ ] Seed semanal: `POST /admin/seed-catalog` como cron en Fly.io (cada domingo 03:00 ART)

### 2.2 Gráfico de precio histórico en la extensión
- [ ] Inline SVG sparkline en el popup (sin dependencias externas — Canvas 2D en el content script)
- [ ] Badge "Mínimo histórico: $X (hace N días)" prominente
- [ ] Badge "Nunca estuvo tan barato" si `current === stats.min`

### 2.3 Página pública por producto (`/p/:id`) — ya existe, mejorar
- [ ] Agregar gráfico interactivo (Chart.js desde CDN, lazy)
- [ ] Mostrar `intelligence.recommendation` con color semántico
- [ ] Tabla de historial paginada (últimas 30 entradas)
- [ ] Botón "Activar alerta" → abre Telegram con deep link

### 2.4 Dashboard mejorado
- [ ] Widget "Productos con mejor momento para comprar" (top 5 isDeal + alta confidence)
- [ ] Gráfico de actividad: datapoints registrados por día (sparkline)

**Entregable**: `/deals` muestra resultados reales (≥10 productos), extension muestra gráfico.

---

## Fase 3 — Monetización activa

**Por qué acá**: sin ingresos no hay runway para seguir mejorando.

### 3.1 MercadoPago funcional
- [ ] Crear preferencia de pago al ejecutar `/premium` en el bot
  - `POST /api/payment/create` → devuelve `init_point` (link de pago MP)
  - El bot responde con el link + instrucciones
- [ ] Webhook IPN (`POST /webhooks/mp`) verificado con HMAC SHA256
  - `grantPremium(chatId)` al recibir `payment.approved`
- [ ] Fly secrets: `MP_ACCESS_TOKEN`, `MP_WEBHOOK_SECRET` (ya placeholders en `plans.js`)
- [ ] Landing: página `/premium` con pricing claro

### 3.2 Modelo de precios
| Plan     | Alertas | Frecuencia | Precio          |
|----------|---------|------------|-----------------|
| Free     | 3       | batch 1h   | $0              |
| Pro      | 50      | inmediata  | $4.990 ARS/mes  |
| Anual    | 50      | inmediata  | $39.990 ARS/año |

- Inmediata = el bot avisa en segundos del cambio, no en el batch horario

### 3.3 Telegram: flujo de upgrade
- `/premium` → muestra plan actual + beneficios + link de pago
- Al límite de alertas → mensaje con CTA de upgrade en lugar de error

**Entregable**: primer pago procesado, `isPremium()` funciona en producción.

---

## Fase 4 — Catálogo y SEO

**Por qué acá**: más productos = más tráfico orgánico = más usuarios sin pagar ads.

### 4.1 Seed automático de catálogo
- [ ] Corregir `seed-catalog.js` para ML 2025+ layout (actualmente encuentra 0 con Playwright)
  - Estrategia alternativa: usar la API pública de ML (`/sites/MLA/search?q=...`)
  - Top 50 búsquedas de ML Trends como queries al API
- [ ] Cron semanal en Fly.io: `POST /admin/seed-catalog`

### 4.2 Páginas por categoría
- [ ] `GET /deals/:category` — deals filtrados por categoría (Gaming, Celulares, etc.)
- [ ] `GET /sitemap.xml` — ya existe, agregar URLs de categorías
- [ ] Meta tags por categoría: `<title>Mejores precios en {cat} hoy | Bajó el Precio</title>`

### 4.3 SEO técnico
- [ ] Structured data `Product` + `Offer` en `/p/:id`
- [ ] `robots.txt` permisivo para las páginas públicas
- [ ] Cache HTTP en `/p/:id`: `Cache-Control: public, max-age=300`

### 4.4 API pública (monetizada)
- [ ] Documentar `GET /api/product/:id` como API pública
- [ ] Rate limit en free: 100 req/día por IP
- [ ] Ruta `GET /developers` con docs mínimos y link a plan Pro (API sin límite)

**Entregable**: 10.000+ productos en DB, páginas de categoría funcionando, indexadas en Google.

---

## Fase 5 — Distribución y growth

**Por qué acá**: con historial real y monetización activa, ahora vale la pena traer tráfico.

### 5.1 Auto-post en Twitter/X
- [ ] Cuando un producto cae ≥30% bajo su mínimo histórico → tweet automático
- [ ] Tweet incluye: título, precio actual, precio mínimo, % de ahorro, link `/p/:id`, OG image
- [ ] Rate limit: máx 5 tweets/hora, no repetir el mismo producto en 24h
- [ ] `POST /api/twitter/post` vía Twitter API v2 (Bearer token en Fly secrets)

### 5.2 Canal de Telegram `@bajoelprecio_ar`
- [ ] Bot postea deals en el canal: las mejores 3 bajadas del día a las 09:00 ART
- [ ] Subscribers del canal = top-of-funnel gratuito

### 5.3 Compartir historial
- [ ] Botón en `/p/:id`: "Ver precio antes del Hot Sale" → enlace con OG card
- [ ] OG image (`/og/:id.png`) ya existe — verificar que muestre gráfico + precio

### 5.4 Referidos (simple)
- [ ] `/ref/:code` → genera alerta de bienvenida y suma 1 alerta extra al referente
- [ ] El bot muestra el link de referido en `/start`

**Entregable**: canal Telegram con 500 subs, tweets automáticos activos.

---

## Fase 6 — Inteligencia avanzada

**Por qué al final**: requiere historial denso (≥30 datapoints por producto) para ser útil.

### 6.1 Cuotas sin interés (AR-específico)
- [ ] Extraer cuotas disponibles por banco de la página del producto (Playwright)
- [ ] Mostrar "precio real en 12 cuotas: $X" vs "precio contado: $Y"
- [ ] En la extensión: badge de cuotas debajo del precio

### 6.2 Predicción de precio
- [ ] Patrón: si el precio bajó los últimos 3 Hot Sale, alertar "posible bajada en N días"
- [ ] Detectar eventos ML (Hot Sale, CyberMonday) por fecha y mostrar countdown

### 6.3 Alertas por email
- [ ] Opción de recibir alertas por email además de Telegram
- [ ] Recolectar email en `/subscribe` o vía bot: `/email tu@correo.com`
- [ ] Envío via Resend/Postmark (SMTP barato)

### 6.4 Comparador
- [ ] `GET /compare?a=MLA123&b=MLA456` — dos productos en el mismo gráfico
- [ ] Extensión: botón "Comparar" en la página del producto

### 6.5 Weekly digest
- [ ] Lunes 09:00 ART: resumen personalizado por Telegram
  - "Esta semana tus productos rastreados: 2 bajaron, 1 subió"
  - Top 3 deals de la semana en tus categorías seguidas

**Entregable**: cuotas funcionando en extensión, primer email de alerta enviado.

---

## Orden de ejecución y dependencias

```
Fase 2 (historial)
    ↓
Fase 3 (MP pago)  ←→  Fase 4 (catálogo) [paralelo]
    ↓
Fase 5 (distribución)
    ↓
Fase 6 (inteligencia avanzada)
```

Fase 3 y 4 pueden avanzar en paralelo porque no se bloquean entre sí.
Fase 5 necesita catálogo grande (Fase 4) e ingresos para justificar Twitter API ($100/mo).

---

## Métricas por fase

| Fase | Métrica clave                              |
|------|--------------------------------------------|
| 2    | `/api/deals` retorna ≥10 productos reales  |
| 3    | Primer pago MP procesado                   |
| 4    | ≥10.000 productos, ≥5 páginas indexadas    |
| 5    | Canal Telegram ≥500 subs, tweets activos   |
| 6    | Cuotas en extensión, email alerts vivos    |
