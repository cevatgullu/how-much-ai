# How Much AI — Özel Vercel ve Convex Yayın Tasarımı

Tarih: 2026-08-11

Durum: Yayın yönü onaylandı; yazılı şartname son kullanıcı incelemesini bekliyor

## Amaç

How Much AI'ı terminal gerektirmeden Windows ve iPhone'dan açılabilen, parola korumalı, tek kişilik bir web/PWA olarak yayımlamak. Mevcut Vercel Pro takımından yararlanılır fakat takımın mevcut üretim projesi, alan adı, çevre değişkenleri ve çalışma verisi kesinlikle paylaşılmaz.

Seçilen topoloji:

- Next.js uygulaması: Vercel;
- şifreli kasa, dağıtık yenileme koordinasyonu, bildirim durumu ve beş dakikalık cron: Convex;
- cihaz bildirimleri: standart Web Push/VAPID;
- erişim: uygulamanın kendi zorunlu parola girişi;
- iPhone/Windows kurulumu: PWA;
- ilk sürüm adresi: Vercel'in ürettiği HTTPS adresi.

## Neden bu yaklaşım

Değerlendirilen seçenekler:

1. **Seçilen: Vercel + Convex + PWA.** Terminal olmadan erişim, kapalı uygulamada bildirim ve cihazlar arası tek şifreli kasa sağlar. Mevcut Pro takımında düşük kişisel trafik için ek Vercel kullanımının dahil kotada kalması beklenir.
2. **Windows yerel kurulum + iPhone için ayrı kanal.** Masaüstünde güçlü yerel izolasyon sağlar fakat iPhone arayüzünü ve kapalı uygulama push'unu tek üründe çözmez.
3. **Native Windows/iOS paketleri.** En derin işletim sistemi bütünleşmesini sağlar ancak iki ayrı uygulama, imzalama/mağaza süreçleri ve çok daha yüksek bakım yükü getirir.

Tek kullanıcılı, tek sayfalık ürün için web/PWA yolu en düşük operasyon yüküyle iki cihazı birlikte çözer.

## Hesap ve proje izolasyonu

Read-only denetimde Vercel CLI'ın doğru kullanıcıyla, etkin Pro takımında çalıştığı ve takımın mevcut üretim projesinin sağlıklı olduğu doğrulandı. Kişisel kullanıcı/takım kimlikleri sürüm kontrolündeki bu belgede tutulmaz.

Yeni kaynaklar:

- ayrı Vercel projesi: `how-much-ai-private`;
- tercihen tek üyeli yeni bir kişisel Convex takımında ayrı proje/deployment: `how-much-ai-private`;
- ayrı VAPID anahtar çifti;
- her güvenlik rolü için ayrı rastgele secret;
- yeni, boş şifreli kasa.

Kesinlikle yapılmayacaklar:

- mevcut üretim projesinin çevre değişkenlerini kopyalamak veya yeniden kullanmak;
- mevcut üretim alan adını değiştirmek ya da aynı projeye yeni uygulama eklemek;
- mevcut projenin build/deploy ayarlarını değiştirmek;
- yerel `.data` veya `.env*` dosyalarını okumak, kopyalamak ya da deploy paketine koymak;
- bir projenin Convex erişim secret'ını diğerinde kullanmak.

Ayrı Vercel projesi domain, deployment, ayar ve environment namespace'ini ayırır; aynı takımın Owner/Member gibi tüm-proje yetkililerine karşı güvenlik sınırı değildir. Aynı şekilde Convex Team Admin bütün projelerde örtük Project Admin'dir ve takım rolleri üretim verisi/environment görünürlüğü sağlayabilir. Bu kurulumun güven modeli, bu rollerdeki herkesin güvenilir olmasıdır.

Dış kaynak oluşturulmadan önce iki platformun üye/rol listesi read-only denetlenir. Mevcut Vercel Pro takımı yalnız kullanıcı projeye deploy edebilen veya environment yönetebilen tek üyeyse ya da bu yetkilere sahip diğer bütün roller açıkça güvenilir kabul ediliyorsa kullanılır; rol adının “tam yetkili” olmaması tek başına yeterli izolasyon değildir. Bu şart sağlanmıyorsa yeni ve ayrı bir Vercel takımı maliyet etkisiyle birlikte yeniden onaya sunulur. Convex tarafında varsayılan seçim, diğer projelerden ayrı tek üyeli kişisel takımdır. Secret değerlerinin projeler arasında yeniden kullanılmaması, ayrı proje izolasyonudur; deploy/environment yetkililerinden gizlilik iddiası değildir.

