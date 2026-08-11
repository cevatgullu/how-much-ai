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

Read-only takım denetimi, Vercel Pro aboneliğinin etkin ve kullanım kredisinin iki mevcut projeyle ortak olduğunu doğruladı. Güncel çevrimde boş kredi bulunması maliyet garantisi sayılmaz; yakın geçmişte uzak build yükü krediyi tüketmiştir. Bu nedenle How Much AI bütçesi kredi hiç kalmamış gibi **brüt** hesaplanır. Kredi yalnız gerçek faturayı azaltan olası indirimdir.

Maliyet sınırları:

- **Vercel:** mevcut Pro takımı kullanılır; ayrı takım açılıp ikinci `$20/ay` taban ücret oluşturulmaz. Yeni proje Web Analytics, Speed Insights, Observability Plus, Blob, Edge Config, Workflow, AI Gateway veya ücretli Marketplace kaynağını otomatik etkinleştirmez.
- **Convex:** EU West'te, diğer projelerden ayrı tek üyeli **Free** takım/deployment zorunludur. Starter veya Professional açılmaz. Starter/Professional dahil kullanımı EU West'e uygulanmadığından ücretli plana sessiz geçiş yasaktır; Free EU kurulumu mümkün değilse kaynak oluşturma durur ve maliyet yeniden onaya sunulur.
- **Web Push:** doğrudan VAPID ile Apple/Microsoft aktarımında üçüncü taraf bildirim aboneliği yoktur.
- **Alan adı ve mağaza:** ilk sürüm Vercel'in HTTPS alanını ve doğrudan PWA kurulumunu kullanır; özel alan adı veya mağaza ücreti yoktur.

Convex scheduler beş dakikada bir tek yetkili Vercel route çağrısı yapar. Bu ritim 30 günlük ayda 8.640, 31 günlük ayda 8.928 çevrimdir. Run ID scheduler'ın UTC `scheduledTime` değerinden deterministik beş-dakika kovası olarak üretilir; benzersiz indeks aynı kovada yalnız bir planlı çalışmayı kabul eder. Gelecek kovası ve 12 dakikadan eski gecikmiş/replay kovası provider'a ulaşmaz. Kalıcı ve atomik UTC-ay sayacı ayrıca en fazla **9.000 planlı monitor çevrimini** kabul eder. Böylece takvim veya Vercel fatura dönemi sınırında iki aylık kota bir anda harcanamaz. Yinelenen run ID, replay ve 9.000 üzeri çalışma provider çağrısı yapmadan bütçe-korumalı kapanır; manuel yenileme ve test bildirimleri ayrı oran limitine sahiptir.

Monitor route'u Dublin `dub1` Standard 2 GB/1 vCPU üzerinde `maxDuration = 15 saniye` kullanır. Girişte monotonic clock ile tek mutlak deadline üretilir; provider usage/profile, token refresh/recovery ve Web Push dahil bütün dış I/O aynı birleşik `AbortSignal` ve kalan-süre bütçesini kullanır. İç iş bütçesi 13 saniyedir ve son 1,5 saniyesi durable event journal + tek toplu final commit için ayrılır; yeni dış iş 11,5 saniyelik iş kesiminden sonra başlamaz. Eski 15/30/60 saniyelik bileşen timeout'ları mutlak deadline'ı uzatamaz ve Convex→Vercel sarmalayıcısındaki 240 saniyelik bekleme kaldırılır. En çok dört hesap aynı anda işlenir, başlangıç hesabı kalıcı dönen imleçle değişir; böylece ardışık yavaş hesaplar diğerlerini aç bırakmaz. Başarılı hesaplar tek toplu commit ile saklanır, süresi dolanlar kısmi sonuç olarak bir sonraki beş dakikalık çevrimde yeniden denenir. Gerçek olay önce kararlı bir event ID/tag ile durable journal'a alınır; push tamamlanmadan bildirim geçiş durumu ilerlemez. Deadline, geçici hata veya belirsiz teslim halinde olay pending kalır ve sonraki çevrim aynı kimlikle yeniden dener; final stale-endpoint temizliği de tek batch'tir.

