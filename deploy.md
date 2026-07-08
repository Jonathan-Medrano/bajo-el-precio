# Deploy en Fly.io + Supabase

## 1. Crear proyecto en Supabase

1. Ir a supabase.com → New Project → región: South America (São Paulo)
2. Copiar las connection strings de Settings → Database → Connection string:
   - **Pooled** (para la app): usar como `DATABASE_URL`
   - **Direct** (para migraciones): usar como `DIRECT_URL`

## 2. Instalar Fly CLI e iniciar sesión

```bash
# Instalar fly CLI
curl -L https://fly.io/install.sh | sh
fly auth login
```

## 3. Crear la app en Fly.io

```bash
fly apps create bajoelprecio --org personal
```

## 4. Crear volumen para perfil de Playwright

```bash
fly volumes create browser_profile --size 1 --region gru --app bajoelprecio
```

## 5. Configurar secrets

```bash
fly secrets set --app bajoelprecio \
  DATABASE_URL="postgresql://postgres.[ref]:[pass]@pooler.supabase.com:6543/postgres?pgbouncer=true" \
  DIRECT_URL="postgresql://postgres.[ref]:[pass]@pooler.supabase.com:5432/postgres" \
  TELEGRAM_BOT_TOKEN="[token de BotFather]" \
  TELEGRAM_CHANNEL="@bajoelprecio_ar" \
  ALERTS_ENABLED="1" \
  ML_AFFILIATE_WORD="jonathanmedrano" \
  ML_AFFILIATE_TOOL="10247610" \
  ADMIN_TOKEN="$(openssl rand -hex 16)" \
  PUBLIC_URL="https://bajoelprecio.fly.dev" \
  WEB_URL="https://bajoelprecio.fly.dev" \
  FREE_ALERT_LIMIT="3"
```

## 6. Correr migraciones en Supabase

```bash
# Con DIRECT_URL apuntando a Supabase:
DATABASE_URL="..." DIRECT_URL="..." npx prisma migrate deploy
```

## 7. Deploy

```bash
fly deploy --app bajoelprecio
```

## 8. Verificar

```bash
curl https://bajoelprecio.fly.dev/api/health
# → {"ok":true,"service":"keepa-ml"}
```

## 9. Seed del catálogo inicial

```bash
curl -X POST https://bajoelprecio.fly.dev/admin/seed-catalog \
  -H "x-admin-token: TU_ADMIN_TOKEN"
```

## 10. Registrar webhook del bot de Telegram

```bash
curl "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  -d "url=https://bajoelprecio.fly.dev/webhooks/telegram"
# → {"ok":true,"description":"Webhook was set"}
```

Esto hace que el bot reciba /start, /mis_alertas y /borrar de forma independiente.

## 11. MercadoPago (Premium)

1. Crear link de pago en mercadopago.com.ar con `external_reference = {chatId}`
2. Configurar webhook: IPN URL = `https://bajoelprecio.fly.dev/webhooks/mp`
3. Agregar secreto:
   ```bash
   fly secrets set MP_ACCESS_TOKEN="..." MP_WEBHOOK_SECRET="..."
   ```

## URLs de producción

| Ruta | Descripción |
|------|-------------|
| `https://bajoelprecio.fly.dev/` | Landing + búsqueda |
| `https://bajoelprecio.fly.dev/p/{id}` | Página SEO de producto |
| `https://bajoelprecio.fly.dev/dashboard` | Mis alertas (usuario) |
| `https://bajoelprecio.fly.dev/og/{id}.png` | Social card OG |
| `https://bajoelprecio.fly.dev/api/health` | Health check |
| `https://bajoelprecio.fly.dev/sitemap.xml` | Sitemap Google |

## Dominio propio (opcional)

```bash
fly certs add bajoelprecio.com.ar --app bajoelprecio
# Seguir las instrucciones para apuntar el DNS
```