Vercel projesi linklendikten sonra yerel `.vercel/project.json` içindeki yeni proje/org kimliği beklenen hedefle eşleşmeden hiçbir environment veya deploy mutasyonu yapılmaz. Her Vercel CLI çağrısı açık takım scope'u ve bu worktree'nin `--cwd` sınırıyla çalışır. Mevcut üretim projesinin domain/deployment/environment **adları** (değerleri değil) önce ve sonra karşılaştırılır.

## Tek kullanıcı ve paylaşım modeli

Bu sürüm gerçek bir tek-kiracılı kurulumdur. Bir parola ile giren herkes aynı hesapları, ayarları ve bildirim kurallarını görür.

Eş veya çok güvendiğiniz biri aynı panoyu kullanacaksa aynı parolayı paylaşmak teknik olarak mümkündür; bu ayrı bir kullanıcı hesabı yaratmaz. Arkadaşların kendi AI hesaplarını görmesi istenirse aynı deployment'a davet edilmezler. Her kişi için ayrı Vercel/Convex kurulumu ve ayrı parola/şifreli kasa oluşturulur.

İlk sürümde davet, kullanıcı tablosu, parola sıfırlama e-postası, rol veya kişi başına hesap görünürlüğü eklenmez.

## Maliyet kontratı

Mevcut Vercel Pro takımında Ağustos 2026'nın ilk on bir günlük read-only kullanım incelemesi, iki mevcut projenin kaynak tüketiminin düşük ve ölçülen ilave faturalandırmanın ihmal edilebilir olduğunu gösterdi. Bu, yeni projenin sonsuza kadar ücretsiz olacağı garantisi değildir.

Beklenen maliyet yapısı:

- **Vercel:** Pro aboneliği zaten etkin ve takımın aylık kullanım kredisi bütün projeler arasında ortaktır. Tek kullanıcı için ilave ücret `0` olabilir, fakat invocation sayısından çok function'ın açık kaldığı bellek-süre ve aktif CPU belirleyicidir.
- **Convex:** kişisel hesap sayısı ve beş dakikalık cron için Free planın yeterli olması beklenir; proje oluşturulmadan önce gerçek takım/plan/kota read-only doğrulanır. Kota bütün Convex takımındaki projelerle ortak olabilir. Ücretli yükseltme veya kullanım bazlı Starter harcaması kullanıcı onayı olmadan açılmaz.
- **Web Push:** Apple/Microsoft push aktarımı ve `web-push` kütüphanesi için ayrı hizmet aboneliği yoktur.
- **Alan adı:** ilk sürüm Vercel'in HTTPS alanını kullanır; özel alan adı maliyeti yoktur.

Beş dakikalık ritim günde 288, 30 günlük ayda yaklaşık 8.640 cron çevrimi demektir. Güncel birim invocation fiyatıyla bu çağrı sayısının kendisi yaklaşık `$0,005/ay` düzeyindedir. Ancak Dublin'de Standard 2 GB function her çevrimde ortalama 30 saniye açık kalırsa provisioned-memory karşılığı yaklaşık `$2/ay`; 240 saniye açık kalırsa yaklaşık `$16/ay` olur ve aktif CPU buna eklenir. Bunlar brüt kullanım örnekleridir; takım kredisi faturayı azaltabilir ama diğer projelerle paylaşılır.

Her çevrim tek Vercel cron-route çağrısı yapar ve en fazla etkin hesap sayısı kadar sağlayıcı okuması dener; mevcut paylaşılan cache/tek-uçuş koordinasyonu aynı hesabın okumalarının üst üste binmesini engeller. Uygulama tarafında en çok dört hesaplık sınırlı paralellik, hesap başına sağlayıcı deadline'ı, 50 saniyelik toplam iş bütçesi ve 60 saniyelik route `maxDuration` kontratı kullanılır; Convex istemci timeout'u sunucu bütçesinden biraz uzun fakat 240 saniyeden çok daha kısa olur. Push çağrısı yalnız gerçek olay varsa yapılır.