Güncel Dublin fiyatıyla 9.000 **yetkili planlı monitor** çevriminin Function invocation + compute tavanı, her çalışmanın 15 saniyenin tamamında 1 vCPU'yu yüzde 100 kullandığı kasıtlı kötü durum üzerinden hesaplanır:

| Kalem | Hesap | Brüt üst sınır |
| --- | --- | ---: |
| Function invocation | `9.000 × $0,0000006` | `$0,0054` |
| Provisioned memory | `9.000 × 15 sn × 2 GB / 3.600 × $0,0139` | `$1,0425` |
| Active CPU | `9.000 × 15 sn / 3.600 × $0,168` | `$6,3000` |
| **Function invocation + compute** | kredi uygulanmadan | **`$7,3479/ay`** |

Cron isteği gövde+metadata bütçesi 2 KiB, başarılı veya hatalı cevap gövdesi 4 KiB'dir; redirect ve aynı çevrimde transport retry yoktur. Planlı monitorün aylık Vercel origin/data aktarım rezervi 64 MiB ile sınırlanır. Takımın ayrılmış Edge Requests/Fast Data Transfer hakkı tamamen tükenmiş varsayılsa bile 9.000 Edge Request (`$0,0216`), 64 MiB Fast Origin Transfer (`$0,00375`) ve 64 MiB Fast Data Transfer (`$0,009375`) en fazla yaklaşık `$0,034725` ekler. Böylece tanımlı yetkili planlı monitorün kredi öncesi Vercel liste-fiyatı üst sınırı **`$7,382625/ay`**, yuvarlanmış operasyon bütçesi **`$7,39/ay`** olur.

Bu hesap her yetkili cron isteğinin tam **bir** Node Function invocation üretmesine bağlıdır. Next.js 16 `proxy.ts` matcher'ı exact `/api/cron/check` yolunu Routing Middleware'den dışlar; aksi halde aynı istek için ikinci Fluid Compute invocation ve ikinci Fast Origin Transfer oluşabilir. Proxy'nin fail-closed görevleri route içinde yeniden kurulur: üretim secret ortamı eksiksiz doğrulanır, yalnız `POST` ve query'siz exact path kabul edilir, request origin/host sabit `APP_URL` ile eşleşir, 2 KiB üstü gövde reddedilir ve en az 32 karakterlik `CRON_SECRET` constant-time karşılaştırılır. Yanlış istek provider veya Convex'e ulaşmaz. Build/Preview kabul testi gerçek deployment kullanım kaydında bir yetkili cron için `0 Routing Middleware + 1 Function` doğrular; bu kanıt yoksa `$7,39` tavanı geçerli sayılmaz ve Production açılmaz.

Provider HTTP beklemesi active CPU sayılmadığından gerçek tutarın tavandan düşük olması beklenir; ölçümden önce daha dar bir rakam vaat edilmez. `$7,39` yalnız doğru secret'lı planlı monitor trafiğinin kodla sınırlandırılmış route/transfer bütçesidir. Etkileşimli kullanım, ilk yayın build'leri, platformun engellediği yetkisiz/saldırı trafiği, kur farkı ve vergi ayrı kalemlerdir. İlk release'te Git auto-deploy kapalıdır; önce yerel build yapılır, en fazla beş kontrollü uzak build denenir ve yeni projenin toplam build efektif maliyeti `$0,50`ye ulaşırsa kullanıcı onayı olmadan yeni uzak build başlatılmaz. Bu bir sonraki build'i başlatmama kapısıdır; başlamış tek bir uzak build `$0,50` eşiğini aşabilir. Yerel ölçüm ve ilk uzak build süresi sonraki denemelerin bütçesini belirler.

