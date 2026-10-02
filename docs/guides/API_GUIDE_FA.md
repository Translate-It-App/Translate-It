# راهنمای تنظیمات API

برخی ارائه‌دهندگان مبتنی بر API به کلید معتبر نیاز دارند، در حالی که برخی دیگر — از جمله پیکربندی‌های محلی یا سفارشی — بسته به تنظیمات می‌توانند بدون کلید کار کنند.

---

## 🔑 دریافت کلید API

در زیر لیست رایج‌ترین ارائه‌دهندگان و نحوه‌ی دریافت کلیدهای API آن‌ها آورده شده است.

| ارائه‌دهنده | دسترسی | نحوه‌ی دریافت |
| :--- | :--- | :--- |
| **Google Translate** | رایگان | *بدون نیاز به کلید API* |
| **Microsoft Translator** | رایگان | *بدون نیاز به کلید API* |
| **Yandex Translate** | رایگان | *بدون نیاز به کلید API* |
| **Lingva Translate** | رایگان | *بدون نیاز به کلید API* |
| **Google Gemini** | رایگان/پولی | [Google AI Studio](https://aistudio.google.com/apikey/) |
| **DeepL** | رایگان/پولی | [DeepL API Keys](https://www.deepl.com/en/your-account/keys/) |
| **OpenRouter** | پولی | [OpenRouter API Keys](https://openrouter.ai/settings/keys/) |
| **Requesty** | پولی | [Requesty API Keys](https://app.requesty.ai/api-keys) |
| **OpenAI** | پولی | [OpenAI API Keys](https://platform.openai.com/api-keys/) |
| **DeepSeek** | پولی | [DeepSeek API Keys](https://platform.deepseek.com/api-keys/) |
| **WebAI to API** | رایگان | [Local Server](https://github.com/Amm1rr/WebAI-to-API/) |

---

## پشتیبانی از چندین کلید API

می‌توانید برای هر ارائه‌دهنده **چندین کلید API** وارد کنید (هر کدام در یک خط). افزونه موارد زیر را انجام می‌دهد:
- ✅ اگر کلید فعلی به سقف مجاز (quota) برسد، به‌طور خودکار کلید بعدی را امتحان می‌کند.
- ✅ کلیدهای فعال را برای عملکرد بهتر در ابتدای لیست قرار می‌دهد.

---

## 🛠 تنظیمات پیشرفته ارائه‌دهندگان

می‌توانید هر ارائه‌دهنده را برای ایجاد تعادل بین کیفیت و هزینه شخصی‌سازی کنید:

- **Google Gemini:** مدل را از قسمت انتخاب مدل (Model selector) انتخاب کنید. از `API URL` سفارشی فقط هنگام انتخاب Custom Model استفاده کنید.
- **OpenAI:** وارد کردن نام مدل‌های خاص مانند `gpt-6-luna` یا `gpt-6-sol`.
- **OpenRouter:** پشتیبانی از مدل‌های متنوع؛ نام مدل را از [مستندات OpenRouter](https://openrouter.ai/models) کپی کنید.
- **Requesty:** دسترسی به مدل‌های متنوع از طریق یک API؛ یک مدل از فهرست انتخاب کنید یا شناسه مدل (مثلاً `openai/gpt-4o-mini`) را از [مستندات Requesty](https://docs.requesty.ai) وارد کنید.
- **DeepSeek:** شخصی‌سازی مدل مطابق [مستندات DeepSeek](https://api-docs.deepseek.com/api/list-models/)؛ امکان تنظیم سطح تفکر نیز وجود دارد.
- **DeepL:** تنظیم سطح API (رایگان یا پرو) و تنظیمات لحن ترجمه (formality).
- **سفارشی (سازگار با OpenAI):** اتصال به مدل‌های میزبانی شده توسط خودتان (مثل **Ollama**) یا هر سرویس سازگار با OpenAI با وارد کردن `API URL` و نام مدل.

---

## مدل‌های پیش‌فرض

اگر مدلی را مشخص نکنید، مدل‌های زیر به صورت پیش‌فرض استفاده می‌شوند:
- **OpenAI:** `gpt-6-luna`
- **OpenRouter:** `openai/gpt-6-luna`
- **Requesty:** `openai/gpt-4o-mini`
- **Google Gemini:** `gemini-3.8-flash`
- **WebAI to API:** `gemini-3-flash`
- **DeepSeek:** `deepseek-flash`