Tekrarlanabilir fixture/load testinde 12 hesap için cron p50/p95/p99 süresi, memory sınıfı, active CPU ve kısmi timeout davranışı ölçülür. Hedef p95 `<30 saniye`, p99 `<50 saniye` ve deadline aşımında kontrollü kısmi sonuçtur. Preview'da yedi gerçek hesapla üç ardışık çevrim bu bütçeyi doğrular. Production'ın ilk 24 saatinde 288 doğal örnekten ampirik p95/p99 hesaplanır; hedef aşılırsa cron bakım moduna alınır ve maliyet nedeni çözülmeden devam etmez.

Yayın sonrası Vercel ve Convex kullanım ekranları 24 saat, 7 gün ve 30 gün noktalarında kontrol edilir. Beklenmeyen maliyet artışı varsa önce cron süresi, provider çağrı sayısı ve cache davranışı incelenir; otomatik ücretli plan yükseltmesi yapılmaz. Vercel Spend Management takım çapında olduğundan diğer üretim projesini durdurabilecek hard pause açılmaz; yalnız yumuşak harcama uyarısı kullanılır. Convex deployment için mevcut planın desteklediği warning/disable limitleri yapılandırılır ve limit davranışı gerçek cron hatası olarak panelde görünür.

## Bölge, locale ve gecikme

Türkçe locale yalnızca metin, sayı ve zaman sunumunu etkiler; kota karşılaştırmaları ISO/UTC üzerinden yapılır. Client sunumu açıkça `Intl.DateTimeFormat("tr-TR", { timeZone: cihazSaatDilimi })` kullanır ve `<html lang="tr">` olur; server render Vercel'in ambient timezone'una güvenmez. Cron UTC çalışır, dolayısıyla Türkiye saat dilimi veya yaz saati değişiklikleri beş dakikalık ritmi bozmaz. Kabul testleri UTC gece yarısı, `Europe/Istanbul` ve DST kullanan ikinci bir cihaz saat dilimini kapsar.

Tek kullanıcı için Vercel ile Convex arasındaki ek ağ gecikmesi pano kullanımını anlamlı ölçüde etkilememelidir; en büyük gecikme zaten sağlayıcı cache'i ve beş dakikalık kontrol aralığıdır. Buna karşılık veriler seçilen bulut hizmetlerinin bölgelerinde işlenir/saklanır ve Türkiye dışında bulunabilir. Şifreli kasa içeriği Convex'e uygulama tarafından şifrelenmiş gider; hizmetler yine bağlantı zamanı, IP ve şifreli payload boyutu gibi operasyonel metadata görebilir.

Bulut sürümündeki sağlayıcı istekleri ev bilgisayarının Türkiye IP'sinden değil Vercel veri merkezi çıkışından gider. Sağlayıcıların resmi olmayan/değişebilen kullanım uçları bu çıkışı farklı önbelleğe alabilir, oran sınırlayabilir veya ileride reddedebilir. Bu bir Türkçe locale sorunu değil, barındırma bölgesi/sağlayıcı politikası riskidir; gerçek Claude ve OpenAI hesaplarıyla Preview smoke testi Production için zorunlu kapıdır. Böyle bir engel çıkarsa sessizce daha pahalı bölgeye geçilmez; yerel poller veya sağlayıcının desteklediği yeni bir entegrasyon ayrı tasarım olarak değerlendirilir.

Convex deployment bölgesi proje oluşturulurken değiştirilemez biçimde seçildiği için karar ertelenmez: **EU West (Ireland)** seçilir ve Vercel Node Functions aynı coğrafyadaki **`dub1` (Dublin)** bölgesine sabitlenir. Bu, Türkiye'ye US East'ten daha yakın veri yerleşimi ve düşük Vercel–Convex gecikmesi sağlar; Dublin Vercel fiyatı yukarıdaki örnekte kullanılır, Convex EU kaynak çarpanı ise plan/kota doğrulamasında ayrıca hesaba katılır. Web sayfasının statik/edge sunumu küresel kalabilir, fakat kasa/cron Node çalışması tek `dub1` bölgesidir.

