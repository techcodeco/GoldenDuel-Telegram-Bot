# راهنمای دیتابیس پروژه RPS Worker

این سند بر اساس مدل‌های Mongoose موجود در `private-worker/src/core/models/index.ts` و تنظیمات `private-worker/src/core/services/settings.ts` نوشته شده است. نام پایگاه داده را مقدار `MONGO_URI` تعیین می‌کند؛ نام‌های کالکشن زیر نام‌های متعارف پیش‌فرض Mongoose هستند. اگر در زمان اتصال نام کالکشن سفارشی تعیین نشده باشد، معمولاً همین نام‌ها استفاده می‌شوند.

## اصول مهم پیش از بررسی کالکشن‌ها

- واحد پول فعال فقط `IRT` و `TON` است. `IRT` در این پروژه **تومان** است، نه ریال.
- مبالغ `IRT` عدد صحیح تومان‌اند؛ مبالغ `TON` در دیتابیس به‌صورت عدد صحیح **nanoTON** نگهداری می‌شوند: `1 TON = 1,000,000,000 nanoTON`. لایهٔ رابط کاربری، مقدار TON را به شکل اعشاری دریافت و نمایش می‌دهد.
- هر سندی که `timestamps: true` داشته باشد، فیلدهای `createdAt` و `updatedAt` را خودکار می‌گیرد. `Ledger` از `at` به‌عنوان تاریخ ایجاد استفاده می‌کند و `AdminLog` هم تاریخ را در `at` ذخیره می‌کند.
- `versionKey: false` روی مدل‌ها تنظیم شده؛ بنابراین فیلد معمول Mongoose یعنی `__v` وجود ندارد.
- توضیحات «اختیاری» به این معنی است که فیلد می‌تواند در سند نباشد یا در بعضی مسیرها مقدار پیش‌فرض داشته باشد. مقدار پیش‌فرض لزوماً به معنای اجباری بودن فیلد نیست.
- اعداد شناسهٔ تلگرام در فیلدهای `userId` و `tgId` شناسهٔ عددی Telegram هستند، نه شناسهٔ داخلی MongoDB.

## 1. `users` — کاربران

**مدل:** `User`  
**کاربرد:** حساب کاربر، نقش‌ها، زبان، معرفی‌کننده و موجودی قابل‌استفاده/رزروشده.

| فیلد | نوع / مقدارهای مجاز | کاربرد |
|---|---|---|
| `_id` | `ObjectId` خودکار | شناسهٔ داخلی MongoDB؛ منطق ربات عمدتاً از `tgId` استفاده می‌کند. |
| `tgId` | Number، اجباری، یکتا | شناسهٔ تلگرام کاربر. |
| `refCode` | String، اختیاری، یکتا در صورت وجود | کد اختصاصی دعوت؛ ایندکس یکتای sparse دارد. |
| `firstName` | String اختیاری | نام نمایشی Telegram. |
| `username` | String اختیاری | نام کاربری Telegram بدون الزام به وجود `@`. |
| `lang` | `fa`, `en` یا `null` | زبان انتخابی کاربر؛ پیش‌فرض `null`. |
| `role` | `user`, `admin`, `owner` | سطح دسترسی؛ پیش‌فرض `user`. |
| `referrerId` | Number یا `null` | `tgId` معرف؛ پیش‌فرض `null` و ایندکس دارد. |
| `referralPaid` | Boolean | آیا پاداش معرف پرداخت شده؛ پیش‌فرض `false`. |
| `referralBonusCount` | Number | شمار پاداش‌های مرتبط با معرفی؛ پیش‌فرض `0`. |
| `registrationBonusPaid` | Boolean | آیا بونوس ثبت‌نام پرداخت شده؛ پیش‌فرض `false`. |
| `registrationBonusPending` | Boolean | آیا اعطای بونوس ثبت‌نام در انتظار تکمیل شرایط است؛ پیش‌فرض `false`. |
| `duelsPlayed` | Number | تعداد دوئل‌های ثبت‌شده برای کاربر؛ پیش‌فرض `0`. |
| `blockedBot` | Boolean | علامت‌گذاری مسدود بودن ربات توسط کاربر/خطای 403؛ پیش‌فرض `false`. |
| `balances.IRT.available` | Number، پیش‌فرض `0` | موجودی آزاد تومان. |
| `balances.IRT.locked` | Number، پیش‌فرض `0` | موجودی تومان رزروشده، مانند درخواست برداشت یا شرط فعال. |
| `balances.TON.available` | Number، پیش‌فرض `0` | موجودی آزاد برحسب nanoTON. |
| `balances.TON.locked` | Number، پیش‌فرض `0` | موجودی TON رزروشده برحسب nanoTON. |
| `createdAt`, `updatedAt` | Date | تاریخ ایجاد و آخرین تغییر. |

