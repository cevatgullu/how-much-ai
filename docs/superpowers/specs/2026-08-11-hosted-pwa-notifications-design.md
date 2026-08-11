# How Much AI — Özel PWA ve Arka Plan Bildirimleri Tasarımı

Tarih: 2026-08-11

Durum: Mimari yön onaylandı; yazılı şartname son kullanıcı incelemesini bekliyor

## Amaç

How Much AI'ı iPhone 17 Pro Max ve Windows'ta kurulabilir bir web uygulamasına dönüştürmek ve sayfa, tarayıcı veya PWA kapalıyken bile kullanım uyarılarını Web Push ile ulaştırmak.

Kritik ürün sözü şudur:

> Tüm cihazlar için sunucu izlemesi açıkken kullanım 5 dakikada bir kontrol edilir. Sağlayıcı önbelleği, ağ koşulları ve sistem ayarları nedeniyle bildirim birkaç dakika gecikebilir.

“Gerçek zamanlı”, “kesin teslim edildi” veya işletim sisteminin Odak/Rahatsız Etme ayarlarını aşan bir garanti verilmez.

## Kapsam ve bilinçli dışarıda bırakılanlar

Bu sürüm:

- tek kiracılı ve parola korumalıdır;
- iPhone'da Ana Ekran'a eklenen PWA üzerinden push alır;
- Windows'ta Edge/Chrome kurulumu ve normal web push'u destekler;
- mevcut Convex zamanlayıcısını, şifreli kasayı ve Web Push kanalını geliştirir;
- cihaz, sunucu izleme ve gönderim durumlarını ayrı ayrı gösterir.

Bu sürümde şunlar yoktur:

- çok kullanıcılı davet/rol sistemi;
- uygulama sayfası veya API yanıtlarını çevrimdışı önbellekleme;
- App Store ya da Microsoft Store paketi;
- SMS, e-posta veya ücretli üçüncü taraf bildirim hizmeti;
- özel iOS açılış görseli matrisi;
- işletim sistemi bildirim geçmişini uygulama içinde taklit eden bir gelen kutusu;
- sekme görünürlüğüne bağlı sunucu izlemesi.

Mevcut Windows strict-local bildirim yolu davranış uyumluluğunu korur: Convex/VAPID kullanmaz ve yalnız yerel uygulama açık veya küçültülmüşken çalışır. Bu şartnamedeki kapalı-uygulama sözü yalnız parola korumalı hosted/Convex topolojisine aittir.

## Çalışma mimarisi

Bildirim yolu, ön plandaki React yenilemesinden bağımsızdır:

1. Convex cron beş dakikada bir çalışır.
2. Cron, paylaşılan `CRON_SECRET` ile Vercel'deki `/api/cron/check` yolunu çağırır.
3. Sunucu, şifreli Convex kasasındaki hesapları okur ve geçerli access token'larla tek-uçuşlu kullanım koordinasyonu üzerinden sağlayıcı verisini okur.
4. Saf algılayıcı, önceki pencere durumu ile yeni taze okumayı karşılaştırır.
5. Oluşan gerçek geçişler, kayıtlı Web Push aboneliklerine VAPID ile standart Declarative Web Push zarfında gönderilir.
6. iOS/iPadOS 18.4+ zarfı JavaScript olmadan görünür fallback olarak gösterebilir; kayıtlı service worker aynı zarfı eski Safari/Edge/Chrome için doğrulayıp programatik bildirime dönüştürür. Apple/Microsoft push altyapısı PWA veya tarayıcı penceresi kapalı olsa da teslim yolunu işletir.

Monitor UTC ayda en fazla 9.000 planlı çevrimi atomik olarak kabul eder; yalnız unique ve en fazla 12 dakika gecikmiş deterministik beş-dakika `scheduledTime` kovası çalışabildiğinden herhangi 31×24 saatte doğal üst sınır 8.928'dir. Vercel route'u 15 saniyede sert kapanır. Ortak monotonic deadline provider usage/profile ve push dış I/O'sunu keser ve son 1,5 saniyeyi durable event journal + final commit'e ayırır. Normal çevrim batch-read/batch-commit ile en fazla 12, provider olayı/push-cleanup yolu en fazla 20 Convex function call kullanır; action, bütün iç `run*`/route dönüş çağrıları ve tek idempotent app retry bu sayıya dahildir. Bütçe, replay veya kota koruması devreye girerse bu durum normal sağlık/kesinti durumundan ayrı saklanır ve panelde açıkça gösterilir.

Monitor rotating veya tek-kullanımlık refresh credential'ı hiçbir zaman kullanmaz. Bilinen expiry'ye en fazla 20 dakika kalması veya 401, credential-generation'a bağlı tek bir `renewal_pending` DB queue satırı açar; beş-dakikalık cadence normalde işi expiry'den 15–20 dakika önce alır ve aynı çevrimde provider retry yoktur. Ayrı `/api/cron/renew` route'u 80 saniyelik Vercel sınırı ve 90 saniyelik Convex action sınırıyla çalışır. Semaphore bekleyen çok action yerine DB queue + iki slotlu önceden rezerve edilmiş dispatcher kullanılır; aynı lineage iki slota giremez.