Türkiye içi barındırma sağlanmaz. İleride yasal/kurumsal veri yerleşimi gereksinimi doğarsa yeni bölgede yeni deployment ve kontrollü export/import gerekir; mevcut Convex deployment yerinde başka bölgeye taşınamaz.

## Güvenlik ve çevre değişkenleri

Üretimde uygulama şu üç bağımsız değeri zorunlu tutar; her biri kırpıldıktan sonra en az 32 karakterdir ve birbirine eşit olamaz:

- `APP_PASSWORD` — kullanıcının giriş parolası;
- `AUTH_SECRET` — oturum çerezi imzası;
- `VAULT_ENCRYPTION_SECRET` — sağlayıcı kimlik bilgilerinin uygulama katmanı şifrelemesi.

Diğer secret'lar da bu üçlüden ve birbirinden bağımsızdır.

### Vercel Production ortamı

| Değişken | Rol |
| --- | --- |
| `APP_PASSWORD` | Zorunlu insan girişi; kullanıcı güvenli kanaldan belirler |
| `AUTH_SECRET` | Oturum imzası |
| `VAULT_ENCRYPTION_SECRET` | Kasa şifrelemesi |
| `CONVEX_URL` | Üretim Convex deployment URL'si |
| `NEXT_PUBLIC_CONVEX_URL` | Build'in sabitlediği aynı public deployment URL'si |
| `CONVEX_DEPLOY_KEY` | Yalnız Production'a scoped, `deployment:deploy` yetkili CI anahtarı |
| `VAULT_ACCESS_SECRET` | Uygulama–Convex yetkilendirmesi |
| `APP_URL` | Tam Vercel üretim origin'i, sonda `/` yok |
| `CRON_SECRET` | Convex cron–uygulama ortak sırrı |
| `VAPID_PUBLIC` | Tarayıcıya verilebilen public key |
| `VAPID_PRIVATE` | Yalnızca sunucu private key'i |
| `VAPID_SUBJECT` | Operatöre ait `mailto:` iletişim URI'si |
| `ENABLE_LOCAL_CONNECT=0` | Uzak sunucuda yerel CLI okumasını kesin kapatır |

Production'da `CONVEX_URL` açıkça sabitlenir; `NEXT_PUBLIC_CONVEX_URL` aynı public URL'dir. Preview'da branch başına Convex deployment URL'si build sırasında `NEXT_PUBLIC_CONVEX_URL` olarak enjekte edilir. URL secret değildir; `VAULT_ACCESS_SECRET` ve deploy key secrettır. Deploy edilmiş Node Function'ın gerçekten beklenen Preview backend'ine ulaştığı, URL'yi açıklamayan bir backend fingerprint/health çağrısıyla ispatlanır; bu kanıt olmadan branch-başına preview modeli kabul edilmez.

`TRUST_PROXY_IP_HEADERS` varsayılan kapalı kalır. Vercel çalışma ortamının mevcut güvenli platform algısı yeterli değilse ancak kesin proxy zinciri ve testleri doğrulandıktan sonra açılır; körlemesine `1` yapılmaz.

### Convex Production ortamı

| Değişken | Rol |
| --- | --- |
| `VAULT_ACCESS_SECRET` | Vercel'deki değerle aynı backend erişim sırrı |
| `APP_URL` | Cron'un çağıracağı Vercel origin'i |
| `CRON_SECRET` | Vercel'deki değerle aynı cron sırrı |
| `NOTIFY_PAUSED=0` | Bakım sırasında `1`; dış cron fetch'ini durdurur ve panelde `bakım` gösterir |

VAPID private key Convex'e konmaz; push gönderimi Next.js sunucu yolunda gerçekleşir. `VAULT_ENCRYPTION_SECRET` de Convex'e verilmez; şifreleme Vercel uygulama katmanında yapılır.

### Convex–Vercel build kontratı

Vercel Build Command resmi birleşik akışı kullanır:

```text
npx convex deploy --cmd-url-env-var-name NEXT_PUBLIC_CONVEX_URL --cmd 'npm run build'
```

- Vercel Preview environment'ında yalnız Preview deploy key bulunur ve sabit release branch adıyla izole Convex Preview backend'i oluşturur/yeniden kullanır.
- Vercel Production environment'ında yalnız Production deploy key bulunur; anahtar en az yetki olarak sadece `deployment:deploy` taşır.
- Preview/Production deploy key'leri farklı, proje düzeyinde ve Sensitive'dir; team-shared değildir.
- Deploy key işten çıkarma, sızıntı veya pipeline değişiminde açıkça revoke edilir; rol değişikliği tek başına anahtarı iptal etmiş sayılmaz.
- Preview deployment yaratılmadan önce Convex project defaults içinde Preview'a özgü `VAULT_ACCESS_SECRET`, `CRON_SECRET` ve sabit preview `APP_URL` hazırlanır. Defaults yalnız yeni deployment'a kopyalandığından sonraki değişiklikte mevcut Preview backend açıkça güncellenir veya güvenle yeniden oluşturulur.
- Build, Convex typecheck/codegen/schema/function deploy ve Next production build adımlarından biri başarısızsa Vercel deployment'ı yayımlamaz.

Authenticated health cevabı yalnız Git SHA, storage türü, beklenen backend fingerprint'inin kısa özeti ve bildirim yapılandırma boolean'larını verir; URL, secret, endpoint, hesap veya environment değeri vermez.

### Secret oluşturma ve aktarım

- Rastgele makine secret'ları kriptografik üreticiyle oluşturulur; terminal çıktısına veya sohbet mesajına basılmaz.
- `APP_PASSWORD` kullanıcı tarafından seçilir/güvenli biçimde girilir; repoya veya dokümana yazılmaz.
- Vercel/Convex ortamına değerler etkileşimli/gizli girişle eklenir; shell history'ye düz metin düşürülmez.
- Preview ve Production en azından kasa/oturum/backend/cron secret'larında farklı değerler kullanır.
- `.env*`, `.data`, deploy logu ve build çıktısı secret taramasından geçer.

`APP_PASSWORD`, `AUTH_SECRET`, `VAULT_ENCRYPTION_SECRET`, `VAULT_ACCESS_SECRET`, `CRON_SECRET`, `VAPID_PRIVATE` ve Preview/Production `CONVEX_DEPLOY_KEY` değerleri Vercel'de **proje düzeyinde Sensitive** olarak saklanır; takım-shared olmaz. `APP_URL`, `CONVEX_URL`, `NEXT_PUBLIC_CONVEX_URL`, `VAPID_PUBLIC` ve `VAPID_SUBJECT` public yapılandırmadır fakat yine yalnız bu projeye aittir. Preview değerleri yalnız release branch Preview environment'ına, Production değerleri yalnız Production'a scoped olur; iki ortamın `APP_PASSWORD` değerleri de kesinlikle farklıdır.

E-posta tabanlı parola sıfırlama yoktur. `APP_PASSWORD` unutulursa Vercel ortamında yeni değer atanır; bağımsız `VAULT_ENCRYPTION_SECRET` korunduğu için kasa yeniden şifrelenmeden okunmaya devam eder. Yalnız parola değişimi mevcut oturum çerezlerini mutlaka iptal etmez; kayıp/ele geçirilmiş cihaz olayında `APP_PASSWORD` ile birlikte `AUTH_SECRET` de rotate edilir.

Ortak `VAULT_ACCESS_SECRET` veya `CRON_SECRET` rotasyonu iki platformda koordineli bakım penceresidir: bildirim cron'u duraklatılır, Convex ve Vercel değerleri kontrollü sırayla değiştirilir, güncel env ile yeni staged deployment build edilir, health testi geçer ve cron yeniden açılır. Kısa aralık fail-closed olabilir; eski ve yeni secret'ı uzun süre birlikte kabul eden gizli grace yolu eklenmez. `APP_PASSWORD` dahil herhangi bir runtime secret rotasyonu yeni Vercel build gerektirir. Vercel env değişiklikleri eski deployment byte/config snapshot'ına uygulanmadığından önceki env sürümündeki deployment'lar instant-rollback için uygunsuz işaretlenir.