## 2. `tickets` — بلیت‌های صف پیدا کردن حریف

**مدل:** `Ticket`  
**کاربرد:** ثبت وضعیت هر کاربری که منتظر حریف برای دوئل شرطی یا دوستانه است.

| فیلد | نوع / مقدارهای مجاز | کاربرد |
|---|---|---|
| `_id` | String | شناسهٔ Ticket که توسط منطق صف تعیین می‌شود. |
| `userId` | Number، اجباری، ایندکس | شناسهٔ تلگرام صاحب بلیت. |
| `currency` | معمولاً `IRT` یا `TON` | ارز شرط. |
| `amount` | Number | مبلغ شرط در واحد ذخیره‌سازی ارز. |
| `mode` | `'bet'` یا `'friendly'`، پیش‌فرض `bet` | دوئل شرطی یا دوستانه. |
| `status` | معمولاً `queued`، `matched` یا `cancelled` | وضعیت بلیت؛ پیش‌فرض `queued`. |
| `matchId` | String اختیاری | شناسهٔ Match در صورت تطبیق. |
| `createdAtMs` | Number، اجباری | زمان ایجاد به میلی‌ثانیه از Unix epoch؛ برای مرتب‌سازی صف. |
| `queueTimeoutSeconds` | Number اختیاری | مهلت صف ذخیره‌شده برای این بلیت. |
| `timingScheduledAt` | Date اختیاری | زمان‌بندی کار مربوط به صف. |

ایندکس‌های مهم: ترکیب `status + createdAtMs` و `status + _id` برای جست‌وجوی کارآمد بلیت‌ها.

## 3. `matches` — دوئل‌ها

**مدل:** `Match`  
**کاربرد:** وضعیت انتخاب سنگ/کاغذ/قیچی، مهلت و نتیجهٔ دوئل.

| فیلد | نوع / مقدارهای مجاز | کاربرد |
|---|---|---|
| `_id` | String | شناسهٔ دوئل. |
| `currency` | `IRT` یا `TON` | ارز دوئل. |
| `amount` | Number | مبلغ شرط هر بازیکن (واحد داخلی ارز). |
| `mode` | `'bet'` یا `'friendly'`، پیش‌فرض `bet` | نوع دوئل. |
| `durationSeconds` | Number اختیاری | مدت دوئل ذخیره‌شده. |
| `reminderSent` | Boolean | آیا یادآوری ارسال شده؛ پیش‌فرض `false`. |
| `timingScheduledAt` | Date اختیاری | زمان‌بندی پردازش زمان‌دار. |
| `maxMessages` | Number اختیاری | حد پیام مجاز در دوئل. |
| `p1`, `p2` | Number، اجباری، ایندکس | شناسه‌های تلگرام دو بازیکن. |
| `c1`, `c2` | `'r'`, `'p'`, `'s'` یا `null` | انتخاب هر بازیکن؛ پیش‌فرض `null`. `r/p/s` به سنگ/کاغذ/قیچی اشاره دارند. |
| `status` | معمولاً `'choosing'` یا `'settled'` | وضعیت بازی؛ پیش‌فرض `choosing`. |
| `deadline` | Number، اجباری | مهلت نهایی انتخاب/پایان به شکل Unix timestamp میلی‌ثانیه‌ای مطابق منطق فعلی. |
| `fees.win` | Number | کارمزد نتیجهٔ برد، در واحد تعریف‌شده در منطق تسویه. |
| `fees.draw` | Number | کارمزد حالت مساوی. |
| `fees.winTimeout` | Number | کارمزد برد ناشی از timeout. |
| `fees.drawTimeout` | Number | کارمزد مساوی ناشی از timeout. |
| `outcome` | String اختیاری | نتیجهٔ نهایی متنی. |
| `winner` | Number یا `null` | شناسهٔ برنده؛ `null` برای حالت‌هایی مثل مساوی ممکن است استفاده شود. |
| `fee` | Number اختیاری | کارمزد ثبت‌شدهٔ نهایی، در صورت استفاده در تسویه. |
| `settledAt` | Date اختیاری | زمان تسویه. |
| `createdAt`, `updatedAt` | Date | تاریخ ایجاد/آخرین تغییر. |

