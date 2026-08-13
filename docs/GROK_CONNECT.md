# Grok bağlama

Sabah yapılacak iki işten biri. Kod tarafı bitti ve testli; kalan tek şey oturumu
uygulamaya vermek.

## Neden diğerleri gibi değil

Önce doğru yol denendi: resmî xAI CLI kuruldu (`irm https://x.ai/cli/install.ps1 | iex`),
`grok login` ile OAuth kimliği alındı, `~/.grok/auth.json` okundu. Yapısı
`~/.codex/auth.json` ile birebir aynı — `key`, `refresh_token`, `expires_at`.

O token'la 2026-08-13'te ölçülen sonuçlar:

| Uç | OAuth Bearer |
|---|---|
| `/rest/subscriptions` | 200 |
| `/rest/modes` | 200 |
| `/rest/user-settings` | 200 |
| `api.x.ai/v1/models` | 200 |
| **`/rest/rate-limits`** | **403** |

403 gövdesi:

```
Action cannot be performed by OAuth2 token users. [WKE=unauthorized:oauth2-auth-forbidden]
```

Yani xAI kota okumasını OAuth token'larına **bilerek** kapatmış. Kalan sorgu
sayısını yalnız tarayıcı oturumu (`sso` çerezi) okuyabiliyor. Bu bir tercih
değil, kısıt — `lib/providers/grok.ts` başında da yazılı, ileride OAuth'a
çevirmeye kalkan aynı duvara toslar.

## Yapılacak

**Grok yalnız barındırılan sürümde bağlanır.** Strict-local mod dışarıdan kimlik
yapıştırmayı kabul etmiyor; yerel kurulumda bağlama ekranı bunu açıkça söylüyor.

1. Barındırılan siteye parolanla gir
2. **Hesap ekle** → sağlayıcı seçicisinden **Grok**
3. Başka bir sekmede grok.com aç → `F12` → **Application** → **Cookies** →
   `https://grok.com` → **`sso`** satırının **Value**'sunu kopyala
4. Bağlama ekranındaki alana yapıştır → **Grok hesabını bağla**

Alan üç biçimi de kabul eder: çıplak değer, `sso=...` çifti, ya da devtools'tan
kopyalanmış tam çerez başlığı.

## Bağlandıktan sonra ne görünür

Tier'ının verdiği her mod için ayrı bir çubuk. SuperGrok Plus'ta ölçülenler:

| Mod | Kota (2 saat) |
|---|---|
| Auto | 100 |
| Fast | 270 |
| Expert | 90 |
| **Build (Grok 4.6)** | **10** |
| Heavy | tier kapalı — karta çıkmaz |

Etiketler `Build · 3/10` biçiminde ham sayıyı taşır; 10'luk bir pencerede yüzde
tek başına bir sorguyu yuvarlayıp yutuyor.

**Sıfırlanma zamanı gösterilmez.** Pencere kayan iki saat; ne zaman döneceğini
söyleyen bir veri yok, uydurulmuyor. Yan etkisi iyi: Grok sahte "limit sıfırlandı"
bildirimi üretemiyor. Eşik uyarıları normal çalışır.

## Bilinmesi gerekenler

- **Çerez, hesabının tamamına erişim demek** — kapsamı dar bir token değil.
  Şifreli kasada duruyor ama bulut kasasına koyacaksan bunu bilerek yap.
- **Süresi dolar.** Dolduğunda kart yeniden bağlanma ister; aynı adımlarla yeni
  değeri yapıştırırsın. Yenileme token'ı yok, olamaz.
- **Doğrulanmamış risk:** grok.com'da bot koruması izi var (`x-challenge`,
  `x-signature` çerezleri). Sunucudan yapılan isteğin yalnız `sso` ile geçip
  geçmediği canlı denenmedi — çerez elde olmadığı için denenemedi. Geçmezse ek
  başlık gerekebilir; ilk bağlamada anlaşılır.

## Modlar neden sabit listede değil

`/rest/rate-limits` model adı değil **mod kimliği** kabul ediyor. Denenen ve 404
dönen adlar: `grok-4-6`, `grok-4.6`, `grok_4_6`, `grok-4-6-latest`, `grok-46`,
`grok-4-5`, `grok-4-fast`, `grok-5`, `grok-beta` ve dokuz varyant daha. Kabul
edilen anahtarlar `/rest/modes`'tan geliyor, o yüzden mod listesi her çağrıda
keşfediliyor — xAI mod eklerse kod değişmeden gelir.