## Veri başlangıcı ve hesap bağlama

Üretim kasası boş başlar. Yerel kurulumun `.data` dosyası, auth dosyası veya provider token'ı taşınmaz. Bunun nedenleri:

- eski encryption key'e ve makineye bağımlı veriyi buluta kopyalamamak;
- yanlış hesabı veya dönen refresh token'ı tüketmemek;
- deploy paketine yerel secret sızdırmamak.

Hesaplar üretim PWA'sında desteklenen özel giriş/pairing akışlarıyla yeniden bağlanır. OpenAI için mevcut özel device login, Claude için mevcut özel app sign-in veya güvenli Convex pairing kullanılır. Ham token sohbet, kaynak kodu veya Vercel loguna yapıştırılmaz.

## Yayın aşamaları

### 0. Kod ve tasarım kapısı

- üç yazılı şartname onaylanır;
- her şartname için TDD uygulama planı yazılır;
- değişiklikler izolasyonlu feature branch/worktree'de uygulanır;
- hiçbir dış proje bu kapı tamamlanmadan oluşturulmaz.

### 1. Yerel doğrulama

Zorunlu sıra:

1. odaklı birim/bileşen testleri;
2. `npm test`;
3. `npm run typecheck`;
4. `npm run build`;
5. secret/vault trace ve production bundle kontrolleri;
6. responsive, erişilebilirlik ve service-worker testleri.

Mevcut başlangıç testinde çalışan eski yerel uygulama `127.0.0.1:37645` portunu tuttuğu için üç runtime-immutability testi `service-port-in-use` ile başarısız olmuştur; 735/738 test geçmiştir. Final tam doğrulamada kullanıcı oturumu korunarak eski runtime kontrollü biçimde durdurulur ve bu üç test yeniden çalıştırılır. Bu çevresel çakışma çözülmeden “tam yeşil” denmez.

### 2. Ayrı Preview altyapısı

- rol denetimi geçtikten sonra `how-much-ai-private` Vercel projesi beklenen Pro takımında oluşturulur ve project/org ID guard'ı sabitlenir;
- yeni tek-üyeli Convex takımında EU West `how-much-ai-private` projesi oluşturulur;
- release branch için Preview deploy key Vercel'in yalnız Preview/release-branch ortamına Sensitive olarak eklenir;
- Preview Convex defaults ve Vercel Preview ortamına birbirinden/Production'dan bağımsız secret'lar eklenir;
- deployment değişse de aynı kalan, yalnız bu proje için bir Vercel preview alias'ı ayrılır;
- Preview Convex ve Vercel `APP_URL` değerleri tam bu sabit HTTPS origin'ine ayarlanır;
- Vercel Authentication/Standard Protection Preview'da kapalıdır; gerçek iPhone PWA, public manifest/service worker ve Convex cron yalnız uygulamanın kendi zorunlu parolasıyla test edilir;
- aynı release branch yeniden deploy edildiğinde aynı Convex Preview backend adı kullanılır; başka branch Preview'ları bu kabul verisini paylaşmaz.

Preview üretim verisi veya üretim secret'ı kullanmaz. Preview backend URL'sinin deploy edilmiş Node Function içinde doğru kaldığı fingerprint testi geçmezse branch-başına model terk edilir ve ayrı tasarımla tek sabit staging backend'e dönülür; yanlış backend'e sessiz fallback yapılmaz.

### 3. Preview kabulü

Gerçek cihazlarda:

- Windows 27 inç 4K, 2560 × 1440 CSS eşdeğeri ve 3840 × 2160;
- iPhone 17 Pro Max dikey/yatay;
- parola giriş/çıkış ve oturum süresi;
- hesap ekleme, yenileme, sıralama ve yeniden bağlama;
- Ana Ekran'a kurulum;
- PWA kapalıyken gerçek Web Push;
- cihaz/izleme/gönderim durumları;
- beş dakikalık cron ve gecikme metni;
- kilit ekranı gizli bildirim gövdesi;
- Vercel/Convex loglarında secret veya hesap token'ı bulunmaması.