ایندکس‌های مهم: `status + deadline` و `status + _id`.

## 4. `ledgers` — دفتر کل تراکنش‌های مالی

**مدل:** `Ledger`  
**کاربرد:** ثبت append-only عملیات مالی با کلید یکتا برای جلوگیری از اعمال دوبارهٔ یک عملیات.

| فیلد | نوع / مقدارهای رایج | کاربرد |
|---|---|---|
| `_id` | ObjectId خودکار | شناسهٔ داخلی سند. |
| `key` | String، اجباری و یکتا | کلید idempotency؛ یک عملیات مالی با یک کلید نباید دوبار اعمال شود. |
| `userId` | Number، اجباری، ایندکس | `tgId` کاربر؛ مقدار `0` برای حساب خود سیستم/House. |
| `currency` | `IRT` یا `TON` | ارز عملیات. |
| `type` | String | نوع تراکنش، مانند `deposit`, `withdraw_hold`, `withdraw_paid`, `withdraw_rejected`, `withdrawal_fee`, `admin_adjust` و انواع تسویهٔ دوئل/پاداش. فهرست دقیق انواع از محل‌های `applyOp` در کد می‌آید. |
| `available` | Number، پیش‌فرض `0` | تغییر موجودی آزاد؛ عدد مثبت افزایش و منفی کاهش است. |
| `locked` | Number، پیش‌فرض `0` | تغییر موجودی رزروشده. |
| `ref` | String اختیاری | شناسهٔ ارجاع مانند کد فاکتور/دوئل. |
| `at` | Date خودکار | زمان ایجاد رکورد؛ نام `createdAt` در این کالکشن به `at` نگاشت شده است. |

ایندکس یکتا روی `key` برای جلوگیری از دوباره‌کاری مالی مهم است. تراکنش‌های Ledger را دستی پاک یا ویرایش نکن؛ اصلاح باید با عملیات جبرانی ثبت‌شده انجام شود.

## 5. `houses` — حساب درآمد سیستم

**مدل:** `House`  
**کاربرد:** نگهداری جمع موجودی/درآمد داخلی سیستم، از جمله کارمزدهای برداشت و بازی.

| فیلد | نوع | کاربرد |
|---|---|---|
| `_id` | String | سند اصلی با شناسهٔ ثابت `house`. |
| `balances.IRT` | Number، پیش‌فرض `0` | جمع مقدار ثبت‌شده برای حساب سیستم به تومان. |
| `balances.TON` | Number، پیش‌فرض `0` | جمع مقدار ثبت‌شده برای حساب سیستم برحسب nanoTON. |

در زمان اتصال دیتابیس، کد سند `house` را در صورت نبودن ایجاد می‌کند.

## 6. `payments` — پرداخت‌های عمومی/سازگاری پرداخت

**مدل:** `Payment`  
**کاربرد:** ثبت دادهٔ یک پرداخت عمومی؛ جریان‌های واریز دستی و TON در این نسخه کالکشن‌های اختصاصی هم دارند.

