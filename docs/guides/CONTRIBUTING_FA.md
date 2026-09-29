# مشارکت در Translate It

این سند دستورالعمل‌هایی برای راه‌اندازی پروژه به صورت محلی و فرآیند اعمال تغییرات ارائه می‌دهد.

## نحوه‌ی مشارکت

ما از انواع مشارکت‌ها استقبال می‌کنیم! با وجود اینکه یک فرآیند پیشنهادی برای نظم بخشیدن به کارها داریم، **ما بیش از حد سخت‌گیر نیستیم**. مهم‌ترین چیز این است که مشارکت شما واضح و قابل فهم باشد.

### فرآیند پیشنهادی:

1. **فورک کردن پروژه**: یک کپی از پروژه برای خود بسازید.
2. **ایجاد برنچ (Branch)**: انتخاب یک نام واضح مثل `feature/new-button` یا `fix/typo` بسیار کمک‌کننده است.
3. **اعمال تغییرات**: قابلیت جدید خود را پیاده‌سازی یا باگ را رفع کنید.
4. **اعتبارسنجی**: بهتر است یک بررسی سریع (بخش [کیفیت کد](#کیفیت-کد-و-اعتبارسنجی)) انجام دهید تا از صحت عملکرد مطمئن شوید.
5. **ارسال Pull Request (PR)**:
   - یک عنوان واضح برای PR خود انتخاب کنید (ترجیحاً نام قابلیت یا اصلاحی که انجام داده‌اید).
   - به طور خلاصه توضیح دهید چه چیزی را تغییر داده‌اید.

*اگر در انجام هر یک از این مراحل با مشکل مواجه شدید نگران نباشید، ما در کل فرآیند به شما کمک خواهیم کرد!*

---

## 🛠 یادداشت‌های توسعه

### پیش‌نیازها

مطمئن شوید [**Node.js**](https://nodejs.org/) و [**pnpm**](https://pnpm.io/) نصب شده باشند. سپس، ریپازیتوری را کلون کرده و وابستگی‌ها را نصب کنید:

```bash
git clone https://github.com/Translate-It-App/Translate-It.git
cd Translate-It
pnpm install
```

### راه‌اندازی اولیه

پس از نصب وابستگی‌ها، دستور راه‌اندازی را اجرا کنید:

```bash
pnpm run setup
```

### ساخت برای توسعه

برای تولید فایل‌های افزونه جهت توسعه:

```bash
# ساخت برای هر دو مرورگر (به صورت موازی)
pnpm run build

# ساخت برای یک مرورگر خاص
pnpm run build:chrome
pnpm run build:firefox
```

برای مشاهده تغییرات در لحظه (Watch mode):

```bash
pnpm run watch:chrome
pnpm run watch:firefox
```

### کیفیت کد و اعتبارسنجی

#### بررسی کد (Linting)

```bash
# بررسی کدهای JS
pnpm run lint

# بررسی استایل‌های CSS
pnpm run lint:styles

# مرتب‌سازی کدها با Prettier
pnpm run format
```

#### اعتبارسنجی افزونه

```bash
# اعتبارسنجی هر دو مرورگر
pnpm run validate
```

---

## مستندات فنی

برای درک عمیق‌تر از معماری و طراحی سیستم، لطفاً به موارد زیر مراجعه کنید:
- [Architecture Overview](../technical/ARCHITECTURE.md)
- [Desktop FAB System](../technical/DESKTOP_FAB_SYSTEM.md)
- [Mobile Support Architecture](../technical/MOBILE_SUPPORT.md)
- [Translation Provider Logic](../technical/TRANSLATION_PROVIDER_LOGIC.md)
- [Messaging System](../technical/MessagingSystem.md)
- [و موارد بیشتر در پوشه فنی...](../technical/)