Kabul edilen Preview kaydı Git SHA, Vercel deployment URL/ID, sabit preview alias, Convex Preview deployment adı/fingerprint'i ve test zamanını içerir; secret içermez. Production build yalnız bu exact SHA'dan yapılır.

### 4. Production

1. Production secret'ları ayrı oluşturulur; Production deploy key yalnız Production'a scoped edilir. Convex `APP_URL` ve Vercel `APP_URL` deployment-hash URL'si değil, aynı sabit proje production origin'idir.
2. İlk boş kurulumdan sonraki her yayın için Convex manuel backup alınır; mevcut Vercel production deployment ID/SHA'sı, backend fingerprint'i ve env sürümü release kaydına yazılır.
3. Exact kabul SHA'sından `vercel deploy --prod --skip-domain` ile staged Production build başlatılır. Resmî Build Command aynı SHA'nın geriye uyumlu Convex code/schema'sını deploy eder ve aynı Production env ile Next uygulamasını build eder. Mevcut production uygulaması bu backend geçişi sırasında çalışabilmelidir.
4. Değişmez staged URL'de authenticated health fingerprint, giriş, oturum, boş/okunabilir kasa ve temel API smoke testleri yapılır. Staged URL'de `APP_URL`e bağlı pairing/cron sonucu production origin'e gideceğinden tam E2E henüz çalıştırılmaz.
5. Staged deployment production'a bir kez promote edilir.
6. Sabit production domain cutover'ından sonra cron, provider yenileme, hesap bağlama, iPhone kapalı-PWA push ve Windows push E2E testleri yapılır.
7. Başarılı release kaydı yeni Vercel deployment ID/SHA, Convex deployment history/fingerprint ve env sürümünü secret olmadan içerir.
8. Provider hesapları yalnız desteklenen giriş akışlarıyla production kasasına yeniden bağlanır; Preview kasası taşınmaz.

## Rollback ve kurtarma

- Her release kaydı Vercel deployment ID/URL, Git SHA, backend fingerprint ve env sürümünü eşler. Daha önce production olmuş sürüme geri dönüş `vercel rollback <deployment-id-or-url>` ile yapılır; daha önce promoted deployment tekrar promote edilmeye çalışılmaz.
- Instant Rollback rebuild yapmaz: hedef eski deployment'ın build anındaki env/config snapshot'ı ve cron tanımı geri gelir, fakat Convex backend kodu/şeması geri alınmaz. Bu yüzden yalnız güncel Convex backend ile uyumlu ve aynı geçerli env sürümünü kullanan kayıt “rollback-uygun” olabilir.
- Vercel rollback sonrası production-domain auto-assignment kapanır. Hizmet doğrulandıktan sonra düzeltilmiş yeni staged deployment promote edilerek normal akış yeniden açılır.
- Her `APP_PASSWORD`, `AUTH_SECRET`, `VAULT_ACCESS_SECRET`, `CRON_SECRET`, `VAPID_PRIVATE` veya encryption-key rotasyonundan önceki deployment'lar rollback-uygunsuz işaretlenir. Geri dönüş gerekirse bilinen iyi Git SHA **güncel** secret'larla yeniden build edilip staged olarak doğrulanır.
- Convex schema/function değişiklikleri bir önceki uygulamayla geriye uyumlu ve eklemeli olmak zorundadır; veri silen migration yoktur. Uyum ispatlanamıyorsa staged production build başlatılmaz.
- İlk boş yayın hariç her Production backend değişikliğinden önce manuel Convex backup alınır. Backup'ın tablo/dosya verisini içerdiği; kod, environment ve scheduled function tanımını içermediği release kaydında belirtilir. Platformun mevcut yedi günlük manuel-backup saklama süresi kayda yazılır ve bu pencere dolmadan restore seçeneği doğrulanır.
- `VAULT_ENCRYPTION_SECRET` backup'tan ayrı, kullanıcının parola yöneticisinde saklanır. Bu değer yoksa encrypted vault backup tek başına kullanılamaz. Kasa okunamıyorsa veri sessizce sıfırlanmaz; doğru secret geri yüklenir veya hesaplar kontrollü biçimde yeniden bağlanır.
- VAPID key'i değişirse eski cihaz abonelikleri uyumsuz olarak tanınır ve kullanıcı açık onarma akışıyla yeniden abone olur.