| فیلد | نوع / مقدارهای مجاز | کاربرد |
|---|---|---|
| `_id` | String | شناسهٔ پرداخت؛ مقدار را کد ایجادکننده تعیین می‌کند. |
| `userId` | Number، اجباری، ایندکس | شناسهٔ تلگرام کاربر. |
| `currency` | String | ارز پرداخت (`IRT`/`TON` در طراحی جاری). |
| `amount` | Number | مبلغ با واحد داخلی ارز. |
| `status` | String، پیش‌فرض `pending` | وضعیت؛ نوع مدل `pending`, `paid`, `failed` را تعریف می‌کند. |
| `provider` | String اختیاری | نام ارائه‌دهندهٔ پرداخت. |
| `providerRef` | String اختیاری، ایندکس | شناسه در ارائه‌دهندهٔ بیرونی. |
| `txId` | String اختیاری، یکتا در صورت وجود | شناسهٔ تراکنش؛ ایندکس یکتای sparse. |
| `createdAt`, `updatedAt` | Date | تاریخ ایجاد/به‌روزرسانی. |

## 7. `manualdepositinvoices` — فاکتورهای واریز دستی

**مدل:** `ManualDepositInvoice`  
**کاربرد:** فاکتور شارژ حساب که با انتقال بانکی دستی پرداخت می‌شود و بعد از بررسی رسید توسط مدیر تأیید می‌شود. اطلاعات مقصد در لحظهٔ ایجاد در خود فاکتور snapshot می‌شود تا تغییر بعدی تنظیمات، فاکتور قبلی را عوض نکند.

| فیلد | نوع / مقدارهای مجاز | کاربرد |
|---|---|---|
| `_id` | ObjectId خودکار | شناسهٔ داخلی سند. |
| `invoiceNumber` | Number، اجباری، یکتا، ایندکس | کد پیگیری قابل مشاهدهٔ کاربر. |
| `userId` | Number، اجباری، ایندکس | شناسهٔ تلگرام صاحب فاکتور. |
| `userFirstName` | String، پیش‌فرض خالی | نام ذخیره‌شده هنگام ساخت فاکتور. |
| `userUsername` | String، پیش‌فرض خالی | نام کاربری ذخیره‌شده هنگام ساخت فاکتور. |
| `currency` | `IRT` یا `TON`، اجباری | ارز فاکتور. |
| `amount` | Number، حداقل `1`، اجباری | مبلغ قابل پرداخت؛ TON برحسب nanoTON. |
| `status` | `pending`, `approved`, `rejected` | وضعیت فاکتور؛ پیش‌فرض `pending`. |
| `cardNumber` | String، پیش‌فرض خالی | شماره کارت مقصد برای واریز دستی تومانی؛ در فاکتور snapshot می‌شود. |
| `cardHolder` | String، پیش‌فرض خالی | صاحب کارت مقصد. |
| `supportUsername` | String، پیش‌فرض خالی | شناسهٔ پشتیبانی snapshot‌شده برای فاکتور. |
| `reviewedBy` | Number اختیاری | شناسهٔ مدیر تأییدکننده/ردکننده. |
| `reviewedAt` | Date اختیاری | زمان بررسی. |
| `reviewReason` | String، پیش‌فرض خالی | دلیل رد فاکتور. |
| `createdAt`, `updatedAt` | Date | تاریخ‌ها. |

ایندکس‌های مهم: `invoiceNumber` یکتا، `status + createdAt` و `userId + createdAt`.

## 8. `tondepositinvoices` — فاکتورهای واریز بلاک‌چینی TON

**مدل:** `TonDepositInvoice`  
**کاربرد:** تشخیص تراکنش ورودی TON با مبلغ و کامنت اختصاصی و شارژ خودکار کاربر پس از تطبیق تراکنش.

