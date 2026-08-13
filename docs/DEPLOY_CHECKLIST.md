# Web kurulumu — adım adım

Sabah yapılacak iki işten biri. Kod tarafı hazır; burada yalnız hesap açma,
değişken girme ve dağıtım kaldı. Sıra önemli: Convex önce, çünkü Vercel'e
gireceğin `CONVEX_URL` oradan çıkıyor.

Tahmini süre: 30–45 dakika. Maliyet: 0 (Vercel Hobby + Convex ücretsiz katman).

---

## 0. Önce karar ver

**Hangi hesaplar buluta çıkacak?** Bulut kasasına konan her kimlik bu makineden
çıkmış olur. Öneri: Claude + ChatGPT buluta, Grok'a ayrıca karar ver (oturum
çerezi dar kapsamlı bir token değil, hesabın tamamına erişim).

Yerel strict-local kurulum bundan etkilenmez; ikisi yan yana çalışır.

---

## 1. Convex

```bash
npx convex login
npx convex deploy
```

Deploy çıktısındaki dağıtım URL'sini not al → Vercel'de `CONVEX_URL` olacak.

Convex tarafına da iki değişken gerekiyor:

```bash
npx convex env set VAULT_ACCESS_SECRET   # 32+ karakter, rastgele
npx convex env set APP_URL               # Vercel adresin, sonunda / olmadan
npx convex env set CRON_SECRET           # 32+ karakter, rastgele
```

`APP_URL` Vercel dağıtımından sonra netleşiyor; önce boş geç, adım 3'te dön ve gir.

Zamanlayıcı `convex/crons.ts` içinde **60 saniye**ye ayarlı. Convex panelinde
"check usage" işi görünmeli.

## 2. Vercel

```bash
npx vercel link
npx vercel --prod
```

Ortam değişkenleri (`npx vercel env add <AD> production`):

| Değişken | Not |
|---|---|
| `APP_PASSWORD` | Giriş parolan. **32+ karakter**, uygulama dayatıyor. |
| `AUTH_SECRET` | Oturum çerezini imzalar. Parolandan **farklı**, 32+ karakter. |
| `VAULT_ENCRYPTION_SECRET` | Kasa şifreleme anahtarı. Diğer ikisinden farklı, 32+. |
| `CONVEX_URL` | Adım 1'deki dağıtım URL'si. |
| `VAULT_ACCESS_SECRET` | Convex'e girdiğinle **aynı** değer. |
| `CRON_SECRET` | Convex'e girdiğinle **aynı** değer. |
| `APP_URL` | Vercel adresin, sonunda `/` olmadan. |
| `TRUST_PROXY_IP_HEADERS` | `0` bırak. |
| `ENABLE_LOCAL_CONNECT` | **Girme.** Uzak sunucuda asla açılmaz. |

Üç sırrı da ayrı ayrı üret, birini diğerine kopyalama — uygulama bağımsız
olmalarını kontrol ediyor ve aynı olurlarsa açılmıyor.

## 3. Convex'e APP_URL'i gir

Vercel adresi belli olunca adım 1'e dön ve `APP_URL`i yaz. Cron bu adresi
çağırıyor; boşsa bildirim döngüsü hiç çalışmaz.

## 4. Telegram (iPhone bildiriminin asıl yolu)

1. Telegram'da **@BotFather** → `/newbot` → bot adı ver → **token**ı al
2. Yeni bota bir mesaj at (bot sana ilk mesajı atamaz, önce sen yazmalısın)
3. `https://api.telegram.org/bot<TOKEN>/getUpdates` aç → `chat.id`yi al
4. Vercel'e gir:

```
TELEGRAM_BOT_TOKEN=<token>
TELEGRAM_CHAT_ID=<chat id>
```

iOS Web Push'a bağımlı kalmamanın sebebi: yalnız Ana Ekran'a eklenmiş PWA'da
çalışıyor, uygulama silinince abonelik sessizce ölüyor ve iOS arka planda teslimi
geciktirebiliyor. Telegram native push, belirgin şekilde güvenilir.

## 5. Telefonda kur

Safari ile siteye gir → **Paylaş** → **Ana Ekrana Ekle**.

Manifest hazır (`app/manifest.ts`, ikonlar `public/pwa-icon-*.png`), yani iOS
kurulum seçeneğini sunar. Web Push'u ikinci kanal olarak ekleyeceksen bildirim
iznini **kurulmuş uygulamanın içinden** vermen gerekir; Safari sekmesinden verilen
izin iOS'ta işe yaramaz.

## 6. Hesapları bağla

Siteye parolanla gir → **Hesap ekle**. Claude ve ChatGPT için özel giriş akışları
zaten var. Grok için oturum çerezi gerekiyor (ayrı iş).

## 7. Kontrol

- Convex panelinde "check usage" dakikada bir çalışıyor mu
- Bir hesabın kotasını eşiğe yaklaştırıp Telegram'a mesaj düşüyor mu
- Telefondan site açılıyor, kartlar tek kolon ve komut çubuğu görünüyor mu

---

## Sonradan dikkat

- **Vercel Hobby "kişisel, ticari olmayan kullanım"** diyor. Kendi kotanı izlemek
  kişisel sayılır; bunu bilerek seç.
- Site herkese açık bir adreste **tek parolayla** duruyor. Uygulamada giriş oran
  sınırı var ama tahmin edilmesi zor bir alt alan adı kullanmak iyi olur.
- 60 saniyelik yoklama Convex ücretsiz kotasının ~%50'sini kullanıyor. Hesap
  sayısı artarsa payı yeniden hesapla; 8 hesapta sağlayıcı uçlarına ayda
  ~350 bin istek gidiyor.
