# Barındırılan mobil sürüm ve iPhone bildirimi — plan

Tarih: 2026-08-13. Hedef: tek kullanıcı (parola ile), mobil uyumlu kurulabilir
site, en az dakikada bir yenileme, **en düşük maliyet**, ve asıl amaç olan
**güvenilir iPhone bildirimi** — PC açık olmasa da.

## 1. Elimizde ne var

| Parça | Durum |
|---|---|
| Convex zamanlayıcı + şifreli kasa + algılayıcı durumu | **hazır** (`convex/`) |
| `/api/cron/check` route'u, `CRON_SECRET` ile korumalı | **hazır** |
| Web Push (VAPID) + service worker (`public/sw.js`) | **hazır** |
| **Telegram bildirim kanalı** (`lib/notify.ts`) | **hazır** |
| Genel JSON webhook kanalı | **hazır** |
| Parola girişi, oturum çerezi, giriş oran sınırı | **hazır** |
| Responsive/mobil arayüz (kota defteri, komut çubuğu, safe-area) | **hazır** |
| **Web App Manifest + PWA ikonları** | **YOK — tek gerçek eksik** |
| Convex cron sıklığı | 5 dakika (`convex/crons.ts`), 1 dakikaya çekilecek |

`codex/how-much-ai-private-pwa` dalı yalnız tasarım dokümanı içeriyor, kod yok.

## 2. Ana tavsiye: iPhone bildirimi için Telegram, iOS Web Push değil

Bu, planın en önemli kararı ve maliyeti/emeği en çok düşüren şey.

**iOS Web Push'un gerçek kısıtları:**

- Yalnız **Ana Ekran'a eklenmiş** PWA'da çalışır. Safari sekmesinde çalışmaz.
- Kurulum ritüeli kullanıcıya bağlı; PWA silinirse abonelik sessizce ölür.
- iOS arka plan teslimini kısabilir/geciktirebilir — dakikalık gecikme garanti değil.
- Odak/Rahatsız Etme kolayca bastırır.
- HTTPS + manifest + ikon matrisi + VAPID anahtarı + abonelik yenileme mantığı gerekir.

**Telegram:**

- Kod **zaten yazılmış** (`lib/notify.ts` → `api.telegram.org/bot<token>/sendMessage`).
- Kurulum: bot oluştur, bir kez mesaj at, `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` gir. Bitti.
- Native uygulama push'u — iOS Web Push'tan belirgin şekilde güvenilir.
- Manifest, ikon, service worker, VAPID, Ana Ekran kurulumu **gerekmez**.
- Ücretsiz.

**Karar:** bildirim omurgası Telegram olsun. iOS Web Push sonradan
*ikinci* kanal olarak eklenebilir; ona bağımlı kalmayalım.

PWA/manifest işi yine yapılır — ama **siteyi telefonda düzgün açmak** için,
bildirim mekanizması olarak değil. Bu ayrım, işin riskli kısmını fiddly
kısmından ayırır.

## 3. Mimari

```
Convex cron (1 dk)
   └─> POST /api/cron/check   (Vercel, x-cron-secret)
         └─> Convex kasadan hesapları oku
         └─> sağlayıcı kullanım uçlarını oku (Claude / ChatGPT / Grok)
         └─> saf algılayıcı: eşik ve reset geçişleri
         └─> Telegram'a gönder   [+ opsiyonel Web Push]
```

- **Vercel Hobby** — siteyi barındırır. Ücretsiz. (Vercel cron'u *kullanılmıyor*;
  Hobby'de cron günde bir kez sınırlı. Sıklığı Convex veriyor, Vercel'e sadece
  HTTP isteği geliyor.)
- **Convex ücretsiz katman** — zamanlayıcı, şifreli kasa, algılayıcı durumu.
- Toplam donanım/abonelik maliyeti: **0**.

## 4. 1 dakikalık yenilemenin gerçek maliyeti

Convex ücretsiz katman ayda ~1M fonksiyon çağrısı verir.

| Sıklık | Aylık döngü | Döngü başına ~12 çağrı | Kotanın payı |
|---|---|---|---|
| 5 dakika | 8.640 | ~104.000 | %10 |
| **1 dakika** | **43.200** | **~518.000** | **%52** |

1 dakika ücretsiz katmana sığar ama yarısını yer ve hata payı bırakmaz.

**Dürüst değerlendirme:** haftalık kotalar için 1 dakika ile 5 dakika arasında
pratik fark yok — haftalık limit 4 dakikada eşik atlamaz. Fark yalnız
**Grok Build** gibi dar pencerelerde anlamlı (2 saatte 10 sorgu; her sorgu %10).

**Önerim — iki hızlı yoklama:**

- **Hızlı şerit (1 dk):** bir eşiğe yakın olan veya son 30 dakikada hareket
  görmüş limitler.
- **Yavaş şerit (5–15 dk):** boştaki hesaplar.

Böylece önemli olan yerde 1 dakikalık tepki alınır, maliyet ~%15'e iner.
İstersen düz 1 dakika da yapılır; sadece bütçe payı daralır.

## 5. Karar vermen gereken tek büyük şey: kimlik bilgileri buluta çıkıyor

Bugün: kimlik bilgileri bu makinede, DPAPI korumalı, yalnız `127.0.0.1`.
Barındırılan sürümde: sağlayıcı token'ları **Convex'te** duracak
(`VAULT_ENCRYPTION_SECRET` ile şifreli — uygulama bunu zaten destekliyor).

PC bağımlılığından çıkmanın başka yolu yok: iPhone'a bildirim gitmesi için
senin PC'n kapalıyken de çalışan bir sunucu gerekiyor.

**Grok için ayrıca ağır:** bulduğum kimlik yolu bir **oturum çerezi**
(HttpOnly `sso`) — kapsamı dar bir OAuth token değil, **Grok hesabının tamamına
erişim**. Bunu bulut veritabanında tutmak, Claude/ChatGPT token'larını tutmaktan
belirgin şekilde riskli. Grok'u ilk sürümde **yerelde bırakmayı** öneriyorum.

Ek güvenlik notu: site herkese açık bir adreste tek parolayla duracak.
Uygulama 32+ karakter parola dayatıyor ve giriş oran sınırı var; yine de
tahmin edilmesi zor bir alt alan adı kullanmak iyi olur.

## 6. Yapılacaklar

1. **Manifest + ikonlar** — `app/manifest.ts`, 192/512 PNG + maskable 512.
   Mobilde "Ana Ekrana Ekle" ve düzgün açılış için. (küçük)
2. **Convex cron 5 dk → 1 dk** (veya iki hızlı şerit). (küçük)
3. **Telegram kanalını uçtan uca bağla ve gerçek cihazda doğrula.** (küçük)
4. **Vercel + Convex kurulumu**, ortam değişkenleri, ilk dağıtım. (orta)
5. **Hesapları hosted kasaya bağla** — Claude + ChatGPT. Grok yerelde kalsın. (orta)
6. Opsiyonel: iOS Web Push'u ikinci kanal olarak ekle. (sonra)

Yerel strict-local sürüm bozulmadan kalır; bu topoloji ona ek, onun yerine değil.