| فیلد | نوع / مقدارهای مجاز | کاربرد |
|---|---|---|
| `_id` | ObjectId خودکار | شناسهٔ داخلی. |
| `invoiceNumber` | Number، اجباری، یکتا، ایندکس | کد قابل مشاهدهٔ فاکتور. |
| `userId` | Number، اجباری، ایندکس | شناسهٔ صاحب فاکتور. |
| `currency` | فقط `TON`، پیش‌فرض `TON` | ارز فاکتور. |
| `amount` | Number، حداقل `1` | مبلغ دقیق به nanoTON. |
| `recipientAddress` | String، اجباری | آدرس دریافت‌کننده. |
| `comment` | String، اجباری و یکتا | شناسه/کامنت اختصاصی انتقال که برای تطبیق فاکتور استفاده می‌شود؛ هش تراکنش نیست. |
| `paymentUrl` | String، پیش‌فرض خالی | لینک پرداخت کیف پول در شبکه‌هایی که لینک پشتیبانی می‌شود. |
| `network` | `mainnet` یا `testnet` | شبکه؛ پیش‌فرض `mainnet`. |
| `status` | `pending` یا `paid` | وضعیت؛ پیش‌فرض `pending`. |
| `txHash` | String اختیاری، یکتا در صورت وجود | هش تراکنش واقعی زنجیره؛ ایندکس sparse یکتا. |
| `sourceAddress` | String، پیش‌فرض خالی | آدرس فرستندهٔ تشخیص‌داده‌شده. |
| `paidAt` | Date اختیاری | زمان تأیید پرداخت. |
| `createdAt`, `updatedAt` | Date | تاریخ‌ها. |

ایندکس‌های مهم: کد فاکتور یکتا، `comment` یکتا، `txHash` یکتا sparse، و ترکیب‌های `userId + createdAt` و `status + createdAt`.

## 9. `sequences` — شمارنده‌های ترتیبی

**مدل:** `Sequence`  
**کاربرد:** نگهداری شمارنده‌هایی که کدهای انسانی قابل افزایش تولید می‌کنند.

| فیلد | نوع | کاربرد |
|---|---|---|
| `_id` | String | نام شمارنده؛ کلید اصلی. |
| `value` | Number، پیش‌فرض `99999` | مقدار شمارنده؛ در صورت استفاده برای شماره‌های شش‌رقمی از `100000` آغاز می‌شود. |

در کد فعلی، برخی فاکتورها از کد تصادفی هفت‌رقمی استفاده می‌کنند؛ بنابراین وجود `Sequence` به معنای استفادهٔ همهٔ فاکتورها از آن نیست.

## 10. `withdrawals` — فاکتورهای برداشت

**مدل:** `Withdrawal`  
**کاربرد:** درخواست برداشت تومانی یا TON، رزرو مبلغ، پیگیری وضعیت و ثبت جزئیات پرداخت. اعلان فاکتور جدید فقط به مالک ارسال می‌شود؛ مدیران مجاز می‌توانند با کد پیگیری آن را جست‌وجو کنند، ولی اقدام تأیید/رد مخصوص مالک است.

| فیلد | نوع / مقدارهای مجاز | کاربرد |
|---|---|---|
| `_id` | String | کد پیگیری فاکتور (در این نسخه کد تصادفی عددی ۷ رقمی به شکل String). |
| `userId` | Number، اجباری، ایندکس | شناسهٔ تلگرام کاربر درخواست‌دهنده. |
| `currency` | `IRT` یا `TON` | ارز برداشت. |
| `amount` | Number | مبلغ ناخالص درخواست و مبلغی که هنگام ایجاد فاکتور از موجودی آزاد رزرو می‌شود. |
| `fee` | Number، حداقل صفر، پیش‌فرض `0` | snapshot کارمزد ثابت در واحد ذخیره‌سازی ارز: تومان برای IRT و nanoTON برای TON. |
| `payoutAmount` | Number، حداقل صفر | مبلغ خالص قابل پرداخت؛ معمولاً `amount - fee`. |
| `dest` | String، اجباری | مقصد: شماره شبا برای IRT یا آدرس کیف پول برای TON. اطلاعات مالی حساس است. |
| `bankName` | String، پیش‌فرض خالی | نام بانک تشخیص‌داده‌شده برای برداشت تومانی. |
| `fullName` | String، پیش‌فرض خالی | نام صاحب حساب بانکی. |
| `status` | `pending`, `paid`, `rejected` | وضعیت؛ پیش‌فرض `pending`. |
| `reviewedBy` | Number اختیاری | شناسهٔ Telegram مالک که درخواست را بررسی کرده است. |
| `reviewedAt` | Date اختیاری | زمان بررسی. |
| `reviewReason` | String، پیش‌فرض خالی | دلیل رد؛ در درخواست تأییدشده خالی است. |
| `createdAt`, `updatedAt` | Date | تاریخ‌ها. |