Queue-admission/fallback mutation'ı her boş slot için monotonik `slotEpoch`, `dispatchId`, `dispatchReservedAt`, `scheduledAt` ve `runAfter(0)` dönüşü `scheduledFunctionId`yi kota rezerviyle atomik yazar. Handler'ın ilk durable mutation'ı request-metadata ID'si dahil exact `(slotId, slotEpoch, dispatchId, scheduledFunctionId, reconcileFunctionId=null)` CAS'ini yapar; `actionStartedAt`ı yazar, checkpoint'i gerçek `actionStartedAt+95s` zamanına planlar ve `reconcileFunctionId`yi bağlar. Commit/CAS yoksa provider/Vercel I/O ve başka `ctx.run*` yoktur. Checkpoint kendi request-metadata ID'si dahil bütün tuple'ı tekrar CAS eder; stale checkpoint/fallback sıfır write/schedule ile çıkar. Action finalization'ı ardıl planlamaz.

`reconcileFunctionId` varsa fallback checkpoint sistem durumunu da doğrular: pending/kanıtsız checkpoint varken handoff=0; 12 dakikadan eski checkpoint önce yalnız cancel-request alır ve scheduled mutation terminal `Success/Failed/Canceled` olmadan slot ilerlemez. Reconcile ID hiç oluşmadıysa yalnız kanıtlı action fail-before-start yolu kullanılabilir. Böylece fallback sonrası eski checkpoint ikinci handoff yapamaz.

Checkpoint/fallback yalnız sistem `Success/Failed` durumunda normal handoff yapar. Genel `Canceled` yeterli değildir. Stale `Pending` cancel mutation'ı exact tuple ile `actionStartedAt/attempt_started` yokluğunu doğrulayıp aynı transaction'da `canceled_before_start` fence'i ve `scheduler.cancel` yazar. Action-start CAS önce kazanırsa cancel retry iptal etmez; cancel önce kazanırsa geç handler ilk CAS'te dış I/O'suz çıkar. Ardıl ancak sonraki reconciliation cancel-fence + null start + false attempt + system `Canceled` dörtlüsünü kanıtlarsa açılır; diğer canceled/pending/in-progress/unreadable durumlar fail-closed kalır. Aynı dispatch için action≤1 ve Vercel invocation≤1; aynı generation provider POST≤1'dir. Yalnız imzalı `attempt_started=false, providerPostCount=0` preflight yeni kotalı dispatch açabilir; ambiguity açamaz.

Sağlıklı kabul zarfında action ve checkpoint scheduler lag'leri ayrı ayrı≤5 saniyedir. İki lane'in 12-job burst'ünde son başlangıç `<9 dakika`, son terminal/oldest-queue-age `<10 dakika 30 saniye`; normal scheduled execution≤5, iki cancel-race handler'ı kısa süre yaşarsa≤7 fakat provider/Vercel dış-I/O concurrency≤2'dir. Lag kapısı aşılırsa bu SLO geçersiz olur ve panel açık gecikme gösterir. Hem UTC ayda hem exact kayan 31×24 saatte global 1.200, lineage başına 100 dispatch kabul edilir. 460 dakikalık asgari başarılı aralık hard olarak `98/lineage`, 12 hesapta `1.176` doğal dispatch eder; reconnect/31 günlük remove→re-add tombstone bütçeyi sıfırlamaz. Dispatch başına action, checkpoint ve bütün Convex çağrıları `≤20`dir. Provider POST'u tam bir kez yapılır; replacement önce encrypted recovery journal'a, sonra main-vault CAS ile job success'in aynı atomik finalization mutation'ına yazılır. Timeout, worker kaybı, `5xx`, malformed/partial cevap, replacement token eksikliği veya journal commit belirsizliği `renewal_unknown` olur ve otomatik replay yerine yeniden bağlama ister. Son başarılı kota verisi `son veri` olarak kalır fakat bu hesap yeni eşik/reset olayı üretmez.

Credential generation sunucunun ürettiği, istemciden kabul edilmeyen, yeniden kullanılmayan opak kimliktir. İlk connect, reconnect, manual replacement, remove→re-add ve başarılı refresh finalization yeni generation üretir. Queue benzersiz `(accountId, credentialGeneration)` kullanır; stale job/journal daha yeni credential'ı overwrite veya temizleyemez. Legacy vault migration'ı ilk kontrollü okumada generation üretir ve round-trip'te korur.

Uygulama açıkken pano hesap başına polling veya doğrudan Convex browser subscription'ı yapmaz. Mevcut HttpOnly parola oturumuyla korunan tek same-origin aggregate snapshot route'u, `Panoyu canlı izle` açık ve belge görünürken en sık 60 saniyede bir çağrılır; görünür duruma dönüşte bir kez hemen yenilenir. Hidden veya kapalı cihaz periyodik snapshot isteği üretmez. Tek atomik operation aynı anda en fazla iki görünür cihaz lease'ini, aylık 100.000 toplam çağrıyı ve bunların içinde 20.000 tam cevabı korur; sınırdan sonra pano on-focus/manuel moda geçer. İstemci `knownRevision` yollar; operation önce en fazla 256 B revision özetini okur, değişmediyse kartları okumadan en fazla 256 B zarf, değiştiyse ve tam-cevap bütçesi varsa en fazla 10 KiB credential-free tam snapshot döndürür. Eski/uydurma revision tam-cevap bütçesini aşamaz. Manuel `Yenile` eylemi ayrı oran limitli taze usage snapshot okumasıdır; expiry/401'de doğrudan token refresh yapmaz, aynı generation-bound renewal kuyruğunu açar. Arka planda bu görünür pano sorgusu veya render işletim sistemi tarafından yavaşlatılsa ya da süreç tamamen kapansa bile sunucu cron'u devam eder. Bu nedenle bildirim doğruluğu `visibilitychange`, açık sekme veya cihazdaki timer'a bağlı değildir; arka planda yalnız görünür pano çizimi durabilir.

