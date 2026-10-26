# RPS Gateway (Bun + Elysia + Redis Streams)

گیتوی وبهوک ربات سنگ‌کاغذ‌قیچی. فقط آپدیت‌های لازم را در Redis Streams می‌گذارد.

## اجرا
```bash
bun install
# Redis باید روی REDIS_URL بالا باشد (لینوکس/WSL2/Docker)
bun run dev          # توسعه
bun run start        # اجرا
bun run webhook      # ثبت وبهوک در تلگرام (BOT_TOKEN و PUBLIC_URL را در .env بگذار)
```

## قوانین فیلتر
- پی‌وی: همه آپدیت‌ها ← `updates:private`
- گروه: فقط متن‌هایی که با `/fight` شروع می‌شوند (`/fight 5000` هم) و همه `callback_query`ها ← `updates:groups`
- بقیه با پاسخ ۲۰۰ دور ریخته می‌شوند.
- مسیر وبهوک: `POST /webhook/:token` (توکن از `WEBHOOK_TOKEN`)

## بنچمارک (با oha)
```bash
oha -z 20s -c 256 -m POST -H 'content-type: application/json' \
  -d '{"update_id":1,"message":{"chat":{"type":"private","id":1},"text":"hi"}}' \
  http://127.0.0.1:3000/webhook/$WEBHOOK_TOKEN
```
برای نتیجه واقعی‌تر Redis را روی لینوکس/WSL2 اجرا کن و اگر لازم شد چند پروسه با `REUSE_PORT=1` بالا بیاور.

## حالت توسعه با Polling
```bash
bun run poll      # getUpdates ← همان فیلتر ← XADD در همان استریم‌ها
```
وبهوک را خودکار حذف می‌کند. برای برگشت به وبهوک، اسکریپت را متوقف کن و `bun run webhook` بزن.

## لاگ خطاها
- فقط خطاها (`error` و `fatal`) در پوشه `logs/` نوشته می‌شوند، نه درخواست‌های موفق. بنابراین روی RPS اثری ندارد.
- کتابخانه: `pino` + `pino-roll` (نوشتن غیرهمگام و بافردار).
- هر فایل حداکثر حدود ۲ مگابایت (`LOG_MAX_SIZE`) و هر روز فایل جدید؛ فایل‌های قدیمی‌تر از ۷ روز (`LOG_RETENTION_DAYS`) خودکار پاک می‌شوند.
- خطای تکراری (مثلاً وقتی Redis قطع است) حداکثر هر ثانیه یک بار نوشته می‌شود و تعداد تکرارهای حذف‌شده در فیلد `suppressed` می‌آید.
- خطاهای ثبت‌شده: `xadd_failed`، `redis_error`، `webhook_bad_json`، `webhook_bad_token`، `elysia_*`، `unhandled_rejection`، `uncaught_exception`.

```bash
tail -f logs/gateway.*.log
cat logs/gateway.*.log | jq 'select(.key=="xadd_failed")'
```

تست: وسط بنچمارک Redis را متوقف کن (`sudo service redis-server stop`). باید پاسخ ۵۰۳ بگیری، RPS بدون کرش بماند و در لاگ حدود یک خط در ثانیه با `suppressed` ببینی.

## یادآوری امنیتی (TODO)
- توکن داخل آدرس است؛ **لاگ دسترسی (access log) مسیر `/webhook/` را در Nginx/پراکسی خاموش کن** تا توکن در لاگ‌ها نماند.
- توکن را طولانی و تصادفی نگه دار و `.env` را در Git نگذار.