Mevcut kodun hesap başına tekrarlanan vault/cache çağrıları yedi hesaplı normal soğuk çevrimde yaklaşık 95 Convex function call üretir ve doğrudan yayınlanamaz. Hosted sürüm tek batch-read ve tek batch-commit sınırına taşınır: normal çevrim en fazla 12, refresh/recovery/push-cleanup içeren çevrim en fazla 20 Convex function call kullanır. Bu sayı cron action'ın kendisini, `scheduledTime`/run kabulü için gerekli system-table `runQuery` çağrısını, bütün `ctx.runQuery`/`ctx.runMutation`/`ctx.runAction` çağrılarını, route'un Convex'e dönüş çağrılarını ve en fazla bir uygulama-içi retry'ı birlikte sayar. Final stale-endpoint cleanup tek batch'tir. Aggregate snapshot sorguları, replay-reject, manuel yenileme/test ve gecikmeli işler `≤12/≤20` çevrim sınırına dahil değildir; yine de aşağıdaki deployment warning/disable sınırlarına ve takım Free hard cap'ine dahildir. Bu nedenle `9.000 × 20 = 180.000` yalnız kabul edilmiş planlı monitor trafiğinin tavanıdır, toplam aylık çağrı tahmini değildir.

Pano tarayıcıdan Convex'e doğrudan public query/subscription açmaz. Mevcut HttpOnly parola oturumunu doğrulayan tek same-origin aggregate snapshot route'u, yalnız görünürken ve `Panoyu canlı izle` açıkken en sık 60 saniyede bir çağrılır; görünür duruma dönüşte tek anlık sorgu yapar. Hidden veya kapalı her cihaz `0` periyodik snapshot isteği üretir; yenilenmeyen canlı lease en geç iki dakikada düşer. Tek aggregate snapshot operation'ı lease'i, UTC-ay toplam çağrı sayacını ve tam-cevap sayacını atomik yönetir; bu operation'ın kendisi aylık function-call muhasebesine dahildir. Aynı anda en fazla iki görünür cihaz canlı pano lease'i alabilir, UTC ayda en fazla 100.000 operation ve bunların içinde en fazla 20.000 tam snapshot kabul edilir. Sonraki cihaz/istek en fazla 256 B maliyet-koruma zarfı alıp on-focus/manuel moda düşer; on-focus veya manuel yol bu iki aylık sayacı bypass etmez. Sunucu monitorü etkilenmez.

İstemci son `knownRevision` değerini yollar. Operation önce en fazla 256 B'lık ayrı revision özet satırını okur; revision aynıysa kart dokümanlarını hiç okumadan en fazla 256 B `{ unchanged, revision }` döndürür. Revision eski/uydurmaysa ve atomik tam-cevap bütçesi varsa credential-free tam snapshot en fazla 10 KiB'dir; bütçe yoksa kart dokümanını okumadan en fazla 256 B koruma zarfı döner. Revision yalnız kart projeksiyonu gerçekten değiştiğinde ilerler. Böylece kayıp cevap, stale storage veya aynı oturumlu istemcinin keyfî revision değeri 20.000 tam cevap tavanını aşamaz. Kasıtlı kötü durumda `20.000 × 10 KiB` tam snapshot yaklaşık 195,32 MiB, `80.000 × 256 B` küçük cevap yaklaşık 19,54 MiB olur. Convex monitor action egress'i için ayrılan 64 MiB ile toplam yaklaşık 278,86 MiB kalır ve 0,40 GB Production warning eşiğinin altında manuel/test trafiği için de pay bırakır. Böylece `VAULT_ACCESS_SECRET` veya ayrı bir browser JWT/JWKS zinciri istemciye taşınmaz. Route hesap başına sorgu yapmaz ve manuel provider yenilemesi ayrıca oran sınırlıdır.