İlk başarılı okuma yalnızca durum tohumlar ve eski uyarıları topluca göndermez. Başarısız, eksik veya önbellekten eski okuma yeni bildirim geçişi üretmez.

## PWA kabuğu

### Manifest

Uygulama sabit bir manifest sunar:

```text
id: /
name: How Much AI — Özel PWA
short_name: HMA Özel
start_url: /
scope: /
display: standalone
orientation: belirtilmez
background_color: #111614
theme_color: #111614
```

Varlıklar:

- `/pwa-icon-192.png`: 192 × 192 PNG, `purpose: any`;
- `/pwa-icon-512.png`: 512 × 512 PNG, `purpose: any`;
- `/pwa-maskable-512.png`: ayrı 512 × 512 güvenli alanlı PNG, `purpose: maskable`;
- `/apple-touch-icon.png`: 180 × 180 opak Apple touch icon;
- `/notification-icon-192.png`: bildirim için PNG simge;
- `/notification-badge-96.png`: küçük boyutta okunabilen ayrı tek renk badge.

Manifest yolu `/manifest.webmanifest`tir. Yukarıdaki yedi yolun her biri, mevcut `/icon.svg` ve `/sw.js` yolları gibi public-path izin listesine ayrı kayıt olarak girer.

### Uygulama işareti

PWA ikonu **The Measure Mark** adını taşıyan sade bir ölçüm işaretidir: `#111614` mat zemin üzerinde kırık beyaz cetvel çizgileri, tek kalibrasyon mavisi imleç ve küçük Claude mercanı uç işareti. Yazı, `AI` harfi, beyin/yıldız sihri, sağlayıcı logosu, gradyan ve parıltı kullanılmaz. Maskable sürümün anlamlı geometrisi merkezdeki güvenli alanın içinde kalır; 32 px önizlemede dahi cetvel ve imleç ayrışır.

SVG uygulama ikonu yerinde kalabilir fakat iOS kurulumu ve push gösterimi yalnızca SVG'ye güvenmez.

### Metadata ve görünüm

Kök metadata/viewport kontratı:

- `width=device-width`;
- `initialScale=1`;
- `viewportFit=cover`;
- koyu renk şeması ve koyu theme color;
- Apple web app capable ve `HMA Özel` başlığı;
- Apple status bar stili `black-translucent`; `#111614` tuval ve üst güvenli alan tek kesintisiz yüzey olarak boyanır;
- `html lang="tr"`;
- arama motorları için mevcut `noindex, nofollow` korunur.

Giriş ekranı, belge başlığı ve uygulama ana başlığı tam **How Much AI — Özel PWA** adını kullanır. `HMA Özel` yalnız işletim sisteminin kısa Ana Ekran/uygulama etiketi için kullanılır; yeni ürün hiçbir kurulum yüzeyinde “V2” diye adlandırılmaz.

Manifest ve ikonların tam yolları `self-authenticating-public-paths` izin listesine **tek tek** eklenir. Geniş `/icons/*` veya `/public/*` kimlik doğrulama istisnası açılmaz. Aksi halde iOS'un oturumsuz manifest/ikon istekleri giriş sayfasına yönlenir ve kurulum sessizce bozulur.

### Service worker sınırı

İlk PWA sürümü ağ gerektirir. Service worker:

- push olayını işler;
- doğrulanmış yerel mesaj yolunu korur;
- bildirim tıklamasında aynı origin'deki mevcut pencereyi odaklar veya tam olarak `/` yolunu açar.

Service worker aşağıdakileri önbelleklemez:

- kimlik doğrulanmış sayfalar;
- API yanıtları;
- kullanım okumaları;
- şifreli kasa veya hesap metadatası;
- bildirim ayarları.

Push payload'ından gelen keyfî URL açılmaz. Bildirim verisi yalnızca aynı-origin köküne yönlendirir.

`/sw.js` oturumsuz olarak redirect olmadan `200`, JavaScript MIME türü ve `Cache-Control: no-cache`/eşdeğer zorunlu revalidation ile sunulur. Kayıt scope'u tam `/`, `updateViaCache` değeri `none`dır. Worker yalnız push/message/click sınırı taşıdığı için yeni byte'lar install aşamasında `skipWaiting`, activate aşamasında `clients.claim` ile güvenlik düzeltmesini geciktirmeden alabilir. `/manifest.webmanifest` redirect olmadan `200` ve `application/manifest+json` türündedir.

### Push zarfı

Sunucu her hosted push'u tam sürümlü Declarative Web Push biçiminde üretir:

```json
{
  "web_push": 8030,
  "notification": {
    "title": "How Much AI — Özel",
    "lang": "tr-TR",
    "dir": "ltr",
    "body": "...",
    "navigate": "https://exact-app-origin.example/",
    "tag": "hma:push:0123456789abcdef0123456789abcdef",
    "data": { "schema": 1, "kind": "warning" },
    "app_badge": "1"
  }
}
```

Kontrat:

- `title` her zaman sabittir;
- `kind` yalnız `warning`, `reset` veya `test` olabilir;
- `body` 1–240 UTF-8 byte, kontrol karaktersiz Türkçe metindir;
- `tag` tam `^hma:push:[a-f0-9]{32}$` desenindedir;
- `navigate`, yapılandırılmış `APP_URL` origin'inin tam `/` köküdür;
- `app_badge: "1"` yalnız gerçek `warning/reset` olayında bulunur; testte yoktur;
- hesap kimliği, e-posta, endpoint, keyfî URL, keyfî başlık ve ek alan kabul edilmez.

