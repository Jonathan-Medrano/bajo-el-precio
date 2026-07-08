# Bajó el Precio — Roadmap

## Goal

Tracker de precios #1 de MercadoLibre Argentina.
**Métrica de éxito**: 10.000 usuarios activos + $50.000 ARS/mes en ingresos recurrentes.

---

## Estado actual (v4.5 — deployada 2026-07-08)

- Fly.io: `bajoelprecio.fly.dev` corriendo ✅
- 2890 productos en DB, tracker acumulando datapoints ✅
- Chrome extension v1.0.0 con gráfico de precio y intelligence recommendation ✅
- Telegram bot: `/start`, `/mis_alertas`, `/borrar`, `/premium` ✅
- Price intelligence: isDeal, trend, confidence, recommendation ✅
- `GET /deals` + `GET /deals/:category` (SSR) + `GET /api/deals?category=X` ✅
- `/premium` landing page con pricing + FAQ ✅
- `/p/:id` producto SSR con JSON-LD, OG tags, related products ✅
- Auto-tweet cuando precio toca nuevo mínimo (≥10% de bajada) ✅
- Daily digest al canal Telegram a las 09:00 ART ✅
- Seed-catalog via ML Search API (sin Playwright) ✅
- Category pills en landing + footer links ✅
- Sistema de referidos: `/ref/:chatId` → deep link Telegram, +1 alerta por referido ✅
- Sitemap con URLs de categorías + `Cache-Control` en `/p/:id` ✅
- Tracker fix definitivo: campo `lastTracked` (solo el tracker lo setea) ✅
- **Pendiente**: `MP_ACCESS_TOKEN` + `MP_WEBHOOK_SECRET` en Fly secrets para activar pagos
- **Pendiente**: `TWITTER_API_KEY/SECRET` + `TWITTER_ACCESS_TOKEN/SECRET` para auto-tweet
- **Pendiente**: `ALERTS_ENABLED=1` + `TELEGRAM_CHANNEL=@bajoelprecio_ar` para canal

---

## Fase 2 — Historial real y UX de datos (próximo sprint)

**Por qué primero**: sin historial acumulado, la price intelligence no tiene datos
reales y los deals son vacíos. Todo lo demás depende de esto.

### 2.1 Acumular historial automáticamente
- [x] Tracker fix: `lastScraped null check` corregido ✅
- [x] Tracker fix definitivo: campo `lastTracked` separado de `@updatedAt` ✅
- [x] Seed-catalog via ML Search API (encuentra productos sin Playwright) ✅
- [ ] Trigger manual de seed cada domingo (cron en Fly.io o script)
- [ ] **Blocker natural**: esperar que el tracker corra ciclos y acumule ≥3 datapoints por producto

### 2.2 Gráfico de precio histórico en la extensión
- [x] SVG sparkline en el content script ✅
- [x] Intelligence recommendation debajo del veredicto ✅
- [x] Colores de gráfico actualizados a brand #e64c1e ✅

### 2.3 Página pública por producto (`/p/:id`)
- [x] JSON-LD structured data ✅
- [x] OG tags + Twitter card ✅
- [x] Related products section ✅
- [x] Intelligence recommendation en veredicto ✅
- [x] /premium CTA cuando se alcanza el límite ✅

### 2.4 Dashboard
- [ ] Widget "Mejor momento para comprar" (pendiente)

**Entregable**: `/deals` muestra resultados reales (≥10 productos) — ETA: 24-48h de tracker acumulando.

---

## Fase 3 — Monetización activa

**Por qué acá**: sin ingresos no hay runway para seguir mejorando.

### 3.1 MercadoPago funcional
- [x] `/premium` command en bot → genera link de pago ✅
- [x] `createPaymentPreference()` via MP API ✅
- [x] Webhook IPN HMAC-SHA256 verificado ✅
- [x] `grantPremium(chatId)` tras pago aprobado ✅
- [x] `/premium` landing page ✅
- [ ] **ACCIÓN REQUERIDA**: `fly secrets set MP_ACCESS_TOKEN=... MP_WEBHOOK_SECRET=...`

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
- [x] `GET /deals/:category` — deals filtrados por categoría ✅
- [x] `GET /sitemap.xml` — incluye URLs de categorías ✅
- [x] Meta tags por categoría ✅

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
- [x] `src/twitter.js`: OAuth 1.0a, 10 tweets/día, 24h cooldown por producto ✅
- [x] Hook en `alerts.js`: tweet cuando bajada ≥10% ✅
- [ ] **ACCIÓN REQUERIDA**: `fly secrets set TWITTER_API_KEY=... TWITTER_API_SECRET=... TWITTER_ACCESS_TOKEN=... TWITTER_ACCESS_SECRET=...`

### 5.2 Canal de Telegram `@bajoelprecio_ar`
- [x] Daily digest a las 09:00 ART: top 3 deals del día ✅
- [ ] **ACCIÓN REQUERIDA**: `fly secrets set ALERTS_ENABLED=1 TELEGRAM_CHANNEL=@bajoelprecio_ar`

### 5.3 Compartir historial
- [ ] Botón en `/p/:id`: "Ver precio antes del Hot Sale" → enlace con OG card
- [ ] OG image (`/og/:id.png`) ya existe — verificar que muestre gráfico + precio

### 5.4 Referidos (simple)
- [x] `/ref/:chatId` → redirect a Telegram deep link `?start=ref_CHATID` ✅
- [x] Bot procesa `/start ref_CHATID`: crea Referral, notifica al referente +1 alerta ✅
- [x] Plan free incluye alertas extra (FREE_ALERT_LIMIT + referralCount) ✅

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