## Operasyon ve gözlemlenebilirlik

İlk 30 gün için kontrol noktaları:

- Vercel function çağrısı, cron p50/p95/p99 süresi, provisioned memory, active CPU, bant genişliği ve hata oranı;
- Convex function/database/bandwidth/cron kullanımı;
- cron'un son başarılı/kısmi/başarısız zamanı;
- provider bazında hata sınıfı, hassas olmayan sayı olarak;
- geçersiz push aboneliği temizleme oranı;
- bildirim testinin cihaz başına oran sınırı.

Her release/rotasyon kaydı deploy key'lerin geçerli kapsamını ve eski anahtarın revoke edilip edilmediğini de kontrol eder. Release kayıtları secret değil operasyonel kimlik taşır ve repoya kişisel takım/kullanıcı adı yazmaz.

Analitik SDK veya kullanıcı davranışı izleme eklenmez. Gerekli sağlık bilgisi uygulama/Convex operasyon kayıtlarından ve bildirim panelindeki asgari durumdan gelir. E-posta, token, push endpoint'i ve ham provider yanıtı loglanmaz.

## Test ve kabul kapıları

Yayın ancak şu koşullar birlikte sağlanırsa tamamlanmış sayılır:

- repository test, typecheck ve production build tamamen yeşil;
- eski runtime kapatıldıktan sonra üç immutability testi geçiyor;
- Vercel build local dosya backend'ine düşmüyor ve tam Convex yapılandırmasıyla açılıyor;
- Preview ve Production'ın farklı Sensitive deploy key kullandığı, Preview key'in yalnız branch preview ve Production key'in yalnız `deployment:deploy` yetkisi taşıdığı;
- accepted Preview ile staged Production build'in aynı exact Git SHA'dan geldiği ve health fingerprint'in doğru backend'i doğruladığı;
- eksik/yarım Convex yapılandırması fail-closed;
- `APP_PASSWORD` olmadan hiçbir geliştirme/üretim modu açık erişime geçmiyor;
- üç ana secret'ın bağımsızlık ve uzunluk kontrolleri geçiyor;
- `ENABLE_LOCAL_CONNECT=0` altında uzak sunucu yerel CLI credential okumuyor;
- PWA manifest/icon yolları login redirect'i almıyor, diğer özel yollar alıyor;
- cron yalnız doğru secret ile çalışıyor ve beş dakikalık schedule deploy edilmiş;
- cron route'un `dub1`, 2 GB Standard, 60 saniye azami süre ve eşlenmiş daha kısa iç deadline'larla p95/p99 bütçesini karşıladığı;
- `tr-TR`/ISO UTC kontratının Istanbul, UTC gece yarısı ve DST kullanan ikinci saat diliminde aynı anı doğru gösterdiği;
- gerçek iPhone kapalı-PWA push testi ve Windows push testi geçiyor;
- Vercel/Convex usage ekranında beklenmeyen ücretli kaynak veya otomatik plan yükseltmesi yok;
- Vercel/Convex rol denetimi güven modelini karşılıyor, projeler EU West/`dub1` kararına uyuyor;
- yeni linkin exact project/org ID'si doğrulanmış ve takımın mevcut üretim projesinin ayarı, deployment'ı, domain'i ve environment **adları** değişmemiş;
- rollback runbook'u rollback-uygun ve secret-rotasyonu sonrası uygunsuz fixture'larla doğrulanmış.

## Başarı ölçütü

Kullanıcı Windows veya iPhone'da terminal açmadan Vercel HTTPS adresine gider, zorunlu parola ile giriş yapar, PWA'yı kurar ve uygulama kapalıyken kullanım uyarısı alır. Sistem mevcut Vercel Pro faturalama kapsamından yararlanırken takımın diğer üretim projesinden ayrı proje/config namespace'inde kalır; yetkili takım üyeleri açık güven modeline dahildir. Normal kişisel kullanımda ilave maliyet ölçülmüş süre bütçeleriyle düşük tutulur ve gerçek kullanım panellerinden izlenir.