Modern WebKit bu zarfı worker çalışmasa/kaldırılmış olsa bile görünür fallback olarak kullanabilir. Eski tarayıcılarda worker aynı exact şemayı doğrular, sabit yerel ikonlarla `showNotification` çağırır ve payload `navigate` değerini uygulamak yerine kendi kesin `/` kökünü kullanır. JSON bozuk veya şema geçersizse worker push'u sessiz bırakmaz; `How Much AI — Özel` başlığı, `Yeni bir kullanım bildirimi var. Ayrıntılar için açın.` gövdesi ve sabit `hma:push:fallback` etiketiyle güvenli genel bildirim gösterir. Sunucu testleri gönderilen her payload'ın deklaratif şemaya uyduğunu garanti eder.

## iPhone etkinleştirme akışı

iPhone Web Push için güvenli bağlam, iOS/iPadOS 16.4 veya sonrası ve Ana Ekran'a kurulmuş web uygulaması gerekir. Karar yine sürüm metnine değil özellik algılamaya dayanır:

- `isSecureContext`;
- `navigator.serviceWorker`;
- `PushManager`;
- `Notification`;
- `matchMedia("(display-mode: standalone)")`;
- iOS geri dönüşü olarak `navigator.standalone`.

User-agent metninden cihaz/sürüm tahmini karar verici değildir.

Duruma göre akış:

1. Safari sekmesindeyse ana eylem `Bildirimler için Ana Ekran'a ekleyin` olur ve paylaş menüsü adımlarını gösterir. iOS 26'da kullanıcı ikonu daha önce eklemiş fakat `Open as Web App` seçeneğini kapatmışsa aynı ikon Safari sekmesi gibi açılır; yönerge kısayolu kaldırıp yeniden eklemeyi ve `Open as Web App` seçeneğini açık bırakmayı açıkça anlatır.
2. PWA olarak açıldığında panel service worker'ı kaydeder, `navigator.serviceWorker.ready` sonucunu ve VAPID anahtarını **dokunmadan önce** hazırlar. Hazırlık bitene kadar eylem `Bildirim desteği hazırlanıyor` durumunda disabled kalır.
3. Ön kontrolde eski/uyumsuz VAPID aboneliği varsa sunucu kaydı ve tarayıcı aboneliği bu hazırlık aşamasında temizlenir; yeni izin istemiyle ağ temizliği aynı tıklama zincirine konmaz.
4. Hazır olduğunda `Bu cihazda bildirimleri aç` eylemi görünür.
5. Kullanıcı dokunduğunda tıklama işleyicisi, önceden hazır `ServiceWorkerRegistration` üzerinde `registration.pushManager.subscribe(...)` çağrısını hiçbir `await`, dinamik import, fetch veya ayrı `Notification.requestPermission()` çağrısından önce doğrudan başlatır. İzin istemini bu subscription işlemi üretir ve geçici kullanıcı hareketini korur.
6. Abonelik oluşursa sonuç sunucuya kaydedilir. Sunucu kaydı başarısız olursa yeni tarayıcı aboneliği geri alınır.
7. `NotAllowedError` veya `Notification.permission === "denied"` durumunda otomatik/yinelenen istem yapılmaz; Ayarlar'dan izin verme yönergesi gösterilir.

İzin alınması ile sunucu kaydı atomik kullanıcı deneyimi oluşturur. Uyumlu mevcut abonelik varsa yeniden izin istenmez; yalnız eksik sunucu kaydı onarılır. Fiziksel iPhone kabul testi, doğrudan subscription çağrısının gerçek WebKit kullanıcı hareketi şartını karşıladığını doğrular.

## Bildirim kontrol merkezi

Başlık: `Bildirimler`

Alt başlık: `Bu cihazı ve bildirim kurallarını yönetin.`

Masaüstünde en fazla 760–800 CSS px genişliğinde iki sütunlu modal kullanılır: yaklaşık 280 px durum rayı ve kurallar alanı. Mobilde güvenli alanlı, kenardan kenara alt sayfa olur; başlık ve kaydetme alanı gerektiğinde yapışkandır.

Mobil kart sırası:

1. Bu cihaz;
2. İzleme sağlığı;
3. Bildirim kuralları;
4. Gizlilik.

Mevcut `ModalShell` odak kapanı, arka plan yalıtımı, Escape/kapatma ve odağı çağıran kontrole geri verme davranışı korunur.

## Üç ayrı doğruluk durumu

Arayüz şu üç kavramı birbirine karıştırmaz:

### 1. Bu cihaz

Tarayıcı izni ve bu tarayıcı/PWA aboneliğinin Convex'te kayıtlı olup olmadığını gösterir.

Başarılı metin: `Bu cihaz bildirimlere kayıtlı.`

Her kurulum, `crypto.getRandomValues` ile üretilmiş 16 byte/32 küçük hex karakterlik opak cihaz kimliği kullanır. Sürümlü storage anahtarı `hma.push-device.v1`dir. iOS'ta kimlik yalnız standalone PWA ilk açıldığında üretilir; Safari sekmesindeki storage'ın kurulu PWA'ya taşınacağı varsayılmaz. Windows'ta geçerli tarayıcı/PWA origin profiline aittir.

Sunucu ham kimlik yerine SHA-256 özetini abonelikle ilişkilendirir; tenant + device hash ve endpoint fingerprint için tekil indeksler kullanır. Aynı endpoint yeni bir yerel kimlikle gelirse kayıt atomik olarak yeni device hash'e döner, çift satır oluşmaz. Storage silinmesi/yeniden kurulum yeni kimlik üretir; eski endpoint bir sonraki `404/410` push yanıtında kaldırılır. Kullanıcı `Bu cihazda bildirimleri kapat` dediğinde tarayıcı aboneliği ve aynı device kaydı birlikte silinir.