**رفتار مالی:** ساخت فاکتور ابتدا `amount` را از `balances.<currency>.available` به `locked` منتقل می‌کند. در صورت تأیید پرداخت، مبلغ رزروشده تسویه و کارمزد در `House`/`Ledger` ثبت می‌شود. در صورت رد، کل مبلغ ناخالص به موجودی آزاد کاربر برمی‌گردد و کارمزد اخذ نمی‌شود. وضعیت فقط از `pending` تغییر می‌کند؛ این شرط اتمیک مانع از دو بار پرداخت/رد شدن یک فاکتور می‌شود.

## 11. `grouptargets` — گروه‌های شناخته‌شده برای پیام انبوه

**مدل:** `GroupTarget`  
**کاربرد:** نگهداری گروه‌ها و سوپرگروه‌هایی که ربات در آن‌ها مشاهده شده تا کمپین‌های گروهی بتوانند مقصدها را انتخاب کنند.

| فیلد | نوع / مقدارهای مجاز | کاربرد |
|---|---|---|
| `_id` | ObjectId خودکار | شناسهٔ داخلی. |
| `chatId` | String، اجباری و یکتا | شناسهٔ چت گروه. |
| `title` | String، پیش‌فرض خالی | عنوان گروه. |
| `username` | String، پیش‌فرض خالی | نام کاربری عمومی گروه، در صورت وجود. |
| `type` | `'group'` یا `'supergroup'`، اجباری | نوع چت. |
| `status` | `'active'` یا `'left'` | آیا ربات هنوز عضو/فعال در گروه است؛ پیش‌فرض `active`. |
| `lastSeenAt` | Date اختیاری | آخرین زمان مشاهدهٔ گروه. |
| `addedAt` | Date، پیش‌فرض زمان فعلی | زمان ثبت اولیه. |
| `createdAt`, `updatedAt` | Date | تاریخ‌ها. |

## 12. `broadcastcampaigns` — کمپین‌های پیام انبوه

**مدل:** `BroadcastCampaign`  
**کاربرد:** اطلاعات پایدار یک کمپین، فیلتر مخاطب، آمار ارسال و ادامهٔ پردازش پس از restart.

| فیلد | نوع / مقدارهای مجاز | کاربرد |
|---|---|---|
| `_id` | String | شناسهٔ کمپین. |
| `ownerId` | Number، اجباری، ایندکس | شناسهٔ سازنده/مالک کمپین. |
| `sourceChatId` | String، اجباری | چتی که پیام اصلی از آن کپی/ارسال می‌شود. |
| `sourceMessageId` | Number، اجباری | شناسهٔ پیام مبدأ در تلگرام. |
| `audience` | `users`, `groups`, `both` | جامعهٔ هدف. |
| `userFilter` | Mixed اختیاری | شیء فیلتر کاربران؛ مثلاً نوع فیلتر، ارز، عملگر و مقدار. |
| `groupLimit` | Number اختیاری | سقف گروه‌های هدف؛ در منطق رابط ممکن است `0` به معنی همه باشد. |
| `totalUsers`, `totalGroups` | Number، پیش‌فرض `0` | تعداد هدف نهایی. |
| `estimatedUsers`, `estimatedGroups` | Number، پیش‌فرض `0` | برآورد اولیهٔ مخاطب. |
| `status` | `queued`, `running`, `completed`, `failed`, `cancelled` | وضعیت کمپین؛ پیش‌فرض `queued`. |
| `sentUsers`, `failedUsers` | Number، پیش‌فرض `0` | شمار موفق/ناموفق کاربران. |
| `sentGroups`, `failedGroups` | Number، پیش‌فرض `0` | شمار موفق/ناموفق گروه‌ها. |
| `processedUsers`, `processedGroups` | Number، پیش‌فرض `0` | تعداد مقصدهای پردازش‌شده. |
| `lastUserObjectId`, `lastGroupObjectId` | String اختیاری | نشانگر ادامهٔ پردازش صفحه‌ای. |
| `startedAt`, `finishedAt` | Date اختیاری | زمان شروع/پایان. |
| `lastError` | String اختیاری | آخرین خطای ذخیره‌شده. |
| `createdAt`, `updatedAt` | Date | تاریخ‌ها. |