Bir monitor çevriminin serialize edilmiş toplam Convex batch API read+write payload'ı hedef 32 KiB, sert 48 KiB'dir; ham provider cevabı saklanmaz. Bu API payload sınırı Database I/O tavanı gibi sunulmaz: Convex metriği doküman ve indeks okumalarını/yazılarını sayar; iç scan ve index maliyeti zarf boyutundan türetilemez. Preview'daki en az 1.000 fixture çevriminde platformun gerçek Database I/O read+write metriği ayrı ayrı ölçülür. Production ancak `1,30 × (9.000 × ölçülen en yüksek monitor-çevrimi I/O + 80.000 × ölçülen en yüksek küçük snapshot-operation I/O + 20.000 × ölçülen en yüksek full-snapshot-operation I/O) < 0,60 GB` koşulu sağlanırsa açılır. Snapshot operation ölçümü atomik aylık sayaç ve lease read/write'larını içerir. Yüzde 30 ölçüm payına rağmen Production 0,60 GB warning'e ulaşırsa canlı pano önce on-focus/manuel moda, gerekirse monitor maliyet korumasına geçer; deployment 0,75 GB'de fail-closed durur. Böylece ölçüm bir hard-bound iddiasına dönüştürülmez, ücretli plana taşma ise takım Free cap'inden önce engellenir.

Convex cron action'ı varsayılan 64 MiB runtime'da kalır ve hiçbir dosya düzeyinde `"use node"` içermez. Vercel fetch'i `AbortSignal.timeout(18_000)` ile kesilir; `pingCheck` dahil hiçbir üst sarmalayıcı 20 saniyelik toplam action bütçesini veya route'un 15 saniyelik sert sınırını uzatamaz. Action cleanup/aggregate kaydını kalan sürede tamamlar. 9.000 × 20 saniyelik kasıtlı üst bekleme 3,125 action GB-saat eder; yalnız Vercel'in zamanında kapanmasına güvenilmez. Testler runtime'ı, action deadline'ını, ortak dış-I/O signal'ını, journal/commit rezervini, çağrı ve byte bütçesini kilitler.

Free kotaları takım çapında, warning/disable limitleri deployment çapındadır. Tablodaki uygulama koruması, scheduler, route ve UI'nın kendi muhasebeleştirdiği bütün Convex function çağrılarını sayar; Convex platform metriği ayrıca izlenir ve nihai takım hard cap'idir. Bu yüzden kaynak tahsisi bütün aktif deployment'ların hard limit toplamını Free takım kotasının altında tutar:

| Convex kaynak | Production warn / disable | Preview warn / disable | Dev warn / disable | Takım Free hard cap |
| --- | ---: | ---: | ---: | ---: |
| Function calls / ay | 300k / 500k | 50k / 100k | 25k / 50k | 1M |
| Action compute / ay | 4 / 6 GB-saat | 0,25 / 0,5 | 0,25 / 0,5 | 20 GB-saat |
| Database I/O / ay | 0,60 / 0,75 GB | 0,025 / 0,05 | 0,025 / 0,05 | 1 GB |
| Data egress / ay | 0,40 / 0,60 GB | 0,05 / 0,10 | 0,05 / 0,10 | 1 GB |

Preview cron yalnız 24 saatlik kabul penceresinde açılır ve Production başlamadan önce kapatılır; dev deployment'ta periyodik cron hiçbir zaman açılmaz. Sonraki release kabulünde Production monitorü ile Preview cron aynı anda çalışmaz. Böylece deployment limitleri ayrı ayrı dolmadan takım hard cap'inin bitmesi engellenir ve en az 200k call, 13 GB-saat action, 0,15 GB I/O ve 0,20 GB egress takım rezervi kalır.

Free database storage 0,5 GB takım hard cap'idir ve deployment usage-limit metriği değildir. Uygulama en fazla 12 provider hesabı, 10 push cihazı, 35 günlük idempotency/sağlık penceresi ve toplam 16 MiB uygulama-serileştirilmiş kalıcı payload sınırı kullanır; ham provider cevabı veya sınırsız olay geçmişi tutulmaz. Preview kabulünde toplam takım storage `<25 MiB` olmalıdır; 25 MiB aşılırsa Production açılmaz. Production'da toplam takım storage 50 MiB'yi aşarsa yeni hesap/cihaz/history yazıları fail-closed durur ve neden araştırılmadan yeniden açılmaz. Free sınırı ücret yazmak yerine hizmeti durdurabileceği için her warning/disable olayı panelde açık `maliyet koruması nedeniyle izleme durdu` durumu olur.