Durum API'si endpoint, public key, auth key, ham/özet cihaz kimliği veya diğer cihazları döndürmez; yalnızca kimliği doğrulanmış kullanıcıya mevcut cihaz için boolean/durum verir. Abonelik endpoint'i gönderim için sunucuda saklanmak zorunda olsa da hiçbir kullanıcı arayüzüne, loga veya test cevabına yazılmaz.

### 2. İzleme

Sunucu cron'unun ve hesap taramasının sağlığını gösterir. Yalnızca “bir fonksiyon bitti” bilgisini başarı saymaz. Kalıcı sağlık kaydı en az şunları ayırır:

- son başlama;
- son tamamlanma;
- son tümüyle başarılı tarama;
- sonuç türü: tümü başarılı, kısmi, başarısız;
- denenen/başarılı/hatalı hesap sayısı;
- hassas veri içermeyen son hata sınıfı.

Durumlar:

- henüz çalışmadı;
- taze ve tümü başarılı;
- taze fakat kısmi;
- gecikmiş: son uygun çalışma 12 dakikadan eski;
- kesinti: 30 dakikadan eski;
- son çalışma başarısız;
- kullanıcı tarafından durduruldu;
- maliyet koruması nedeniyle durduruldu.

Monitor sağlığından ayrı hesap-kimlik durumları vardır:

- `renewal_pending`: `Kimlik güvenle yenileniyor · Bu hesap geçici olarak taranmadı.` Son başarılı kota değeri `son veri` olarak kalır;
- `renewal_unknown`: `Kimlik yenileme sonucu doğrulanamadı · Güvenliğiniz için otomatik tekrar yapılmadı. Hesabı yeniden bağlayın.` Otomatik provider çağrısı ve yeni limit olayı durur;
- `renewal_pending · maliyet koruması`: UTC-ay/kayan-31-gün 1.200 dispatch tavanı dolmuştur; bütçe kendiliğinden artmaz.

Bu hesap durumları bütün monitorü “kesinti” yapmaz; diğer hesaplar taranmaya ve olay üretmeye devam eder. `renewal_unknown` yalnız desteklenen yeniden bağlama akışı yeni credential generation yazdığında temizlenir; stale renewal job yeni değerin üzerine yazamaz.

Bildirim kontrol merkezinde ayrı `Tüm cihazlar için sunucu izlemesi` anahtarı bulunur ve hosted kurulum ilk tamamlandığında varsayılanı açıktır. Bu ortak ayar yerel cihaz anahtarı gibi görünmez. Kullanıcı kapatırken `Gerçek kullanım kontrolleri ve eşik/yenilenme uyarıları tüm kayıtlı cihazlarda durur.` onayı gösterilir; cihaz aboneliği ile test bildirimi yeteneği silinmez. Kasıtlı duruşta 12/30 dakika sayaçları `gecikmiş` veya `kesinti` üretmez. Yeniden açma hemen tek taze tarama başlatır, algılayıcıyı o snapshot ile yeniden tohumlar ve kapalı aralıkta kaçırılmış olabilecek olayları topluca göndermez.

Kontrol merkezi kapsamı metinle ayırır: `Bu cihazda bildirimler` yalnız açık cihazın izin/aboneliğini, `Ortak bildirim kuralları` bütün kayıtlı cihazların eşiklerini, `Tüm cihazlar için sunucu izlemesi` ise ortak provider taramasını yönetir. Ortak parolayla giren herkes son iki ayarı değiştirebilir.

### 3. Gönderim

Test veya gerçek bir push isteğinin push hizmeti tarafından kabul edilip edilmediğini gösterir. Bu, cihazda görünür teslimat garantisi değildir. Kullanıcı metni “gönderim kabul edildi” der; “teslim edildi” demez.

## Test bildirimi

Eylem: `Test bildirimi gönder`

Gövde: `Test bildirimi. Bu cihaz bildirim almaya hazır.`

İkinci eylem `Kapalı uygulama testi`dir. Convex bu cihaz için tek kullanımlık gönderimi tam 30 saniye sonrasına zamanlar; arayüz `30 saniye içinde uygulamayı kapatın` der. Böylece aynı cihaz düğmeye basıp PWA/Safari/Edge penceresini kapattıktan sonra tekrarlanabilir kabul testi yapılır.

Test:

- yalnızca geçerli cihaz kimliğine bağlı aboneliği hedefler;
- Convex'te cihaz başına oran sınırlıdır;
- gerçek limit algılayıcısının durumunu, eşik tekrar kilidini veya reset penceresini değiştirmez;
- uygulama badge'i üretmez;
- push hizmeti kabulünü raporlar, görünür teslim iddiasında bulunmaz;
- gecikmeli iş bir kez çalışır, yeniden denemede aynı test kimliğiyle çoğalmaz ve gerçek cron/algılayıcı durumuna dokunmaz.

## Bildirim kuralları

Mevcut varsayılan eşikler korunur:

- yüksek kullanım uyarısı: kullanılan oran `%90`;
- yoğun kullanım sonrası yenilenme eşiği: önceki pencere en az `%80` kullanılmış olmalı.

Her iki alan 1–100 arasında tam sayıdır ve yenilenme eşiği uyarı eşiğinden küçük olmak zorundadır. Geçersiz ilişki kaydedilmez ve iki alanla ilişkili Türkçe hata verir.

Kurallar:

- `Yüksek kullanım uyarıları` anahtarı;
- tek seçimli yenilenme davranışı:
  - `Yalnızca yoğun kullanılan limitler — önerilen` → `recovery=true`, `everyReset=false`;
  - `Tüm limitler` → `recovery=false`, `everyReset=true`;
  - `Kapalı` → ikisi de `false`.

Eski veride iki reset anahtarı da `true` ise arayüz bunu `Tüm limitler` olarak gösterir ve tek bir pencere devrinde en fazla bir reset olayı üretir. Böylece aynı olay için iki bildirim oluşmaz.

Bir okuma birkaç uyarı sınırını atlarsa en anlamlı tek olay üretilir; ilk gözlem sessizdir. Aynı reset damgası, aynı eşik ve eşzamanlı cron denemeleri kalıcı kira/idempotency ile tekrar bildirim oluşturmaz.

## Kilit ekranı gizliliği

Varsayılan mod: `Gizli — önerilen`.

Genel gövdeler:

- uyarı: `Bir kullanım limiti uyarı eşiğine ulaştı. Ayrıntılar için açın.`
- reset: `Bir kullanım limiti sıfırlandı. Ayrıntılar için açın.`

İsteğe bağlı `Ayrıntılı` mod yalnızca şu alanları kullanabilir:

- kullanıcının takma adı veya kararlı `Claude 2` / `ChatGPT 1` etiketi;
- limitin Türkçe kısa adı;
- kullanılan yüzde.

Hiçbir mod e-posta, hesap kimliği, token, push endpoint'i, ham sağlayıcı payload'ı, reset URL'si veya credential son kullanma bilgisini taşımaz. Bildirim etiketi kararlı ve opaktır; hesap adı etikette yer almaz. Payload boyutu sınırlıdır ve kontrol karakterleri reddedilir.

Takma ad bildirim için ayrıca güvenli hale getirilir: en fazla 32 Unicode karakter, kontrol/yeni satır içermez, provider e-postasına eşit değildir ve e-posta biçimine benzemez. Bu kontrollerden biri başarısızsa ayrıntılı mod dahi kararlı sağlayıcı sıra etiketine döner. Kullanıcının yanlışlıkla e-postayı “takma ad” yapması kilit ekranına PII sızdırmaz.

## Uygulama badge'i

Badging API yalnızca özellik algılanırsa kullanılır. Badge bir sayaç değildir; yalnızca görülmemiş gerçek bir limit geçişi varsa `var/yok` durumunu temsil eder.

- test bildirimi badge oluşturmaz;
- cron çalışma sayısı badge değildir;
- kullanıcı uygulamayı görünür açıp taze pano anlık görüntüsünü aldıktan sonra temizlenir;
- platform davranışı güvenilir değilse sahte bir sayaç yerine badge tamamen atlanır.

## Hata ve kurtarma davranışı

- Bildirim desteklenmiyorsa panel yine izleme sağlığını ve kuralları gösterir, cihaz bölümünde açık neden verir.
- Safari sekmesinde izin düğmesi yerine kurulum yönergesi gösterilir.
- İzin reddedildiyse tekrar prompt edilmez.
- Tarayıcı aboneliği var ama sunucu kaydı yoksa `kayıt tamamlanmadı` durumu ve onarma eylemi görünür.
- Sunucu kaydı var ama tarayıcı aboneliği yoksa eski kayıt sunucu tarafında güvenle kaldırılabilir.
- Push hizmeti `404/410` döndürürse geçersiz abonelik silinir; diğer geçici hatalar geri denenebilir kalır.
- Kısmi hesap taraması, başarılı hesapların geçerli olaylarını işleyebilir ancak panel bunu tümüyle başarılı göstermez.
- Sağlayıcı cache'i veya hata ayrıntısı bildirim gövdesine sızmaz.
- Saat kayması veya geriye giden reset damgası reset sayılmaz.
- Aylık run/call koruması tetiklenirse provider taraması yapılmaz, durum `maliyet koruması` olarak görünür ve kullanıcı bunu sıradan provider kesintisi sanmaz.
- Credential expiry/401 aynı monitor çevriminde refresh veya provider retry yapmaz; pending/unknown hesap stale veriyi korur ve olay üretmez.
- Renewal `5xx`, `429` (sağlayıcının tüketilmediğini açıkça kanıtlayan sözleşme yoksa), redirect, timeout, malformed/partial/missing replacement veya worker-crash sonucunda aynı credential ile otomatik tekrar yapmaz. Committed encrypted journal varsa watchdog yalnız atomik finalization yapar; yoksa `renewal_unknown` olur.

Cron JSON cevabı ve Convex ping logu hesap e-postası, takma ad, hesap kimliği veya ham hata gövdesi taşımaz. Yalnız opak run ID, denenen/başarılı/hatalı sayıları, kanal sonuç sayıları ve izin verilmiş hata sınıfı bulunur; Convex eylemi cevabın ilk 300 karakterini olduğu gibi loglamaz.

## Yerelleştirme ve zaman

Arayüz ve bildirim metinleri Türkçedir. Zaman damgaları depolama ve karşılaştırmada ISO/UTC kalır; kullanıcıya `tr-TR` ve cihaz saat diliminde gösterilir. Türkiye'nin saat dilimi veya cihaz bölgesi cron sıklığını etkilemez. Sağlayıcı adı ve model adı çevrilmez.

## Güvenlik sınırları

