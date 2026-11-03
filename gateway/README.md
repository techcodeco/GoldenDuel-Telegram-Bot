# RPS Gateway (Bun + Elysia + Redis Streams)

گیتوی وبهوک ربات Golden Duel. فقط آپدیت‌های لازم را در Redis Streams می‌گذارد.

## احراز هویت امن Webhook

آدرس عمومی webhook دیگر هیچ توکن یا رمز احراز هویتی در مسیر URL ندارد:

```text
https://dezhbanbot.ir/webhook
```

هنگام اجرای `bun run webhook`، مقدار `WEBHOOK_SECRET` با پارامتر `secret_token` به تلگرام معرفی می‌شود. تلگرام این مقدار را در هدر زیر برای هر درخواست webhook می‌فرستد و gateway همان هدر را اعتبارسنجی می‌کند:

```http
X-Telegram-Bot-Api-Secret-Token: <WEBHOOK_SECRET>
```

`BOT_TOKEN` با `WEBHOOK_SECRET` فرق دارد. اولی اعتبارنامه Bot API است و فقط در `.env` نگهداری می‌شود؛ دومی برای احراز هویت درخواست‌های ورودی webhook است. تلگرام Bot API برای درخواست‌های خروجی همچنان توکن ربات را در مسیر endpoint خودش می‌خواهد؛ این موضوع با URL عمومی webhook فرق دارد.

## راه‌اندازی

```bash
bun install
cp .env.example .env
```

در `.env` این مقادیر را تنظیم کن:

```env
HOST=127.0.0.1
PORT=3000
REDIS_URL=redis://127.0.0.1:6379
BOT_TOKEN=توکن_فعلی_ربات
WEBHOOK_SECRET=مقدار_تصادفی_طولانی
PUBLIC_URL=https://dezhbanbot.ir
```

ساخت secret امن:

```bash
openssl rand -hex 32
```

اجرای gateway و ثبت webhook:

```bash
bun install
bun run start
# در ترمینال جداگانه، از همان پوشه و با همان .env:
bun run webhook
```

برای اجرای دائمی از PM2 یا systemd استفاده کن. gateway به‌صورت پیش‌فرض فقط روی `127.0.0.1:3000` گوش می‌دهد و باید از طریق Nginx در دسترس اینترنت قرار بگیرد.

## اتصال دامنه بدون نوشتن پورت

DNS دامنه `dezhbanbot.ir` باید با رکورد A به IP عمومی همین سرور اشاره کند. سپس Nginx روی پورت‌های عمومی 80 و 443 درخواست‌ها را می‌گیرد و به `http://127.0.0.1:3000` می‌فرستد. فایل نمونه در مسیر زیر است:

```text
deploy/nginx/dezhbanbot.ir.conf
```

پس از نصب و فعال‌سازی Nginx، برای TLS از Certbot استفاده کن. دستورهای نمونه Ubuntu در ادامه همین README آمده‌اند.

## قوانین فیلتر

- پی‌وی: همه آپدیت‌ها ← `updates:private`
- گروه: فقط متن‌های trigger مورد پشتیبانی gateway و همه `callback_query`ها ← `updates:groups`
- سایر آپدیت‌ها با پاسخ ۲۰۰ نادیده گرفته می‌شوند.
- مسیر وبهوک: `POST /webhook`؛ احراز هویت از هدر `X-Telegram-Bot-Api-Secret-Token` انجام می‌شود.

## بنچمارک با هدر احراز هویت

```bash
curl -i -X POST http://127.0.0.1:3000/webhook \
  -H 'content-type: application/json' \
  -H "X-Telegram-Bot-Api-Secret-Token: $WEBHOOK_SECRET" \
  -d '{"update_id":1,"message":{"chat":{"type":"private","id":1},"text":"hi"}}'
```

برای نتیجه واقعی‌تر Redis را روی لینوکس اجرا کن و اگر لازم شد چند پروسه با `REUSE_PORT=1` بالا بیاور.

## حالت توسعه با Polling

```bash
bun run poll
```

Polling وبهوک را حذف می‌کند و برای `getUpdates` به `BOT_TOKEN` نیاز دارد. برای برگشت به وبهوک، اسکریپت Polling را متوقف کن و `bun run webhook` بزن.

## دستورهای نصب Nginx و TLS روی Ubuntu

1. مطمئن شو DNS دامنه به IP سرور اشاره می‌کند و پورت‌های 80 و 443 در فایروال/پنل VPS باز هستند.
2. نصب Nginx و Certbot:

```bash
sudo apt update
sudo apt install -y nginx certbot python3-certbot-nginx
```

3. کپی و فعال‌سازی کانفیگ (از ریشه پروژه):

```bash
sudo cp deploy/nginx/dezhbanbot.ir.conf /etc/nginx/sites-available/dezhbanbot.ir
sudo ln -s /etc/nginx/sites-available/dezhbanbot.ir /etc/nginx/sites-enabled/dezhbanbot.ir
sudo nginx -t
sudo systemctl reload nginx
```

4. گرفتن گواهی HTTPS و اعمال تنظیمات TLS:

```bash
sudo certbot --nginx -d dezhbanbot.ir
```

5. بررسی:

```bash
curl -i https://dezhbanbot.ir/health
```

باید `ok` برگردد؛ به شرط اینکه gateway و Redis در حال اجرا باشند. سپس از پوشه gateway اجرا کن:

```bash
bun run webhook
```

نکته: پورت 3000 را در اینترنت باز نکن. فقط Nginx باید به آن روی localhost وصل شود. فایروال عمومی فقط به 80 و 443 نیاز دارد (و SSH برای مدیریت سرور).

## لاگ خطاها

- فقط خطاها (`error` و `fatal`) در پوشه `logs/` نوشته می‌شوند، نه درخواست‌های موفق.
- کتابخانه: `pino` + `pino-roll`.
- فایل‌های قدیمی‌تر از `LOG_RETENTION_DAYS` خودکار پاک می‌شوند.
- خطای تکراری حداکثر هر `LOG_THROTTLE_MS` یک‌بار نوشته می‌شود و تعداد تکرارهای حذف‌شده ثبت می‌شود.
- خطاهای مهم: `xadd_failed`، `redis_error`، `webhook_bad_json`، `webhook_invalid_secret_header`، `elysia_*`، `unhandled_rejection`، `uncaught_exception`.

```bash
tail -f logs/gateway.*.log
```