Fixture/load testinde 12 hesap ve en az 1.000 deterministik çevrimle 0,5/2/5/15 saniye dağılımları, refresh/recovery, p50/p95/p99, active CPU, memory, batch call sayısı ve kısmi timeout davranışı ölçülür. Hedef p95 `<10 saniye`, p99 `<13 saniye` ve hiçbir route'un 15 saniyeyi geçmemesidir. Yedi gerçek hesapla üç çevrim yalnız smoke testtir; Production öncesi Preview en az 24 saat/288 doğal çevrim çalışır. İlk yedi Production günündeki 2.016 örnek güvenilir p99 ve gerçek maliyet bandını verir; eşik aşılırsa cron bakım moduna alınır.

Vercel ve Convex usage ekranları her uzak build sonrası ve yayından 24 saat, 7 gün ve 30 gün sonra kontrol edilir. Vercel Spend Management takım çapında olduğundan diğer üretim projelerini durdurabilecek hard pause açılmaz; mevcut takım ayarı kullanıcıdan ayrıca izin alınmadan değiştirilmez. How Much AI'ın kendi 9.000-run/15-saniye/batch limitleri proje içi sert korumadır; herhangi bir otomatik ücretli plan yükseltmesi yasaktır.

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
- exact cron yolunun `proxy.ts` matcher'ından çıktığı, route'un proxy fail-closed kontrollerini kendi içinde yaptığı ve bir yetkili isteğin `0 Routing Middleware + 1 Function` ürettiği;
- cron route'un `dub1`, 2 GB Standard, 15 saniye azami süre, 13 saniyelik iç deadline, ortak dış-I/O abort'u ve 1,5 saniyelik journal/commit rezerviyle p95/p99 bütçesini karşıladığı;
- UTC ay sayacının 9.000 planlı çevrimi aşmadığı, yinelenen run'ı provider'a göndermediği ve brüt monitor tavanı hesabının doğrulandığı;
- Convex'in EU West Free planda kaldığı, cron action'ın 64 MiB varsayılan runtime kullandığı, `pingCheck`in 20 saniyeyi aşmadığı ve normal/olaylı çevrimlerin tanımlı dahil-etme kuralıyla sırasıyla 12/20 function call bütçesini aşmadığı;
- aggregate snapshot operation'ının iki canlı cihaz/100.000 aylık toplam/20.000 aylık tam-cevap sayacını atomik koruduğu, keyfî stale revision ile aşılamadığı, 256 B revision/unchanged ve 10 KiB full-response sınırlarını tuttuğu; egress ve database-I/O kötü-durum hesaplarının Preview platform metriğiyle doğrulandığı;
- ilk yayın uzak build sayısı/maliyet kapısının ve ücretli eklenti yokluğunun doğrulandığı;
- `tr-TR`/ISO UTC kontratının Istanbul, UTC gece yarısı ve DST kullanan ikinci saat diliminde aynı anı doğru gösterdiği;
- gerçek iPhone kapalı-PWA push testi ve Windows push testi geçiyor;
- Vercel/Convex usage ekranında beklenmeyen ücretli kaynak veya otomatik plan yükseltmesi yok;
- Vercel/Convex rol denetimi güven modelini karşılıyor, projeler EU West/`dub1` kararına uyuyor;
- yeni linkin exact project/org ID'si doğrulanmış ve takımın mevcut üretim projesinin ayarı, deployment'ı, domain'i ve environment **adları** değişmemiş;
- rollback runbook'u rollback-uygun ve secret-rotasyonu sonrası uygunsuz fixture'larla doğrulanmış.

## Başarı ölçütü

Kullanıcı Windows veya iPhone'da terminal açmadan Vercel HTTPS adresine gider, zorunlu parola ile giriş yapar, PWA'yı kurar ve uygulama kapalıyken kullanım uyarısı alır. Sistem mevcut Vercel Pro faturalama kapsamından yararlanırken takımın diğer üretim projesinden ayrı proje/config namespace'inde kalır; yetkili takım üyeleri açık güven modeline dahildir. Normal kişisel kullanımda ilave maliyet ölçülmüş süre bütçeleriyle düşük tutulur ve gerçek kullanım panellerinden izlenir.