## 13. `broadcastdeliveries` — وضعیت ارسال به هر مقصد کمپین

**مدل:** `BroadcastDelivery`  
**کاربرد:** هر سند نمایانگر تلاش/وضعیت تحویل یک کمپین به یک کاربر یا گروه است؛ برای ادامهٔ امن و جلوگیری از ایجاد رکورد تکراری.

| فیلد | نوع / مقدارهای مجاز | کاربرد |
|---|---|---|
| `_id` | ObjectId خودکار | شناسهٔ داخلی. |
| `campaignId` | String، اجباری | شناسهٔ کمپین. |
| `targetType` | `user` یا `group` | نوع گیرنده. |
| `targetId` | String، اجباری | شناسهٔ منطقی گیرنده. |
| `chatId` | String، اجباری | شناسهٔ چتی که به Telegram API داده می‌شود. |
| `status` | `pending`, `sending`, `sent`, `failed` | وضعیت تحویل؛ پیش‌فرض `pending`. |
| `attempts` | Number، پیش‌فرض `0` | تعداد تلاش‌ها. |
| `error` | String، پیش‌فرض خالی | متن آخرین خطا. |
| `createdAt`, `updatedAt` | Date | تاریخ‌ها. |

ایندکس یکتای ترکیبی `campaignId + targetType + targetId` مانع ثبت چند رکورد برای یک مقصد در یک کمپین است.

## 14. `settings` — تنظیمات دائمی ربات

**مدل:** `Settings`  
**کاربرد:** سند تنظیمات سراسری که مالک/ادمین‌ها از پنل تغییر می‌دهند. سند فعال دارای `_id: 'main'` است. مدل `strict: false` دارد؛ بنابراین ساختار فیلدهای تنظیمات از شیء `DEFAULTS` و `settings.ts` می‌آید، نه یک schema سخت‌گیرانهٔ فیلدبه‌فیلد.

ساختار مهم سند:

```js
{
  _id: 'main',
  version: Number,
  bets: { IRT: Number[], TON: Number[] },
  fees: { win: Number, draw: Number, winTimeout: Number, drawTimeout: Number },
  withdrawalFees: { IRT: Number, TON: Number },
  limits: {
    minDeposit: { IRT: Number, TON: Number },
    minWithdraw: { IRT: Number, TON: Number },
    minDuelsForWithdraw: Number,
    minReferralsForWithdraw: Number
  },
  referral: { rewardIRT: Number, reward: { IRT: Number, TON: Number }, maxPaidReferrals: Number },
  registrationBonus: { IRT: Number, TON: Number },
  features: { duelsEnabled: Boolean, depositsEnabled: Boolean, withdrawalsEnabled: Boolean, chatEnabled: Boolean },
  membership: { enabled: Boolean, channels: [{ chatId: String, title: String, url: String }] },
  manualDeposit: { cardNumber: String, cardHolder: String, supportUsername: String, tonAddress: String },
  match: { seconds: Number, friendlySeconds: Number },
  queue: { seconds: Number, friendlySeconds: Number },
  chat: { maxMessages: Number, friendlyMaxMessages: Number, profanityPenalty: { IRT: Number, TON: Number } },
  bannedWords: String[]
}
```

نکتهٔ واحدها: مقدار `withdrawalFees.TON` و `chat.profanityPenalty.TON` در سند داخلی nanoTON است؛ پنل، مقدار انسانی مانند `0.01` TON را با `parseAmount` تبدیل می‌کند. `fees` مربوط به تسویهٔ بازی است و به‌صورت basis points ذخیره می‌شود: `1000 = 10%`؛ کد پنل درصد ورودی را به basis points تبدیل می‌کند. این تنظیم‌ها با کارمزد ثابت برداشت که مبلغ است، تفاوت دارند.

## 15. `adminlogs` — گزارش عملیات مدیریتی

**مدل:** `AdminLog`  
**کاربرد:** ردگیری تغییرات تنظیمات و اقدامات مدیریتی برای بررسی و عیب‌یابی.