- PWA kurulumu kimlik doğrulamayı kaldırmaz; her açılış mevcut parola oturum sınırını kullanır.
- Hosted login attempt hakkı parola karşılaştırmasından **önce** Convex'te IP-HMAC + deployment-global tek atomik rezervasyonla alınır. Limit reddi veya Convex hata/timeout'unda parola karşılaştırması yapılmaz; process-local fallback yoktur. Production yalnız Vercel'in overwrite ettiği trusted forwarding IP'sini kabul eder, diğer proxy header'larını yok sayar ve ham IP saklamaz.
- Push aboneliği ve ayar API'leri parola oturumu gerektirir.
- Aggregate pano snapshot route'u aynı HttpOnly oturumu doğrular, yalnız credential-free kart projeksiyonu döndürür ve tarayıcıya `VAULT_ACCESS_SECRET` ya da doğrudan Convex query yetkisi vermez.
- Cron yolu `proxy.ts` Routing Middleware matcher'ından exact olarak çıkarılır; kendi içinde üretim-secret ortamını, query'siz exact path'i, `POST` metodunu, `APP_URL` origin/host eşleşmesini, 2 KiB gövde sınırını ve en az 32 karakterlik bağımsız `CRON_SECRET`ı fail-closed doğrular.
- VAPID özel anahtarı yalnızca Vercel sunucu ortamındadır; tarayıcıya yalnızca public key gider.
- Production `VAPID_PUBLIC`/`VAPID_PRIVATE`/gerçek `mailto:` `VAPID_SUBJECT` üçlüsünün tamamı geçerli değilse push yapılandırması fail-closed olur; `localhost`, blank veya kısmi fallback yoktur. Private key health/JSON/log yüzeyine çıkmaz.
- Convex işlevleri ayrı `VAULT_ACCESS_SECRET` ile korunur.
- Service worker kaynağı ve manifest yolları public olabilir; kullanıcı verisi içermez.
- Service worker tıklaması keyfî dış veya aynı-origin alt URL kabul etmez; yalnızca `/` açar.
- Push payload'ı kilit ekranı için asgari veridir; ayrıntılar parola korumalı uygulamada görüntülenir.

## Test ve kabul planı

### PWA ve iOS

- manifest alanları, exact public-path izin listesi ve tüm ikonların başarılı oturumsuz fetch'i;
- 192/512/maskable/180 ikon boyutu, MIME türü ve opak Apple ikonu;
- manifestin `application/manifest+json`, worker'ın JavaScript MIME + revalidation header'ı, scope `/` ve deploy sonrası yeni worker aktivasyonu;
- `viewport-fit=cover`, dinamik görünüm yüksekliği ve dört safe-area yönü;
- Safari sekmesinde kurulum yönergesi, standalone PWA'da izin düğmesi;
- iOS 26'da `Open as Web App` kapalı kısayol için yeniden kurulum yönergesi ve `black-translucent` status bar/safe-area yüzeyi;
- service worker/VAPID hazırlığının dokunmadan önce tamamlanması ve dokunma işleyicisindeki ilk asenkron işlemin doğrudan `pushManager.subscribe()` olması;
- reddedilen iznin otomatik tekrar istenmemesi;
- iPhone'da PWA kapalıyken gerçek push ve tıklamayla aynı-origin kökün açılması.

### Durum ve kurallar