| فیلد | نوع | کاربرد |
|---|---|---|
| `_id` | ObjectId خودکار | شناسهٔ داخلی. |
| `adminId` | Number اختیاری | شناسهٔ تلگرام مدیر انجام‌دهنده. |
| `action` | String اختیاری | نام عملیات، مثلاً `setting_ui` یا تغییر نقش/تنظیم. |
| `detail` | String اختیاری | جزئیات متنی عملیات. |
| `at` | Date خودکار | زمان ایجاد رکورد؛ timestamp ایجاد به `at` نگاشت شده است. |

## داده‌هایی که کالکشن MongoDB نیستند

موارد زیر در Redis یا محیط اجرا نگهداری می‌شوند و نباید انتظار داشته باشی به‌صورت کالکشن MongoDB دیده شوند:

- وضعیت مکالمهٔ موقت کاربران (`st:<telegramId>`)، مانند «منتظر مبلغ برداشت» یا «منتظر دلیل رد فاکتور»؛ این وضعیت‌ها TTL دارند.
- داده‌ها/قفل‌های صف Redis Streams، کلیدهای idempotency موقت، lockهای تأیید و قفل‌های جلوگیری از اجرای موازی.
- کش تنظیمات و پیام invalidation آن (`cfg:main`, `cfg:invalidate`). نسخهٔ پایدار تنظیمات در `settings` قرار دارد.
- کلیدهای Telemetry مانیتورینگ سرورها و Heartbeatهای Workerها. این داده‌ها موقتی‌اند و با TTL حذف می‌شوند.
- متغیرهای محیطی مانند توکن Telegram، `MONGO_URI`, `REDIS_URL`, نام سرورها و نام instanceها در فایل `.env` یا محیط استقرار هستند؛ در کالکشن‌های فوق ذخیره نمی‌شوند.

## رابطه‌های مهم به زبان ساده

- `users.tgId` شناسهٔ اصلی کاربر در منطق برنامه است؛ `withdrawals.userId`, `ledgers.userId`, `matches.p1/p2` و `tickets.userId` به همین شناسهٔ تلگرام اشاره می‌کنند، نه لزوماً به `users._id`.
- `withdrawals._id` به عنوان مرجع درخواست برداشت در رکوردهای Ledger (`ref`) ثبت می‌شود.
- `matches._id` مرجع مالی عملیات دوئل در Ledger می‌تواند باشد.
- `broadcastcampaigns._id` به `broadcastdeliveries.campaignId` وصل می‌شود.
- `ManualDepositInvoice.invoiceNumber`، `TonDepositInvoice.invoiceNumber` و `Withdrawal._id` کدهای پیگیری‌اند، اما به دلیل اینکه هر collection یکتایی خود را جداگانه اعمال می‌کند، کد یکسان در دو نوع فاکتور مختلف از لحاظ فنی ممکن است؛ جست‌وجوی پنل باید نوع/تمام نتایج منطبق را در نظر بگیرد.

## نکات ایمنی دیتابیس

1. کالکشن‌های `users`, `ledgers`, `withdrawals`, `houses` و فاکتورهای واریز را دستی و بدون بکاپ تغییر نده؛ اعداد موجودی باید با دفتر کل هماهنگ بمانند.
2. پیش از migration یا پاک‌سازی، از MongoDB بکاپ بگیر و سرویس‌های نویسنده را متوقف یا به شکل برنامه‌ریزی‌شده قفل کن.
3. وضعیت برداشت را فقط با منطق اتمیک خود برنامه تغییر بده. تغییر مستقیم `withdrawals.status` بدون ثبت Ledger می‌تواند موجودی را ناسازگار کند.
4. آدرس کیف پول، شماره شبا، شناسه تلگرام و اطلاعات پرداخت دادهٔ حساس‌اند؛ دسترسی دیتابیس و فایل dump را محدود کن.
5. اگر برای کالکشن قدیمی یا رکوردی فیلدی را نمی‌بینی، این ممکن است به دلیل optional بودن آن فیلد، نسخهٔ قدیمی سند یا مسیر کدی باشد که آن فیلد را ایجاد نکرده است؛ schema به‌تنهایی تضمین نمی‌کند تمام سندهای قدیمی همهٔ فیلدهای اختیاری را داشته باشند.