- yerel izin + tarayıcı aboneliği + sunucu kaydı kombinasyonları;
- mevcut cihaz durum API'sinin endpoint/anahtar sızdırmaması;
- cihaz kimliğinin yalnız doğru profile üretilmesi, storage kaybı/yeniden kurulumda endpoint upsert'i ve kapatmada iki taraflı silme;
- tüm monitor sağlık durumları ve 12/30 dakika sınırları;
- `Tüm cihazlar için sunucu izlemesi` açık/kapalı kontrolü, kasıtlı duruşun gecikme sayılmaması ve yeniden açılışın sessiz yeniden tohumlaması;
- 9.000 UTC-ay run tavanı + unique/fresh beş-dakika `scheduledTime` ile 31×24 saatte ≤8.928 invariantı, 15 saniyelik route sınırı, ortak dış-I/O abort/journal rezervi, normal `≤12` ve olaylı `≤20` Convex call bütçesi;
- monitorün refresh POST'u yapmaması; expiry≤20 dakika/401 admission, exact doğal `98/lineage` ve `1.176/12 hesap` projeksiyonu, 1.200 UTC-ay + exact kayan-31×24-saat dispatch tavanı, action/fetch öncesi atomik `reservation + dispatch_started + slotEpoch + scheduledFunctionId`, action-start mutation'ında actual-start-bound `reconcileFunctionId + checkpoint schedule`, reservation/CAS'siz action/checkpoint/provider-I/O=0, scheduled-action execution≤dispatch reservation≤1.200, renewal action compute≤1,875 GB-saat, iki-slot dispatcher + DB queue, `≤20` Convex call, 80/90 saniye route/action sınırı ve 64 MiB non-Node action runtime;
- stale checkpoint/fallback için exact `(slotId, slotEpoch, dispatchId, scheduledFunctionId, reconcileFunctionId)` mismatch'te write/schedule=0; reconcile ID varken Pending/kanıtsız checkpoint için fallback handoff=0, checkpoint cancel-request sonrası scheduled-mutation terminal kanıtından önce handoff=0 ve fallback sonrası geç checkpoint'in ikinci handoff=0 olması; action hiç başlamadığında veya `actionStartedAt` öncesi fail/cancel olduğunda güvenli kuyruk ilerlemesi; genel `Canceled` handoff=0, yalnız atomik `canceled_before_start` fence + null start + false attempt + system Canceled kanıtında handoff; Pending→InProgress/cancel yarışının iki commit sırası ve geç handler'ın terminal dispatch CAS'inden sonra dış I/O/`ctx.run*`=0 olması; aynı lineage'ın iki slota admission=0; action/checkpoint schedule lag'lerinin ayrı ayrı≤5 saniye olduğu 12-job sağlıklı burst'te son başlangıç `<9 dakika`, son terminal/oldest-queue-age `<10 dakika 30 saniye`, normal scheduled execution≤5, çift cancel-race geçişinde≤7, provider/Vercel dış-I/O concurrency≤2 ve monitor lag `<12 dakika`; aynı dispatch için Vercel invocation≤1, aynı generation için provider POST≤1; yalnız imzalı/owner-fenced preflight `POST=0` sonucunun yeni kotalı dispatch açması ve ambiguity'nin açmaması;
- global UTC/rolling 1.199/1.200/1.201 ve iki ayrı lineage için UTC/rolling 99/100/101; reconnect/remove→re-add'in lineage bütçesini sıfırlamaması, farklı lineage'ların izolasyonu ve hepsinin global 1.200'ü paylaşması;
- renewal crash matrisi: `attempt_started`–send arası, body-sent–response arası, response–journal arası ve journal–finalization arası crash; 3xx follow=0, 5xx/429/malformed/missing replacement/timeout, t>5 yeni POST=0, provider abort≤70, route response<80, action cleanup<90, reconnect/version yarışında newer credential overwrite=0 ve aynı generation için ikinci POST=0;
- committed encrypted journalın watchdog tarafından POST'suz finalize edilmesi ve vault credential CAS + job success'in aynı transaction olması;
- görünür panonun tek oturum-korumalı toplu snapshot route'unu en sık 60 saniyede bir kullanması; tek atomik operation'ın iki canlı cihaz/100.000 aylık toplam/20.000 aylık tam-cevap, 256 B revision/unchanged ve 10 KiB full-response sınırlarını keyfî revision'a karşı koruması; doğrudan Convex browser query'si açmaması ve arka plan render'ı dursa da sunucu cron'unun sürmesi;
- kısmi taramanın başarı gibi gösterilmemesi;
- üç reset radyo seçeneğinin eski boolean'lara doğru eşlenmesi;
- eski `recovery=true/everyReset=true` durumunda tek olay;
- eşik doğrulama, ilk gözlem sessizliği, reset ve tekrar engelleme;
- test push'un yalnızca mevcut cihazı hedeflemesi ve algılayıcı/badge durumunu değiştirmemesi;
- 30 saniyelik kapalı-uygulama testinin durable, tek kullanımlık ve idempotent olması;
- gizli payload'da takma ad, e-posta, hesap kimliği ve limit ayrıntısı olmaması;
- ayrıntılı payload'da yalnızca izin verilen alanların bulunması.
- cron cevabı/log canary testinde e-posta, account label/id, token, endpoint, ham provider response, raw exception/cause bulunmaması; yalnız counts + opak errorId + allowlisted class/code;
- VAPID üçlüsünün blank/whitespace, invalid/non-`mailto:`, kısmi ve localhost fixture'larında Production fail-closed olması; private key'in health/JSON/logda görünmemesi;
- farklı cold instance ve spoof header'larla dağıtık login limiter; rezervasyonun parola compare'dan önce olması, Convex deny/error'da compare=0/process-local fallback=0 ve global cap doluyken yeni IP row/cardinality üretmemesi.

### Service worker ve kapalı uygulama

- uygulama açık, arka planda, Safari/Edge penceresi kapalı ve Ana Ekran PWA penceresi kapalı durumlarda cron bağımsızlığı;
- pano takibi kapalı ve uygulama kapalıyken sunucu izlemesi açıksa cron/push'un sürmesi;
- sunucu izlemesi kapalıyken tarama/gerçek push olmaması, durumun `kullanıcı tarafından durduruldu` kalması ve yeniden açılışta eski olay yağmuru oluşmaması;
- iPhone App Switcher'dan PWA penceresi kapatıldıktan sonra gecikmeli testin görünmesi; Ana Ekran'dan uygulama silinmesinin ise aboneliği kaldıran beklenen ayrı durum olması;
- service worker'ın kimlik doğrulanmış sayfa/API/cache verisi saklamaması;
- deklaratif `web_push: 8030` zarfının modern WebKit fallback'i ve klasik worker gösterimi;
- geçersiz JSON/şemada worker'ın güvenli genel görünür bildirim üretmesi, geçerli server payload'ının exact şemadan çıkmaması;
- dış URL, farklı origin ve payload URL'sinin yok sayılması;
- stabil opak tag ve `404/410` abonelik temizliği;
- test bildiriminin “push hizmeti kabul etti” semantiği.

### Erişilebilirlik

- VoiceOver ve Narrator ile cihaz/izleme/gönderim durumlarının metinsel okunması;
- 44 px hedefler, safe-area alt boşluğu, odak kapanı ve odağın geri verilmesi;
- 200% yakınlaştırma, zorlanmış renkler ve azaltılmış hareket;
- periyodik cron durumunun canlı bölge ile kullanıcıyı her beş dakikada bölmemesi.

## Başarı ölçütü

Tüm cihazlar için sunucu izlemesi açıkken kullanıcı iPhone PWA'yı veya Windows tarayıcısını kapattıktan sonra izleme çalışmaya devam eder. Gerçek bir eşik/reset geçişi, sağlayıcı ve işletim sistemi gecikmesi hariç bir sonraki beş dakikalık kontrol çevriminde push yoluna girer. Panel, cihaz kaydını, kasıtlı/maliyet-korumalı duruşu, sunucu sağlığını ve push kabulünü ayrı ve dürüst biçimde açıklar.
