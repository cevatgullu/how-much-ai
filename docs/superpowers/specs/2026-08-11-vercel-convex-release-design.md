# How Much AI — Özel Vercel ve Convex Yayın Tasarımı

Tarih: 2026-08-11

Durum: Ayrı Vercel/Convex takım yönü onaylandı; satın alma öncesi güvenlik ve Trial revizyonu son kullanıcı incelemesini bekliyor; dış kaynak veya abonelik henüz oluşturulmadı

## Amaç

How Much AI'ı terminal gerektirmeden Windows ve iPhone'dan açılabilen, parola korumalı, **tek-kiracılı ve tek ortak parolalı** bir web/PWA olarak yayımlamak. Yeni uygulama aynı Vercel kullanıcı hesabında fakat eski V2'nin takımından, kullanım kredisinden, harcama durdurmasından, projesinden, alan adından, çevre değişkenlerinden ve çalışma verisinden tamamen ayrı yeni bir takımda çalışır. Bu takım önce ödeme yöntemi eklenmemiş 14 günlük Pro Trial olarak doğrulanır; ancak bütün yerel, gerçek-bulut ve fiziksel iPhone kapıları geçip kullanıcı checkout toplamını ayrıca onaylarsa aynı takım ücretli Pro'ya çevrilir.

Bu belgede tasarlanan ürünün görünen adı **How Much AI — Özel PWA**'dır. Kullanıcının daha eski uygulaması **eski V2** olarak yalnız izolasyon hedefidir ve kapsam dışıdır; bulut takım/proje adında veya arayüzde yeni ürünü “V2” diye adlandırmak yasaktır. Eski uygulamadan hesap, kasa veya ayar otomatik taşınmaz.

Seçilen topoloji:

- Next.js uygulaması: Vercel;
- şifreli kasa, dağıtık yenileme koordinasyonu, bildirim durumu ve beş dakikalık cron: Convex;
- cihaz bildirimleri: standart Web Push/VAPID;
- erişim: uygulamanın kendi zorunlu parola girişi;
- iPhone/Windows kurulumu: PWA;
- ilk sürüm adresi: Vercel'in ürettiği HTTPS adresi.

## Neden bu yaklaşım

Değerlendirilen seçenekler:

1. **Seçilen: kartsız ayrı Vercel Pro Trial → kabulden sonra ayrı Vercel Pro takımı + ayrı Convex Free takımı + PWA.** Terminal olmadan erişim, kapalı uygulamada bildirim ve cihazlar arası tek şifreli kasa sağlar. Trial sırasında satın alma yapılmaz. Kabulden sonra kullanıcı ayrıca onaylarsa yeni Vercel takımının `$20/ay` taban bedeli ve ayrı `$20/ay` kullanım kredisi başlar; eski V2'nin kredisi, kullanım limiti veya durdurma eylemi bu uygulamadan etkilenmez.
2. **Windows yerel kurulum + iPhone için ayrı kanal.** Masaüstünde güçlü yerel izolasyon sağlar fakat iPhone arayüzünü ve kapalı uygulama push'unu tek üründe çözmez.
3. **Native Windows/iOS paketleri.** En derin işletim sistemi bütünleşmesini sağlar ancak iki ayrı uygulama, imzalama/mağaza süreçleri ve çok daha yüksek bakım yükü getirir.

Tek kullanıcılı, tek sayfalık ürün için web/PWA yolu en düşük operasyon yüküyle iki cihazı birlikte çözer. Kapalı iPhone/Windows PWA bildirimi ürünün temel sözü olduğu için beş dakikalık sunucu monitorü bu tasarımda korunur; takım izolasyonu monitorü kaldırmak değil maliyet ve arıza etkisini eski V2'den ayırmak içindir.

## Hesap ve proje izolasyonu

Read-only denetimde Vercel CLI'ın doğru kullanıcıyla çalıştığı, eski V2'nin mevcut takım/projesinin sağlıklı olduğu ve yeni worktree'nin hiçbir Vercel projesine linkli olmadığı doğrulandı. Eski V2 yalnız secretsiz bir değişmezlik baseline'ı almak için okunur; o takımda hiçbir ayar, link, build, deploy veya faturalama mutasyonu yapılmaz. Kişisel kullanıcı/takım kimlikleri sürüm kontrolündeki bu belgede tutulmaz.

Adlandırma netleşmeden önce açılmış geçici `codex/hma-web-v2` branch/worktree etiketi bir bulut veya ürün kimliği değildir. Şartname onayından sonra, uygulama koduna başlamadan önce bu çalışma alanı `how-much-ai-private-pwa` anlamını taşıyan nötr bir branch/worktree adına güvenli biçimde yeniden adlandırılır; eski V2 repository/worktree'si hedef alınmaz.

Yeni kaynaklar:

- aynı kullanıcı hesabı altında yalnız bu uygulamayı içeren, ödeme yöntemi taşımayan yeni tek üyeli Vercel Pro Trial takımı; kabul ve ayrı satın alma onayından sonra aynı takım ücretli Pro olur;
- yeni takımda ayrı Vercel projesi: `how-much-ai-private`;
- aynı Convex kullanıcı hesabı altında, eski projelerden ayrı tek üyeli yeni **Free** takım ve ayrı EU West proje/deployment: `how-much-ai-private`;
- ayrı VAPID anahtar çifti;
- her güvenlik rolü için ayrı rastgele secret;
- yeni, boş şifreli kasa.

Kesinlikle yapılmayacaklar:

- mevcut üretim projesinin çevre değişkenlerini kopyalamak veya yeniden kullanmak;
- mevcut üretim alan adını değiştirmek ya da aynı projeye yeni uygulama eklemek;
- mevcut projenin build/deploy ayarlarını değiştirmek;
- eski V2'nin Vercel veya Convex takımında yeni proje, shared environment, integration, resource, domain ya da deployment oluşturmak;
- alan adını başka projeden koparabilen `--force` benzeri transfer yollarını kullanmak;
- yerel `.data` veya `.env*` dosyalarını okumak, kopyalamak ya da deploy paketine koymak;
- bir projenin Convex erişim secret'ını diğerinde kullanmak.

Ayrı proje tek başına yeterli sayılmaz: Vercel kredisi, metered usage, Spend Management ve Owner/Member yetkileri takım çapındadır; Convex Free kotaları ve Team Admin yetkisi de takım çapındadır. Bu nedenle iki platformdaki yeni takım kimlikleri eski V2'nin takım kimliklerinden farklı olmak zorundadır. Ayrı takım, Vercel'in team-scoped kullanım kredisini, metered usage hesabını ve Spend Management eylemini eski V2'den ayırır. Aynı kullanıcı girişi ve ileride aynı kartın kullanılması bu sayaçları birleştirmez; buna karşılık ortak kullanıcı hesabının ele geçirilmesi iki takımı da etkiler ve Vercel'in ödeme gecikmesinde kullandığı “account” kapsamının takımlar arası arıza etkisi kamu belgelerinde kesin değildir. Bu nedenle hesapta MFA/passkey zorunludur; satın alma öncesi checkout'ta takım kapsamı doğrulanır ve ödeme-arızası için mutlak izolasyon istenirse Vercel Support'tan yazılı teyit alınmadan böyle bir garanti verilmez.

Dış kaynak oluşturulmadan önce iki platformun üye/rol listesi read-only denetlenir. Yeni Vercel ve Convex takımlarında yalnız kullanıcı Owner/deployer olur; eşe veya arkadaşa PWA parolası vermek platform üyeliği ya da ücretli deployer seat'i açmaz. İleride ikinci deployer daveti, güncel ek seat maliyeti gösterilerek ayrıca onaylanır. Yeni takımda project-linked shared environment variable, takım çapı integration/resource veya ücretli eklenti bulunmaz; bütün runtime secret'lar yalnız yeni projenin ilgili ortamına scoped edilir.

İlk mutasyondan önce secretsiz bir izolasyon manifesti eski V2'nin Git SHA/dirty durumunu; Vercel team/project/deployment/domain kimliklerini, environment **adları ve scope'larını**, integration/resource bağlantılarını ve Spend Management ayarını; Convex team/project/deployment/cron/limit kimliklerini kaydeder. Yeni hedef kimlikleri oluştukça aynı manifeste eklenir. Yeni ve eski Vercel team ID'leri, project ID'leri veya Convex team ID'leri eşitse; worktree dirty ise; hedeflerden biri belirsizse işlem fail-closed durur.

Vercel projesi linklendikten sonra yalnız yeni worktree'deki `.vercel/project.json` içindeki yeni project/org kimliği beklenen hedefle eşleşmeden hiçbir environment veya deploy mutasyonu yapılmaz. Her Vercel CLI çağrısı açık yeni takım scope'u ve bu worktree'nin `--cwd` sınırıyla çalışır; ambient `VERCEL_PROJECT_ID`, CLI hedefi ve link dosyası aynı değilse durur. Eski V2'nin domain/deployment/environment adları, integration/resource bağlantıları, Spend Management ayarı ve Convex kimlikleri yayın öncesi/sonrası baseline ile birebir karşılaştırılır.

Convex bootstrap iki ayrı fail-closed basamaktır. Önce **yalnız yeni takım** oluşturulur; süreç hemen durur, dönen team ID isolation manifestine kaydedilir ve eski team ID'den farklı olduğu doğrulanır. Bu kapı geçmeden project create çağrısı yapılamaz. Ardından project create işlemi açıkça bu doğrulanmış yeni team ID/slug'ına scope edilir; dönen project ID ve parent-team ID yeniden doğrulanır. Ancak ikisi de manifestle eşleştikten sonra deployment, environment, deploy key veya cron oluşturulabilir. Sonraki her Convex create/env/deploy mutasyonundan **önce** release wrapper beklenen yeni team/project/deployment kimliğini, scoped deploy key'in secretsiz SHA-256 fingerprint–hedef eşlemesini ve platformun read-only hedef metadata'sını birlikte doğrular. Ambient `CONVEX_DEPLOYMENT`, geniş kişisel access token veya manifeste kayıtlı olmayan deploy key varsa alt süreç başlatılmaz. CLI hedef metadata'sını mutasyon öncesi doğrulayamıyorsa güvenli varsayım yapılmaz; beklenen yeni proje ekranından yeni scoped key üretilip bağ yeniden kaydedilene kadar işlem durur. `npx convex deploy` ilk hedef doğrulaması olamaz; deploy sonrası authenticated health fingerprint'i ikinci bağımsız kontroldür.

## Tek kullanıcı ve paylaşım modeli

Bu sürüm gerçek bir tek-kiracılı, tek ortak parolalı kurulumdur. Parolayı bilen herkes aynı hesapları, ayarları ve bildirim kurallarını görür ve tam yazma yetkisine sahiptir; salt-okunur paylaşım yoktur. Her yetkili kişi AI hesabı bağlayabilir/kaldırabilir, ortak kuralları değiştirebilir ve sunucu izlemesini bütün kayıtlı cihazlar için durdurabilir.

Eş veya çok güvendiğiniz biri aynı kasayı kullanacaksa aynı parolayı paylaşmak teknik olarak mümkündür; bu ayrı kullanıcı hesabı, ikinci Vercel deployer seat'i veya ikinci `$20` taban ücret oluşturmaz. Aynı kasa, cihaz sınırları, kullanım kredisi ve uygulama maliyet korumaları paylaşılır. Arkadaşların kendi AI hesaplarını ve kasasını kullanması istenirse bu deployment'a davet edilmezler; kişi başına ayrı Vercel/Convex kurulumu, ayrı parola/şifreli kasa ve güncel fiyat değişmediyse vergi/kur hariç ayrı `$20/ay` Pro takım bedeli gerekir.

İlk sürümde davet, kullanıcı tablosu, parola sıfırlama e-postası, rol veya kişi başına hesap görünürlüğü eklenmez.

## Maliyet kontratı

Eski V2'nin Vercel takımı ve kredisi bu uygulamanın maliyet hesabına katılmaz. Yeni How Much AI takımının Trial ve sonraki olası Pro kullanımı ayrı Spend Management hesabı ve ayrı kullanım kredisi taşır. Aynı fiziksel kart satın alma onayından sonra iki takımda ödeme aracı olabilir; bu durum team-scoped kredileri veya kullanım sayaçlarını birleştirmez. Kart ekstresi, kesin vergi ve ödeme-arızası etki alanı checkout/fatura oluşmadan kesin kabul edilmez.

Maliyet sınırları:

- **Vercel doğrulama dönemi:** authenticated hesapta 11 Ağustos 2026 tarihinde `Pro Trial` seçeneğinin mevcut olduğu read-only doğrulandı. Yeni takım ödeme yöntemi eklenmeden açılır; resmî koşula göre Trial 14 gün ve `$20` Trial kredisi sağlar, süre sonunda kart yoksa ücret oluşmadan Hobby'ye döner. Trial uygunluğu eylem anında tekrar kontrol edilir; seçenek yoksa takım oluşturulmaz ve ilk `$20 + vergi` doğrulama ayı riski yeniden onaya sunulur.
- **Vercel ücretli dönem:** bütün kabul kapılarından sonra ayrı kullanıcı onayıyla aynı tek üyeli takım Pro'ya çevrilirse güncel sözleşme bedeli **`$20/ay` taban ücret** olup bir deploying seat ve yalnız bu takıma ait **`$20/ay` kullanım kredisi** içerir. Kredi abonelik ücretinden düşmez. Vergi ve kartın kur/komisyonu bu dolar tutarına dahil değildir. İkinci deployer, ücretli add-on veya Marketplace kaynağı yoktur. Yeni proje Web Analytics, Speed Insights, Observability Plus, Blob, Edge Config, Workflow, AI Gateway veya ücretli Marketplace kaynağını otomatik etkinleştirmez.
- **Convex:** EU West'te, diğer projelerden ayrı tek üyeli **Free** takım/deployment zorunludur. Starter veya Professional açılmaz. Starter/Professional dahil kullanımı EU West'e uygulanmadığından ücretli plana sessiz geçiş yasaktır; Free EU kurulumu mümkün değilse kaynak oluşturma durur ve maliyet yeniden onaya sunulur.
- **Web Push:** doğrudan VAPID ile Apple/Microsoft aktarımında üçüncü taraf bildirim aboneliği yoktur.
- **Alan adı ve mağaza:** ilk sürüm Vercel'in HTTPS alanını ve doğrudan PWA kurulumunu kullanır; özel alan adı veya mağaza ücreti yoktur.

Ücretli Pro başladıktan sonra sunucu izlemesini kapatmak veya uygulamayı hiç kullanmamak aylık `$20` Vercel Pro takım aboneliğini iptal etmez; abonelik ancak takım planı ayrıca kapatılırsa sona erer. Trial takımına satın alma onayından önce kart eklenmez.

Trial takımını oluşturma mutasyonundan hemen önce resmî [Vercel Pro Trial](https://vercel.com/docs/plans/pro-plan/trials), [Vercel Pro planı](https://vercel.com/docs/plans/pro-plan), [Spend Management](https://vercel.com/docs/spend-management), [Convex fiyatlandırması](https://www.convex.dev/pricing) ve [Convex limitleri](https://docs.convex.dev/production/state/limits) yeniden okunur. Trial/kartsız dönüş, `$20` taban/kredi, Free kapsamı veya bölge koşullarından biri değişmişse takım/proje oluşturulmaz; yeni kesin koşul kullanıcıya yeniden onaya sunulur. Satın alma anında checkout'taki `$20` subtotal, kesin vergi/toplam, ilk tahsilat ve yenileme tarihi, tek seat ve sıfır add-on gösterilmeden kart eklenmez.

Convex scheduler beş dakikada bir tek yetkili Vercel route çağrısı yapar. Bu ritim 30 günlük ayda 8.640, 31 günlük ayda 8.928 çevrimdir. Run ID scheduler'ın UTC `scheduledTime` değerinden deterministik beş-dakika kovası olarak üretilir; benzersiz indeks aynı kovada yalnız bir planlı çalışmayı kabul eder. Gelecek kovası ve 12 dakikadan eski gecikmiş/replay kovası provider'a ulaşmaz. Kalıcı ve atomik UTC-ay sayacı ayrıca en fazla **9.000 planlı monitor çevrimini** kabul eder. Schedule freshness + benzersiz beş-dakika kovası ayrı matematiksel rolling invarianttır: herhangi bir gerçek 31×24 saat aralığında en fazla 8.928, 30 günlük Vercel fatura aralığında en fazla 8.640 run mümkündür; ay sınırında eski işleri topluca oynatıp iki kota harcanamaz. Yinelenen run ID, replay ve limit üzeri çalışma provider çağrısı yapmadan bütçe-korumalı kapanır; manuel yenileme ve test bildirimleri ayrı oran limitine sahiptir.

Monitor route'u Dublin `dub1` Standard 2 GB/1 vCPU üzerinde `maxDuration = 15 saniye` kullanır. Girişte monotonic clock ile tek mutlak deadline üretilir; provider usage/profile ve Web Push dış I/O'su aynı birleşik `AbortSignal` ve kalan-süre bütçesini kullanır. İç iş bütçesi 13 saniyedir ve son 1,5 saniyesi durable event journal + tek toplu final commit için ayrılır; yeni dış iş 11,5 saniyelik iş kesiminden sonra başlamaz. Eski 15/30 saniyelik bileşen timeout'ları mutlak deadline'ı uzatamaz ve Convex→Vercel sarmalayıcısındaki 240 saniyelik bekleme kaldırılır. **Bu route rotating veya tek-kullanımlık refresh credential'ı hiçbir koşulda kullanmaz.** Bilinen access-token expiry'sine en fazla 20 dakika kalması veya 401 görülmesi aynı generation için tek bir `renewal_pending` işi atomik kuyruğa alır; aynı çevrimde provider retry yapılmaz, hesap taze usage cevabı yoksa kısmi sayılır ve diğer hesaplara devam edilir. Beş-dakikalık monitor cadence'i nedeniyle normal proaktif admission expiry'den 15–20 dakika önce olur. Pending/inflight/unknown credential için ikinci iş açılmaz.

En çok dört hesap aynı anda işlenir, başlangıç hesabı kalıcı dönen imleçle değişir; böylece ardışık yavaş hesaplar diğerlerini aç bırakmaz. Başarılı hesaplar tek toplu commit ile saklanır, süresi dolanlar kısmi sonuç olarak bir sonraki beş dakikalık çevrimde yeniden denenir. Gerçek olay önce kararlı bir event ID/tag ile durable journal'a alınır; push tamamlanmadan bildirim geçiş durumu ilerlemez. Deadline, geçici hata veya belirsiz teslim halinde olay pending kalır ve sonraki çevrim aynı kimlikle yeniden dener; final stale-endpoint temizliği de tek batch'tir. Bu event retry semantiği yalnız idempotent Web Push/detector olayları içindir; credential refresh POST'u hiçbir zaman bu retry yoluna girmez.

### Tek-kullanımlık credential yenileme hattı

Claude gibi yenileme grant'ini tek kullanımda tüketebilen sağlayıcılar ayrı `/api/cron/renew` hattını kullanır. Route exact path olarak `proxy.ts` matcher'ından çıkar, `dub1` Standard 2 GB/1 vCPU üzerinde `maxDuration = 80 saniye` çalışır ve yalnız ayrı en az 32 karakterlik `RENEW_SECRET` ile çağrılır. Route monitor ile aynı fail-closed zarfı kendi içinde uygular: yalnız query'siz exact path ve `POST`, exact `APP_URL` origin/host, en fazla 2 KiB request, en fazla 4 KiB safe response, redirect yok ve `RENEW_SECRET` constant-time doğrulaması. Geçersiz istek provider veya Convex'e sıfır çağrı yapar.

Renewal scheduled action başlamadan önce Convex'te fiyatlandırma fence'i zorunludur. Queue-admission veya mevcut beş-dakikalık monitorün fallback reconciliation aşamasındaki tek atomik **mutation**, iki global slotun boş kısmını DB kuyruğundaki farklı lineage'lardan `(accountId, credentialGeneration)` işleriyle doldurur. Her slot server-owned `slotId` ve monotonik `slotEpoch` taşır. Her iş için global ve lineage başına UTC-ay/exact-rolling sayaçları tüketilir; `dispatchReservedAt`/`scheduledAt` ile opak `dispatchId` için geri alınamaz `dispatch_started` rezervi yazılır; `ctx.scheduler.runAfter(0, renewalDispatcher, { slotId, slotEpoch, dispatchId })` dönüşündeki `scheduledFunctionId` aynı kayda bağlanır ve transaction birlikte commit eder. Mutation commit etmezse rezerv veya action oluşmaz; hiçbir renewal action reservation'sız başlayamaz.

Scheduled dispatcher iş seçmez/kota almaz. Handler'ın **ilk durable işlemi**, request metadata'daki scheduled-function kimliğini de içeren exact `(slotId, slotEpoch, dispatchId, scheduledFunctionId, reconcileFunctionId=null)` CAS'idir. Aynı mutation server-owned `actionStartedAt`ı yazar, `ctx.scheduler.runAt(actionStartedAt + 95 saniye, renewalReconcile, { slotId, slotEpoch, dispatchId, scheduledFunctionId })` ile terminal checkpoint'ini planlar ve dönen `reconcileFunctionId`yi slota bağlar. Bu mutation commit etmez veya CAS başarısızsa action dış I/O ya da başka `ctx.run*` yapmadan döner; checkpoint yoktur. Checkpoint kendi request-metadata scheduled-function ID'si dahil exact `(slotId, slotEpoch, dispatchId, scheduledFunctionId, reconcileFunctionId)` eşleşmesini tekrar CAS eder. Gecikmiş checkpoint/fallback başka epoch'a ait slotu görürse **sıfır write, schedule ve dış I/O** ile çıkar.

Fallback bir `reconcileFunctionId` varsa checkpoint sistem kaydını da kontrol eder. Checkpoint `Pending`/kanıtsızken fallback slotu ilerletemez; 12 dakikadan eski checkpoint önce yalnız cancel-request alır ve ardıl ancak scheduled **mutation** kaydı terminal `Success`, `Failed` veya `Canceled` olduktan sonra exact tuple CAS'iyle açılabilir. Scheduled mutation cancellation'ı başlamamış checkpoint'i atomik durdurur; action cancellation semantiğiyle karıştırılmaz. `reconcileFunctionId` hiç oluşmamışsa yalnız action'ın aşağıdaki kanıtlı terminal/fail-before-start yolu kullanılabilir. Böylece fallback'in ilerlettiği eski epoch'a ait checkpoint sonradan çalışıp aynı slotta ikinci handoff açamaz.

Checkpoint veya fallback, action'ın `_scheduled_functions` kaydını kesin `Success` ya da `Failed` görürse o slotu atomik reconcile edip sıradaki işi doldurabilir. Genel `Canceled` terminal kanıt sayılmaz. On iki dakikadan eski `Pending` işi iptal eden mutation exact slot tuple'ını ve `actionStartedAt`/`attempt_started` yokluğunu aynı transaction'da doğrular; dispatch'i geri alınamaz `canceled_before_start` fence'ine geçirir ve `ctx.scheduler.cancel(scheduledFunctionId)` çağrısını commit eder. Action-start CAS önce kazanırsa cancel mutation conflict/retry sonrası iptal etmez; cancel-fence önce kazanırsa geç başlayan/çalışmakta olan handler ilk CAS'te terminal dispatch'i görüp provider/Vercel I/O'su yapmadan çıkar. Ardıl yalnız sonraki reconciliation hem bu cancel-fence'i hem `actionStartedAt=null`, `attempt_started=false` ve sistem `Canceled` durumunu birlikte görürse açılır. Dashboard/haricî iptal veya started action için `Canceled` fail-closed kalır. `Pending`, `InProgress`, okunamayan ya da kanıtsız durumda o slotta ardıl yoktur; diğer slot bağımsız ilerleyebilir.

Bu ayrım, Convex'in çalışan bir scheduled action iptal edildiğinde action'ın yürümeye devam edebileceğini söyleyen resmî [Scheduled Functions](https://docs.convex.dev/scheduling/scheduled-functions) semantiğine dayanır; yalnız görünen `Canceled` etiketiyle sahiplik serbest bırakılmaz.

Aynı `dispatchId` için scheduled-action execution ve Vercel invocation sayıları ayrı ayrı en fazla 1'dir; action crash-before-fetch bile rezervi tüketir ve route'tan kanıtlı sonuç gelmemişse reconciliation işi güvenli false-unknown durumuna alır. Route yalnız bu owner-fenced dispatch'i provider `attempt_started` fence'ine ilerletebilir. Aynı `credentialGeneration` için upstream provider POST sayısı en fazla 1'dir. Yalnız route'un owner-fenced/imzalı terminal cevabı `attempt_started` öncesinde ve `providerPostCount=0` olduğunu kesin kanıtlarsa aynı generation için yeni kota tüketen **yeni dispatchId** ile ikinci bir Vercel invocation açılabilir; bu yalnız route/preflight onarımıdır. Timeout, crash, transport belirsizliği veya route acknowledgement yokluğu yeni dispatch açamaz.

Hem UTC takvim ayında hem kayan son tam **31×24 saat** içinde en fazla **1.200 hesap-düzeyi yetkili Vercel dispatch reservation** ve provider-account lineage başına en fazla **100 dispatch**, lineage başına aynı anda bir pending/inflight iş ve dispatch başına scheduled action, terminal-checkpoint, bütün `ctx.run*`, route dönüşleri, replay/crash cleanup dahil en fazla **20 Convex function call** kabul edilir. Mevcut yaklaşık sekiz saatlik access-token ömrü ve en erken 20 dakika proaktif admission, başarılı yenilemeler arasında en az 460 dakika bırakır. Exact 31-günlük kapalı pencerede sert doğal üst sınır lineage başına `ceil(44.640 / 460) = 98`, 12 hesapta **1.176 dispatch**tir; lineage başına 2 ve global 24 dispatch güvenlik payı kalır. Gerçek provider ömrü daha kısalırsa veya hata rezervi yetmezse bütçe sessizce yükseltilmez. Kayan sayaç günlük kaba bucket değildir: en fazla 1.200 server-owned dispatch timestamp'ini tutan sınırlı ring/index, `now - 31×24h` öncesini atomik budar ve global/per-lineage exact pencereyi aynı transaction'da kontrol eder. Timeout, preflight, crash veya sonucu belirsiz dispatch de tavanlara dahildir. Yetkili Vercel Function invocation ve upstream POST gerçek sayaçları ayrı tutulur; her biri dispatch sayısından küçük/eşit ve en fazla 1.200'dür. Kota dolarsa yeni refresh denenmez; hesap `renewal_pending · maliyet koruması` olarak kalır ve bütçe kullanıcı onayı olmadan artırılmaz.

`renewalBudgetLineage` tarayıcıdan kabul edilmez. Sunucu, provider'ın kararlı account identifier'ını `VAULT_ENCRYPTION_SECRET`tan HKDF ile ayrılmış yalnız-bu-amaçlı alt anahtarla HMAC'leyerek opak lineage üretir; ham identifier loga/sayaç tablosuna gitmez. Reconnect ve credential refresh aynı lineage'ı korur. Remove işlemi 31×24 saatlik şifreli/opak budget tombstone bırakır; aynı provider hesabı yeniden eklenirse lineage ve kalan 100-dispatch penceresi geri bağlanır, sıfırlanmaz. İki farklı provider hesabının lineage sayaçları ayrıdır; hepsi ayrıca ortak 1.200 global tavana tabidir.

Convex Free scheduled-job concurrency headroom'u bir semaphore'da bekleyen çok sayıda action ile değil, **iki slotlu önceden rezerve edilmiş dispatcher + DB queue** ile korunur. Bütün deployment'ta aynı anda en fazla iki normal `Pending/InProgress` renewal action ve bunlara bağlı en fazla iki kısa terminal-checkpoint mutation vardır; monitor cron'u ayrı slotta kaldığından sağlıklı/overrun kesişiminde toplam en fazla beş scheduled execution S16 sınırının altında kalır. İki slot aynı lineage'ı kabul edemez. Atomik cancel-fence yarışında daha önce iptal edilmiş en fazla iki handler kısa süre çalışmaya devam edebilir, fakat ilk CAS öncesi olduklarından provider/Vercel dış I/O eşzamanlılığı yine en fazla ikidir; bu nadir geçişte monitor dahil scheduled execution en fazla yedidir. Action'ın vault/job finalization mutation'ı yalnız kendi terminal uygulama sonucunu yazar; ardıl planlamaz. Gerçek `actionStartedAt + 95 saniye` checkpoint'i exact slot epoch/kimlik CAS'i ve platform terminal kanıtından sonra boşalan slotu atomik doldurur; beş-dakikalık monitor yalnız fallback'tir.

Kabul edilen sağlıklı scheduler zarfında hem action `scheduleLag = actionStartedAt − scheduledAt` hem checkpoint `checkpointStartedAt − checkpointDueAt` her execution için en fazla 5 saniyedir. İki lane'de bir sonraki wave başlangıcı önceki gerçek başlangıçtan en fazla `95 + 5 + 5 = 105 saniye` sonradır: 12-job burst'ünde son iş en geç 8 dakika 50 saniyede başlar ve 90 saniyelik action sınırıyla 10 dakika 20 saniyede terminal olur. Kabul SLO'su son başlangıç `<9 dakika`, son terminal ve oldest-queue-age `<10 dakika 30 saniye`dir. Expiry admission'ı cadence nedeniyle 15–20 dakika önce olduğundan sağlıklı sert burst en az 4 dakika 30 saniye payla tamamlanır. Action veya checkpoint schedule lag'i 5 saniyeyi aşarsa bu matematiksel SLO geçerli sayılmaz; panel `yenileme zamanlayıcısı gecikiyor` gösterir, Trial/Production kabul testi başarısız olur ve maliyet/güvenlik lehine concurrency artırılmaz. Terminal durum kanıtlanamazsa ilgili slot durur ve `yenileme zamanlayıcısı doğrulanamadı` gösterir; credential replay ile otomatik açılmaz. Bekleyen işin access token'ı geçersizse ilgili hesap monitor çevrimlerinde kısmi görünür, fakat diğer hesaplar ve monitor schedule'ı devam eder.

`credentialGeneration` sunucunun ürettiği, istemciden hiçbir zaman kabul edilmeyen ve yeniden kullanılmayan opak en az 128-bit kimliktir. İlk connect, her başarılı reconnect, manual credential replacement, remove→re-add ve başarılı refresh journal finalization yeni generation üretir; eski generation saklı job/journal anahtarı olarak yalnız terminal geçmişte kalır. Renewal queue benzersiz `(accountId, credentialGeneration)` kullanır. Stale job veya journal daha yeni generation'ı overwrite edemez, durumunu temizleyemez ya da eski değeri yeniden etkinleştiremez. Legacy vault ilk kontrollü okumada generation üretir ve round-trip/migration bunu kaybetmez.

Yenileme durum makinesi replay'i güvenlik hatası sayar:

1. Route dış isteğe başlamadan önce `credentialGeneration` CAS ile sahipliği doğrular ve durable, generation'a bağlı terminal provider-attempt fence olan `attempt_started` kaydını commit eder. Bu fence'ten sonra lease süresi dolsa veya owner değişse bile aynı generation için hiçbir yeni owner ikinci POST yetkisi alamaz.
2. Provider refresh endpoint'ine tam **bir** POST yapılır; redirect, transport retry, 401 recovery veya aynı token ile ikinci deneme yoktur. POST yalnız route'un ilk 5 saniyesinde başlatılabilir, kendi timeout'u en az 60 ve en fazla 65 saniyedir. Provider I/O en geç 70. saniyede abort olur; bundan sonra yalnız önceden ayrılmış owner-fenced encrypted recovery-journal ve atomik vault/job finalization I/O'su başlayabilir. Hard response 80. saniyeden önce döner.
3. Doğrulanmış başarı cevabındaki replacement credential önce ana kasadan ayrı mevcut encrypted recovery journal'a durable yazılır. Ardından tek atomik finalization mutation'ı expected vault ciphertext/credentialVersion ile jobId/owner/`attempt_started` fence'i ve journal kaydını birlikte doğrular; replacement'ı ana kasaya taşır ve işi aynı transaction'da `succeeded` yapar. Journal yazısından sonra finalization öncesi crash olursa watchdog önce committed journalı kontrol edip aynı finalization mutation'ını POST yapmadan idempotent olarak tamamlar. Journal yok veya commit'i kanıtlanamıyorsa eski token oynatılmaz. Sonraki beş dakikalık monitor çevrimi hesabı yeniden tarar.
4. Timeout, bağlantı kopması, worker kaybı, herhangi bir `5xx`, eksik/malformed/partial başarı gövdesi, `200` içinde replacement refresh token bulunmaması, cevap alınıp encrypted recovery-journal commit'inin kanıtlanamaması veya provider'ın tüketim sonucu kesin olmayan herhangi bir cevabı `renewal_unknown` üretir. Lease süresi dolan `attempt_started` işi watchdog tarafından bu duruma alınır. Eski refresh credential **otomatik yeniden oynatılmaz**; kullanıcıya güvenli yeniden bağlama gerekir.
5. Yalnız owner-fenced/imzalı terminal preflight sonucu `attempt_started=false` ve `providerPostCount=0`ı birlikte ispatlıyorsa iş tekrar `pending` olabilir; sonraki Vercel invocation yeni dispatch/kota rezervi tüketir. `attempt_started` veya belirsiz route acknowledgement sonrasında otomatik yeniden denemeye izin veren kod yolu yoktur.

Manuel `Yenile`, hesap ekleme/reconnect veya başka bir API de doğrudan rotating credential POST'u yapamaz; refresh gereken bütün hosted yollar aynı owner-fenced state machine'e girer. `renewal_pending` ve `renewal_unknown` son başarılı kota snapshot'ını silmez, fakat veriyi `son veri` olarak işaretler ve yeni eşik/reset olayı üretmez.

Güncel Dublin fiyatıyla 9.000 **yetkili planlı monitor** çevriminin Function invocation + compute tavanı, her çalışmanın 15 saniyenin tamamında 1 vCPU'yu yüzde 100 kullandığı kasıtlı kötü durum üzerinden hesaplanır:

| Kalem | Hesap | Brüt üst sınır |
| --- | --- | ---: |
| Function invocation | `9.000 × $0,0000006` | `$0,0054` |
| Provisioned memory | `9.000 × 15 sn × 2 GB / 3.600 × $0,0139` | `$1,0425` |
| Active CPU | `9.000 × 15 sn / 3.600 × $0,168` | `$6,3000` |
| **Function invocation + compute** | kredi uygulanmadan | **`$7,3479/ay`** |

Cron isteği gövde+metadata bütçesi 2 KiB, başarılı veya hatalı cevap gövdesi 4 KiB'dir; redirect ve aynı çevrimde transport retry yoktur. Planlı monitorün aylık Vercel origin/data aktarım rezervi 64 MiB ile sınırlanır. Takımın ayrılmış Edge Requests/Fast Data Transfer hakkı tamamen tükenmiş varsayılsa bile 9.000 Edge Request (`$0,0216`), 64 MiB Fast Origin Transfer (`$0,00375`) ve 64 MiB Fast Data Transfer (`$0,009375`) en fazla yaklaşık `$0,034725` ekler. Böylece tanımlı yetkili planlı monitorün kredi öncesi Vercel liste-fiyatı üst sınırı **`$7,382625/ay`**, yuvarlanmış operasyon bütçesi **`$7,39/ay`** olur.

Bu hesap her yetkili cron isteğinin tam **bir** Node Function invocation üretmesine bağlıdır. Next.js 16 `proxy.ts` matcher'ı exact `/api/cron/check` yolunu Routing Middleware'den dışlar; aksi halde aynı istek için ikinci Fluid Compute invocation ve ikinci Fast Origin Transfer oluşabilir. Proxy'nin fail-closed görevleri route içinde yeniden kurulur: üretim secret ortamı eksiksiz doğrulanır, yalnız `POST` ve query'siz exact path kabul edilir, request origin/host sabit `APP_URL` ile eşleşir, 2 KiB üstü gövde reddedilir ve en az 32 karakterlik `CRON_SECRET` constant-time karşılaştırılır. Yanlış istek provider veya Convex'e ulaşmaz. Build/Preview kabul testi gerçek deployment kullanım kaydında bir yetkili cron için `0 Routing Middleware + 1 Function` doğrular; bu kanıt yoksa `$7,39` tavanı geçerli sayılmaz ve Production açılmaz.

Renewal hattının 1.200 yetkili dispatch kötü-durum Vercel bütçesi de her route'un 80 saniyenin tamamında 1 vCPU'yu yüzde 100 kullandığı varsayımıyla ayrı bağlanır:

| Kalem | Hesap | Brüt üst sınır |
| --- | --- | ---: |
| Function invocation | `1.200 × $0,0000006` | `$0,00072` |
| Provisioned memory | `1.200 × 80 sn × 2 GB / 3.600 × $0,0139` | `$0,74134` |
| Active CPU | `1.200 × 80 sn / 3.600 × $0,168` | `$4,48000` |
| Aylık agregat 96 MiB Fast Origin Transfer rezervi | decimal GB ile `96 × 2^20 / 10^9 × $0,06` | `$0,00604` |
| **Renewal toplamı** | kredi uygulanmadan | **`$5,22810/ay` → `$5,23`** |

Bu tavan exact `/api/cron/renew` yolunun da `proxy.ts` matcher'ından çıkmasına, dispatch başına en fazla `0 Routing Middleware + 1 Function`, cold start/init/cevap dahil bütün instance ömrünün en fazla 80 saniye olmasına, 2 GB/1 vCPU'ya, aylık agregat request+response+header toplamının 96 MiB altında kalmasına ve hem UTC-ay hem kayan 31 gün için Vercel fetch'inden önce alınmış 1.200 atomik dispatch sınırına bağlıdır. Yeni takımın dahil Edge Request/Fast Data Transfer tahsisinin bu dar trafikte tükenmediği kabul edilir; ilk Usage ölçümü bunu doğrulamazsa maliyet yeniden hesaplanır. Preview kullanım kaydında `0 Routing Middleware + 1 Function` şekli kanıtlanmazsa `$5,23` geçerli sayılmaz ve ücretli Production açılmaz.

Provider HTTP beklemesi active CPU sayılmadığından gerçek tutarın tavanlardan düşük olması beklenir; ölçümden önce daha dar bir rakam vaat edilmez. `$7,39` yalnız doğru secret'lı planlı monitor, `$5,23` yalnız doğru secret'lı renewal trafiğinin kodla sınırlandırılmış route/transfer bütçesidir. Tanımlı monitor, renewal ve ilk yayın için ayrılan en fazla `$0,50` uzak-build kapısı birlikte kredi öncesi yaklaşık **`$13,12/ay`** eder ve yeni takımın `$20` kullanım kredisinden yaklaşık **`$6,88`** ölçüm payı bırakır. Krediye uygun başka tüketim veya eklenti yoksa ücretli dönemde beklenen Vercel ödemesi `$20/ay` taban bedeldir. Bu, kesin fatura garantisi değildir: etkileşimli kullanım, login/saldırı trafiği, sonraki build'ler, platformun engellediği yetkisiz trafik, krediye girmeyen ürünler, kur farkı ve vergi ayrı kalemlerdir. İlk release'te Git auto-deploy kapalıdır; önce yerel build yapılır, en fazla beş kontrollü uzak build denenir ve yeni projenin toplam build efektif maliyeti `$0,50`ye ulaşırsa kullanıcı onayı olmadan yeni uzak build başlatılmaz. Güncel Turbo build liste oranında `$0,50` yaklaşık 4 dakika 45,7 saniyedir; bu bir sonraki build'i başlatmama kapısıdır ve başlamış tek bir uzak build eşik üstüne taşabilir. Yerel ölçüm ve ilk uzak build süresi sonraki denemelerin bütçesini belirler.

Mevcut kodun hesap başına tekrarlanan vault/cache çağrıları yedi hesaplı normal soğuk çevrimde yaklaşık 95 Convex function call üretir ve doğrudan yayınlanamaz. Hosted sürüm tek batch-read ve tek batch-commit sınırına taşınır: normal çevrim en fazla 12, provider olayı/Web Push/stale-endpoint cleanup içeren çevrim en fazla 20 Convex function call kullanır. Bu sayı cron action'ın kendisini, `scheduledTime`/run kabulü için gerekli system-table `runQuery` çağrısını, gerektiğinde renewal fallback system-status read + reconciliation mutation'ını, bütün `ctx.runQuery`/`ctx.runMutation`/`ctx.runAction` çağrılarını, route'un Convex'e dönüş çağrılarını ve en fazla bir idempotent uygulama-içi retry'ı birlikte sayar. Fallback reconciliation yalnız terminal kanıtı/cancel-request ve boş slot dispatch reservation/schedule'ını yönetir; provider refresh I/O'su yapmaz. Credential renewal action/route'u ve onun önceden planlanmış terminal-checkpoint'i monitor çevriminin parçası değildir; birlikte yukarıdaki ayrı `1.200 × ≤20` tavanına sahiptir ve checkpoint provider I/O yapamaz. Monitor retry hakkı refresh POST'una devredilemez. Final stale-endpoint cleanup tek batch'tir. Aggregate snapshot sorguları, replay-reject, manuel yenileme/test ve gecikmeli işler `≤12/≤20` çevrim sınırına dahil değildir; yine de aşağıdaki deployment warning/disable sınırlarına ve takım Free hard cap'ine dahildir. Bu nedenle `9.000 × 20 = 180.000` yalnız kabul edilmiş planlı monitor trafiğinin tavanıdır, toplam aylık çağrı tahmini değildir.

Pano tarayıcıdan Convex'e doğrudan public query/subscription açmaz. Mevcut HttpOnly parola oturumunu doğrulayan tek same-origin aggregate snapshot route'u, yalnız görünürken ve `Panoyu canlı izle` açıkken en sık 60 saniyede bir çağrılır; görünür duruma dönüşte tek anlık sorgu yapar. Hidden veya kapalı her cihaz `0` periyodik snapshot isteği üretir; yenilenmeyen canlı lease en geç iki dakikada düşer. Tek aggregate snapshot operation'ı lease'i, UTC-ay toplam çağrı sayacını ve tam-cevap sayacını atomik yönetir; bu operation'ın kendisi aylık function-call muhasebesine dahildir. Aynı anda en fazla iki görünür cihaz canlı pano lease'i alabilir, UTC ayda en fazla 100.000 operation ve bunların içinde en fazla 20.000 tam snapshot kabul edilir. Sonraki cihaz/istek en fazla 256 B maliyet-koruma zarfı alıp on-focus/manuel moda düşer; on-focus veya manuel yol bu iki aylık sayacı bypass etmez. Sunucu monitorü etkilenmez.

İstemci son `knownRevision` değerini yollar. Operation önce en fazla 256 B'lık ayrı revision özet satırını okur; revision aynıysa kart dokümanlarını hiç okumadan en fazla 256 B `{ unchanged, revision }` döndürür. Revision eski/uydurmaysa ve atomik tam-cevap bütçesi varsa credential-free tam snapshot en fazla 10 KiB'dir; bütçe yoksa kart dokümanını okumadan en fazla 256 B koruma zarfı döner. Revision yalnız kart projeksiyonu gerçekten değiştiğinde ilerler. Böylece kayıp cevap, stale storage veya aynı oturumlu istemcinin keyfî revision değeri 20.000 tam cevap tavanını aşamaz. Kasıtlı kötü durumda `20.000 × 10 KiB` tam snapshot yaklaşık 195,32 MiB, `80.000 × 256 B` küçük cevap yaklaşık 19,54 MiB olur. Convex monitor action egress'i için ayrılan 64 MiB ve renewal action'ları için ayrılan 32 MiB ile toplam yaklaşık 310,86 MiB kalır ve 0,40 GB Production warning eşiğinin altında manuel/test trafiği için de pay bırakır. Böylece `VAULT_ACCESS_SECRET` veya ayrı bir browser JWT/JWKS zinciri istemciye taşınmaz. Route hesap başına sorgu yapmaz ve manuel provider yenilemesi ayrıca oran sınırlıdır.

Bir monitor çevriminin serialize edilmiş toplam Convex batch API read+write payload'ı hedef 32 KiB, sert 48 KiB'dir; ham provider cevabı saklanmaz. Bu API payload sınırı Database I/O tavanı gibi sunulmaz: Convex metriği doküman ve indeks okumalarını/yazılarını sayar; iç scan ve index maliyeti zarf boyutundan türetilemez. Preview'daki en az 1.000 fixture çevriminde platformun gerçek Database I/O read+write metriği ayrı ayrı ölçülür. Production ancak `1,30 × (9.000 × ölçülen en yüksek monitor-çevrimi I/O + 1.200 × ölçülen en yüksek complete-renewal-operation I/O + 80.000 × ölçülen en yüksek küçük snapshot-operation I/O + 20.000 × ölçülen en yüksek full-snapshot-operation I/O + ölçülen login-limiter I/O bütçesi) < 0,60 GB` koşulu sağlanırsa açılır. Renewal ölçümü dispatch/attempt sayaçları, iki-slot lease'i, action+checkpoint scheduling kimlikleri, system-status read, `attempt_started`, CAS sonucu ve fallback cleanup'ını; snapshot ölçümü atomik aylık sayaç ve lease read/write'larını; login ölçümü dağıtık sayaç/TTL cleanup yazılarını içerir. Yüzde 30 ölçüm payına rağmen Production 0,60 GB warning'e ulaşırsa canlı pano önce on-focus/manuel moda, gerekirse monitor maliyet korumasına geçer; deployment 0,75 GB'de fail-closed durur. Böylece ölçüm bir hard-bound iddiasına dönüştürülmez, ücretli plana taşma ise takım Free cap'inden önce engellenir.

Convex monitor ve renewal scheduled action'ları varsayılan 64 MiB runtime'da kalır ve hiçbir dosya düzeyinde `"use node"` içermez. Monitorün Vercel fetch'i `AbortSignal.timeout(18_000)` ile kesilir; `pingCheck` dahil hiçbir üst sarmalayıcı 20 saniyelik toplam action bütçesini veya route'un 15 saniyelik sert sınırını uzatamaz. Renewal action'ının owner-fenced fetch + cleanup toplamı en fazla 90 saniyedir ve Vercel route'unun 80 saniyelik sınırını uzatamaz. Action'lar cleanup/aggregate kaydını kalan sürede tamamlar. `9.000 × 20 saniye × 64 MiB` monitor için 3,125; `1.200 × 90 saniye × 64 MiB` renewal için 1,875; birleşik kötü durum **5,0 action GB-saat** eder. `"use node"` veya 64 MiB üstü runtime build/metadata testinde görülürse bu hesap geçersiz olur ve Trial deployu yapılmaz. Testler runtime'ı, action deadline'ını, ortak dış-I/O signal'ını, journal/commit rezervini, çağrı ve byte bütçesini kilitler.

Free kotaları takım çapında, warning/disable limitleri deployment çapındadır. Tablodaki uygulama koruması, scheduler, route ve UI'nın kendi muhasebeleştirdiği bütün Convex function çağrılarını sayar; Convex platform metriği ayrıca izlenir ve nihai takım hard cap'idir. Bu yüzden kaynak tahsisi bütün aktif deployment'ların hard limit toplamını Free takım kotasının altında tutar:

| Convex kaynak | Production warn / disable | Preview warn / disable | Dev warn / disable | Takım Free hard cap |
| --- | ---: | ---: | ---: | ---: |
| Function calls / ay | 350k / 550k | 50k / 100k | 25k / 50k | 1M |
| Action compute / ay | 6 / 8 GB-saat | 0,25 / 0,5 | 0,25 / 0,5 | 20 GB-saat |
| Database I/O / ay | 0,60 / 0,75 GB | 0,025 / 0,05 | 0,025 / 0,05 | 1 GB |
| Data egress / ay | 0,40 / 0,60 GB | 0,05 / 0,10 | 0,05 / 0,10 | 1 GB |

Preview cron yalnız kısa Preview smoke penceresinde açılır ve kartsız Trial Production candidate scheduler'ı başlamadan önce kapatılır; dev deployment'ta periyodik cron hiçbir zaman açılmaz. İlk Trial kabulünde ve sonraki release kabulünde Production monitorü ile Preview cron aynı anda çalışmaz. Böylece deployment limitleri ayrı ayrı dolmadan takım hard cap'inin bitmesi engellenir ve disable tavanlarının toplamında en az 300k call, 11 GB-saat action, 0,15 GB I/O ve 0,20 GB egress takım rezervi kalır.

Free database storage 0,5 GB takım hard cap'idir ve deployment usage-limit metriği değildir. Uygulama en fazla 12 provider hesabı, 10 push cihazı, 35 günlük idempotency/sağlık penceresi ve toplam 16 MiB uygulama-serileştirilmiş kalıcı payload sınırı kullanır; ham provider cevabı veya sınırsız olay geçmişi tutulmaz. Preview kabulünde toplam takım storage `<25 MiB` olmalıdır; 25 MiB aşılırsa Production açılmaz. Production'da toplam takım storage 50 MiB'yi aşarsa yeni hesap/cihaz/history yazıları fail-closed durur ve neden araştırılmadan yeniden açılmaz. Free sınırı ücret yazmak yerine hizmeti durdurabileceği için her warning/disable olayı panelde açık `maliyet koruması nedeniyle izleme durdu` durumu olur.

Monitor fixture/load testinde 12 hesap ve en az 1.000 deterministik çevrimle 0,5/2/5/15 saniye dağılımları, p50/p95/p99, active CPU, memory, batch call sayısı ve kısmi timeout davranışı ölçülür; rotating credential POST fixture'ı monitor sürecinde sıfır kalır. Hedef p95 `<10 saniye`, p99 `<13 saniye` ve hiçbir monitor route'unun 15 saniyeyi geçmemesidir. Renewal fault matrisi ayrı 60–65 saniyelik provider bütçesi ve 80/90 saniyelik route/action sınırlarıyla ölçülür. Yedi gerçek hesapla üç çevrim yalnız smoke testtir; kartsız Trial ilk 24 saat/288 doğal çevrimi, ardından aynı kesintisiz kabul penceresinde toplam yedi gün/2.016 çevrimi tamamlar. Bu örnekler gerçek p99 ve maliyet bandını verir; eşik aşılırsa scheduler bakım moduna alınır ve kart eklenmez.

Vercel ve Convex usage ekranları her uzak build sonrası ve yayından 24 saat, 7 gün ve 30 gün sonra yalnız yeni takım scope'unda kontrol edilir. Yeni Vercel takımında başka proje bulunmadığı için Spend Management bildirimi ve Production auto-pause açılır; bu eylem eski V2'yi durduramaz. Yeni takımın varsayılan `$200` on-demand bütçesiyle ilk deployu yapmak yasaktır. Hedef, `$20` kredi sonrasında **`$1` on-demand spend eşiği**dir. Yeni takımın Billing UI'sı `$1` eşiğini server tarafında kaydetmiyor veya auto-pause'u etkinleştirmiyorsa varsayılan/yüksek bir değeri kabul etmek yasaktır: ilk Preview deployundan önce işlem durur, platformun izin verdiği en düşük kesin eşik ve vergi etkisi kullanıcıya yeniden onaya sunulur. Spend Management periyodik ölçülen bir arka emniyettir; tam matematiksel fatura tavanı sayılmaz ve `$20` platform ücreti, vergi, seat/add-on veya başlamış çalışmayı geri almaz. How Much AI'ın kendi 9.000-monitor/1.200-renewal/deadline/batch limitleri birincil sert korumadır; herhangi bir otomatik ücretli plan yükseltmesi yasaktır.

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
| `RENEW_SECRET` | Convex renewal action–uygulama ortak sırrı; `CRON_SECRET`tan farklı |
| `LOGIN_RATE_LIMIT_SECRET` | Güvenilir istemci IP'sini ham saklamadan HMAC anahtarına çevirir |
| `VAPID_PUBLIC` | Tarayıcıya verilebilen public key |
| `VAPID_PRIVATE` | Yalnızca sunucu private key'i |
| `VAPID_SUBJECT` | Operatöre ait gerçek `mailto:` iletişim URI'si; Production'da eksik/localhost fallback yasak |
| `ENABLE_LOCAL_CONNECT=0` | Uzak sunucuda yerel CLI okumasını kesin kapatır |

Production'da `CONVEX_URL` açıkça sabitlenir; `NEXT_PUBLIC_CONVEX_URL` aynı public URL'dir. Preview'da branch başına Convex deployment URL'si build sırasında `NEXT_PUBLIC_CONVEX_URL` olarak enjekte edilir. URL secret değildir; `VAULT_ACCESS_SECRET` ve deploy key secrettır. Deploy edilmiş Node Function'ın gerçekten beklenen Preview backend'ine ulaştığı, URL'yi açıklamayan bir backend fingerprint/health çağrısıyla ispatlanır; bu kanıt olmadan branch-başına preview modeli kabul edilmez.

### Dağıtık giriş koruması

Process-local `Map` veya `globalThis` sayacı hosted koruma sayılmaz; Vercel cold/multi-isolate dağılımında her instance ayrı hak veremez. Production login route'u `VERCEL=1` ortamında yalnız Vercel'in istemci tarafından spoof edilmesini önlemek için üzerine yazdığı `x-forwarded-for` değerini (veya aynı resmi veriyi döndüren `@vercel/functions` `ipAddress(request)` yardımcısını) kabul eder. `cf-connecting-ip`, `fly-client-ip`, `x-real-ip`, kullanıcının verdiği başka forwarding header'ları ve genel `TRUST_PROXY_IP_HEADERS` modu hosted akışta tamamen yok sayılır. Güvenilir header eksik, çoklu veya canonical IPv4/IPv6'ya çevrilemezse Production parola karşılaştırmasına geçmeden genel hata ile fail-closed kapanır. Yerel test yalnız açık `ALLOW_LOCAL_AUTH_TEST=1` ve loopback fixture'ında çalışır; bu değer Preview/Production'da `0` olmak zorundadır.

Canonical IP, Vercel'de yalnız `HMAC-SHA256(LOGIN_RATE_LIMIT_SECRET, canonicalIp)` ile opak anahtara çevrilir; ham IP Convex'e, loga veya cevaba gitmez. **Parola karşılaştırmasından önce** Convex'teki tek atomik mutation 15 dakikalık kayan pencerede IP anahtarı başına en fazla 5, deployment genelinde en fazla 50 login attempt rezervi verir. Mutation deny dönerse veya Convex hata/timeout verirse parola karşılaştırması sıfır kez çalışır; uygun `429/503` genel cevabı verilir ve process-local fallback yoktur. IP limiti aşılırsa 30 dakika, global limit aşılırsa 15 dakika yeni login reddedilir; mevcut HttpOnly oturumlar çalışmaya devam eder. Global cap doluyken yeni IP anahtarı için row yaratılmaz; böylece saldırgan cardinality'yi sınırsız büyütemez. Başarılı giriş yalnız kendi IP kovasını temizleyebilir, global saldırı sayacını silemez. Bütün cevaplar parola var/yok ve hangi limitin dolduğu ayrımını açığa çıkarmayan aynı genel metin ve uygun sabit-zamanlı parola kontrolü kullanır. TTL cleanup, sayaç/lease I/O'su ve her kabul/reddin function-call muhasebesi deployment limitlerine dahildir.

Bu dağıtık sayaç brute-force hakkını instance'lar arasında gerçekten birleştirir; sınırsız saldırı trafiği için matematiksel bulut-maliyet garantisi vermez. Vercel'in platform DDoS/Spend koruması savunma katmanıdır; ücretli WAF/add-on bu sürüme sessizce eklenmez. Preview'da farklı cold instance'lara ve spoof header varyantlarına yayılan eşzamanlı test geçmeden Production açılmaz. Resmî header davranışı: [Vercel request headers](https://examples.vercel.com/docs/headers/request-headers).

### Convex Production ortamı

| Değişken | Rol |
| --- | --- |
| `VAULT_ACCESS_SECRET` | Vercel'deki değerle aynı backend erişim sırrı |
| `APP_URL` | Cron'un çağıracağı Vercel origin'i |
| `CRON_SECRET` | Vercel'deki değerle aynı cron sırrı |
| `RENEW_SECRET` | Vercel'deki değerle aynı, cron sırrından bağımsız renewal sırrı |
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
- Her key oluşturulduğunda secret'ın kendisi değil SHA-256 fingerprint'i, platformun gösterdiği team/project/deployment hedef metadata'sıyla release manifestine bağlanır; build başlamadan wrapper bu bağı yeniden doğrular.
- `CONVEX_DEPLOYMENT`, kişisel/team-geneli token veya hedefi manifestle eşleşmeyen `CONVEX_DEPLOY_KEY` build ortamında bulunursa `npx convex deploy` çağrılmadan build fail-closed kapanır.
- Deploy key işten çıkarma, sızıntı veya pipeline değişiminde açıkça revoke edilir; rol değişikliği tek başına anahtarı iptal etmiş sayılmaz.
- Preview deployment yaratılmadan önce Convex project defaults içinde Preview'a özgü `VAULT_ACCESS_SECRET`, `CRON_SECRET`, `RENEW_SECRET` ve sabit preview `APP_URL` hazırlanır. Defaults yalnız yeni deployment'a kopyalandığından sonraki değişiklikte mevcut Preview backend açıkça güncellenir veya güvenle yeniden oluşturulur.
- Build, Convex typecheck/codegen/schema/function deploy ve Next production build adımlarından biri başarısızsa Vercel deployment'ı yayımlamaz.

Authenticated health cevabı yalnız Git SHA, storage türü, beklenen backend fingerprint'inin kısa özeti ve bildirim yapılandırma boolean'larını verir; URL, secret, endpoint, hesap veya environment değeri vermez.

### Secret oluşturma ve aktarım

- Rastgele makine secret'ları kriptografik üreticiyle oluşturulur; terminal çıktısına veya sohbet mesajına basılmaz.
- `APP_PASSWORD` kullanıcı tarafından seçilir/güvenli biçimde girilir; repoya veya dokümana yazılmaz.
- Vercel/Convex ortamına değerler etkileşimli/gizli girişle eklenir; shell history'ye düz metin düşürülmez.
- Preview ve Production en azından kasa/oturum/backend/cron secret'larında farklı değerler kullanır.
- `.env*`, `.data`, deploy logu ve build çıktısı secret taramasından geçer.

`APP_PASSWORD`, `AUTH_SECRET`, `VAULT_ENCRYPTION_SECRET`, `VAULT_ACCESS_SECRET`, `CRON_SECRET`, `RENEW_SECRET`, `LOGIN_RATE_LIMIT_SECRET`, `VAPID_PRIVATE` ve Preview/Production `CONVEX_DEPLOY_KEY` değerleri Vercel'de **proje düzeyinde Sensitive** olarak saklanır; takım-shared olmaz. `APP_URL`, `CONVEX_URL`, `NEXT_PUBLIC_CONVEX_URL`, `VAPID_PUBLIC` ve `VAPID_SUBJECT` public yapılandırmadır fakat yine yalnız bu projeye aittir. Preview değerleri yalnız release branch Preview environment'ına, Production değerleri yalnız Production'a scoped olur; iki ortamın `APP_PASSWORD` değerleri de kesinlikle farklıdır. Production `VAPID_SUBJECT` eksik, geçersiz veya `localhost` ise server notification modülü import/send öncesi fail-closed olur; geliştirme fallback'i Production bundle davranışı olamaz.

E-posta tabanlı parola sıfırlama yoktur. `APP_PASSWORD` unutulursa Vercel ortamında yeni değer atanır; bağımsız `VAULT_ENCRYPTION_SECRET` korunduğu için kasa yeniden şifrelenmeden okunmaya devam eder. Yalnız parola değişimi mevcut oturum çerezlerini mutlaka iptal etmez; kayıp/ele geçirilmiş cihaz olayında `APP_PASSWORD` ile birlikte `AUTH_SECRET` de rotate edilir.

Ortak `VAULT_ACCESS_SECRET`, `CRON_SECRET` veya `RENEW_SECRET` rotasyonu iki platformda koordineli bakım penceresidir: monitor ve renewal scheduler'ları duraklatılır, başlamış `attempt_started` renewal işleri başarı/unknown terminaline alınır, Convex ve Vercel değerleri kontrollü sırayla değiştirilir, güncel env ile yeni staged deployment build edilir, health testi geçer ve scheduler'lar yeniden açılır. Kısa aralık fail-closed olabilir; eski ve yeni secret'ı uzun süre birlikte kabul eden gizli grace yolu eklenmez. `LOGIN_RATE_LIMIT_SECRET` rotasyonunda yeni loginler bakım modunda reddedilir, mevcut oturumlar açık kalır, deployment-global sayaç korunur; yeni HMAC anahtarıyla deploy tamamlanınca eski opak IP kovaları yalnız TTL ile düşer ve yeni login açılır. Bu secret için de çift-anahtar grace yoktur. `APP_PASSWORD` dahil herhangi bir runtime secret rotasyonu yeni Vercel build gerektirir. Vercel env değişiklikleri eski deployment byte/config snapshot'ına uygulanmadığından önceki env sürümündeki deployment'lar instant-rollback için uygunsuz işaretlenir.

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

Hiçbir bulut kaynağı oluşturmadan zorunlu sıra:

1. 12 hesap × en az 1.000 deterministik monitor çevrimi; max-4 concurrency, dönen imleç/fairness, 11,5/13/15 saniye sınırları, kısmi sonuç ve `≤12/≤20` Convex boundary sayacı;
2. renewal state-machine testleri: exact `ceil(44.640/460)=98/lineage`, `1.176/12 hesap` doğal proaktif projeksiyonu; global UTC-ay/exact rolling için 1.199/1.200/1.201 ve lineage UTC-ay/exact rolling için 99/100/101; iki lineage sayaç izolasyonu, reconnect'in aynı lineage'ı koruması, remove→re-add tombstone'un 100 bütçesini sıfırlamaması ve bütün lineage'ların globali paylaşması; queue-admission mutation'ında `reservation + dispatch_started + slotEpoch + scheduledFunctionId + action schedule`, action-start mutation'ında exact tuple CAS + `actionStartedAt + reconcileFunctionId + checkpoint schedule` atomikliği; reservation/CAS'siz scheduled action/checkpoint/provider-I/O=0 ve scheduled-action execution≤dispatch reservation≤1.200/global, ≤100/lineage; stale checkpoint/fallback exact tuple mismatch'inde write/schedule=0; reconcile ID varken Pending/kanıtsız checkpoint için fallback handoff=0, checkpoint cancel-request sonrası scheduled-mutation terminal kanıtından önce handoff=0 ve fallback-advanced epoch'e geç kalan checkpoint'in write/schedule=0 olması; action-start→Vercel-fetch crash dahil aynı `dispatchId` için scheduled action≤1 ve Vercel invocation≤1, aynı `credentialGeneration` için provider POST≤1; yalnız imzalı/owner-fenced `attempt_started=false, providerPostCount=0` preflight'ın yeni kota tüketen ikinci dispatch'e izin vermesi ve crash/timeout/transport/ack-yok durumunun vermemesi; action'ın hiç başlamaması, `actionStartedAt` kaydından önce fail/cancel olması ve gecikmiş handler–checkpoint/fallback yarışı; `Pending/InProgress` sistem durumunda o slotta ardıl=0; genel `Canceled` handoff=0; 12 dakikalık Pending cancel mutation'ında exact tuple + null start/false attempt + `canceled_before_start` fence ve Pending→InProgress yarışının cancel-first/start-first iki commit sırası; yalnız sonraki system Canceled+fence kanıtından sonra handoff; iki global slotta aynı lineage'ın çift admission=0; action/checkpoint schedule lag'lerinin her biri≤5 saniye olan sağlıklı 12-job burst'te son başlangıç `<9 dakika`, son terminal/oldest-queue-age `<10 dakika 30 saniye`, normal scheduled execution≤5, çift cancel-race geçişinde≤7, provider/Vercel I/O concurrency≤2 ve monitor lag `<12 dakika`; expiry≤20 dakika proaktif admission'ın beş-dakika cadence'iyle 15–20 dakika bandında kuyruğa girmesi ve sağlıklı burst'te token expiry'den önce bitmesi; `attempt_started` sonrası ikinci POST=0, `5xx`/timeout/malformed/missing-replacement/worker-crash → `renewal_unknown`, encrypted recovery journal → main-vault CAS; legacy vault generation migration/round-trip, connect/reconnect/manual/refresh/remove→re-add generation değişimi, browser-supplied/reused generation reddi ve concurrent stale adoption'ın newer generation overwrite=0 davranışı;
3. dağıtık login limiter testleri: aynı IP ve 50 farklı IP, eşzamanlı cold-instance fixture'ları, spoof header'ların yok sayılması, Production'da eksik Vercel header'ının fail-closed olması, TTL ve ham IP/PII loglanmaması;
4. PWA statik kontratı, responsive/görsel/erişilebilirlik matrisi, service-worker payload/click ve doğrudan gesture-bound subscribe sırası;
5. canary e-posta/token/push-endpoint ile cron JSON, Convex/Vercel log ve error-body sızıntı testi; Production `VAPID_SUBJECT` localhost/eksik fixture'ının fail-closed olması;
6. `npm test`, `npm run typecheck`, production build, secret/vault trace ve production bundle kontrolleri;
7. nested worktree root/NFT trace uyarısı olmadan temiz standalone checkout build'i veya açık doğru `turbopack.root` ile warning-free eşdeğer build.

Mevcut başlangıç testinde çalışan eski yerel uygulama `127.0.0.1:37645` portunu tuttuğu için üç runtime-immutability testi `service-port-in-use` ile başarısız olmuştur; 735/738 test geçmiştir. Final tam doğrulamada kullanıcı oturumu korunarak eski runtime kontrollü biçimde durdurulur ve bu üç test yeniden çalıştırılır; **738/738** olmadan “tam yeşil” denmez. Mevcut typecheck/build geçişi yalnız baseline'dır; nested-worktree Turbopack root/NFT trace uyarısı çözülmeden Trial build'i başlatılmaz.

### 2. Ayrı kartsız Trial ve Preview altyapısı

- bütün yerel kapılar geçtikten sonra, mutasyon anında kullanıcıdan ayrıca onay alınır; `Pro Trial` seçeneği ve resmî koşullar tekrar okunur, yeni tek üyeli takım **kart/ödeme yöntemi eklenmeden** oluşturulur; Trial görünmüyorsa veya kart otomatik taşınıyorsa işlem durur;
- eski V2 takımından farklı team ID zorunluluğu ve secretsiz baseline manifesti geçtikten sonra `how-much-ai-private` Vercel projesi yalnız yeni Trial takımında oluşturulur ve project/org ID guard'ı sabitlenir;
- ayrı bir eylem onayıyla önce yalnız yeni tek üyeli Convex **Free** takımı oluşturulur ve team ID'nin eski takımdan farklılığı doğrulanır; sonra EU West `how-much-ai-private` project create işlemi açıkça bu doğrulanmış team ID/slug'ına scope edilir ve dönen parent-team/project ID doğrulanır; Convex'e kart eklenmez ve plan yükseltilmez;
- yeni takımda başka Vercel/Convex projesi, shared environment, integration/resource veya ücretli eklenti bulunmadığı doğrulanır;
- ilk deploydan önce yeni Vercel takımında `$1` post-credit Spend Management değeri yazılır, Production auto-pause açılır, sayfa yenilendikten sonra `$1` ve toggle'ın kalıcı olduğu ve Activity kaydının doğru takımda oluştuğu doğrulanır. Önceki eski takımda yapılan **kaydedilmemiş** `$1` UI probe'u kanıt sayılmaz. Server `$1` değerini reddederse hiçbir deploy yapılmaz ve kullanıcıya platformun gerçek minimumu sunulur;
- release branch için Preview deploy key Vercel'in yalnız Preview/release-branch ortamına Sensitive olarak eklenir;
- Preview Convex defaults ve Vercel Preview ortamına birbirinden/Production'dan bağımsız secret'lar eklenir;
- deployment değişse de aynı kalan, yalnız bu proje için bir Vercel preview alias'ı ayrılır;
- Preview Convex ve Vercel `APP_URL` değerleri tam bu sabit HTTPS origin'ine ayarlanır;
- Vercel Authentication/Standard Protection Preview'da kapalıdır; gerçek iPhone PWA, public manifest/service worker ve Convex cron yalnız uygulamanın kendi zorunlu parolasıyla test edilir;
- aynı release branch yeniden deploy edildiğinde aynı Convex Preview backend adı kullanılır; başka branch Preview'ları bu kabul verisini paylaşmaz.

Preview üretim verisi veya üretim secret'ı kullanmaz. Preview backend URL'sinin deploy edilmiş Node Function içinde doğru kaldığı fingerprint testi geçmezse branch-başına model terk edilir ve ayrı tasarımla tek sabit staging backend'e dönülür; yanlış backend'e sessiz fallback yapılmaz. Trial scheduler'ları ilk deployda kapalıdır; statik/auth/target smoke geçmeden doğal monitor veya renewal işi başlatılmaz.

### 3. Kartsız Trial kabulü

Trial kaynaklarının yüzde 70'i fail-closed güvenlik sınırıdır: **5,6 active CPU-saat, 504 provisioned-memory GB-saat, 700.000 invocation ve `$14` Trial kredisi**. Her build ve test diliminden sonra yalnız yeni takım Usage ekranı okunur. Eşiklerden biri yüzde 70'e ulaşırsa monitor/renewal durur, kart eklenmez ve test başarısız sayılır. Trial'ın hard pause'una güvenilmez.

Preview smoke geçince, hâlâ kart eklenmemiş Trial takımında Production secret'ları ve yalnız yeni Convex Production deployment'ı hazırlanır. Exact kabul SHA'sı `vercel deploy --prod --skip-domain` ile staged build edilir, health/target smoke geçince bir kez promote edilerek **nihai Vercel production origin'i** sabitlenir. Bu “Trial Production candidate” ücretli abonelik satın almak değildir; Trial'ın Production yetenekleriyle gerçek son origin'i ödeme öncesi kanıtlar. Fiziksel cihaz kabulü yalnız bu origin, final manifest ID, final service-worker scope ve final VAPID public key ile yapılır. Bunlardan biri daha sonra değişirse ilgili yedi-günlük/push kabulü yeniden gerekir.

İlk 24 saat, zorunlu yedi ardışık günlük kabulün ilk günüdür; ayrıca sekizinci gün diye sayılmaz. Trial Production candidate en az **7 gün / 2.016 doğal beş-dakika çevrimi** çalışır. Bu süre yüzde 70 kapısını aşmadan tamamlanamıyorsa ücretli plana geçilmez; performans/maliyet yeniden tasarlanır. Yerel 1.200-renewal load testi Trial'da tekrarlanmaz; en az her provider türünde bir gerçek güvenli renewal ve kalan fault/crash matrisi yerel deterministic testlerle doğrulanır.

Gerçek cihazlarda:

- Windows 27 inç 4K, 2560 × 1440 CSS eşdeğeri ve 3840 × 2160;
- iPhone 17 Pro Max dikey/yatay;
- parola giriş/çıkış ve oturum süresi;
- farklı cold instance'lara dağılan login limiter ve spoof header testleri;
- hesap ekleme, yenileme, sıralama ve yeniden bağlama;
- Ana Ekran'a kurulum;
- fiziksel iPhone'da PWA App Switcher'dan tamamen kapalı ve telefon kilitliyken test push; reboot sonrası bir kez kilit açılıp PWA yeniden açılmadan ikinci locked push; Focus kapalı ve How Much AI'a izin veren ayrı Focus profili;
- test endpoint'i dışında gerçek provider usage cevabından üretilen en az bir monitor eşik olayı, durable journal, push-service kabulü, cihazda görünür bildirim ve notification tap zinciri;
- bildirime dokununca yalnız exact `APP_URL` kökünün açılması ve oturum bittiyse parola ekranına gidilmesi;
- en az her gerçek provider türünde bir rotating credential renewal; replacement'ın encrypted recovery journal ve generation fence üzerinden ana kasaya geçmesi, sonraki monitor çevriminin yeni access token ile başarılı olması;
- bir renewal dış I/O'su kontrollü yavaşken monitorün ve başka hesabın gerçek olayının 12 dakikalık gecikme eşiğine düşmemesi;
- cihaz/izleme/gönderim durumları;
- beş dakikalık cron ve gecikme metni;
- kilit ekranı gizli bildirim gövdesi;
- Vercel/Convex loglarında canary e-posta, secret, hesap kimliği, endpoint veya ham response body bulunmaması;
- bir yetkili monitor ve renewal isteğinin ayrı ayrı `0 Routing Middleware + 1 Function` üretmesi; gerçek duration/CPU/memory/FOT/Convex I/O/call metriklerinin şartnamedeki projeksiyonu karşılaması.

Kabul kaydı Git SHA, Vercel Production deployment URL/ID ve final origin, önceki Preview alias, Convex Preview/Production deployment adları/fingerprint'leri, yedi günlük metrik özeti, scheduler/renewal generation ve push-service/cihaz gözlem zamanlarını içerir; secret içermez. Manifest ID, service-worker scope, origin veya VAPID public key bundan sonra değişirse bütün fiziksel push kabulü tekrarlanır. Satın alma işlemi yeni build, env değişimi veya domain cutover yapmaz; kabul edilmiş exact deployment olduğu yerde kalır.

### 4. Ayrı satın alma onayı ve Production

1. Trial kabul raporu, gerçekleşen kullanım, kalan kredi payı ve hâlâ garanti edilemeyen provider/Web Push riskleri kullanıcıya gösterilir. Checkout'taki `$20/ay` subtotal, kesin vergi/toplam, ilk tahsilat/yenileme tarihi, tek deploying seat ve sıfır add-on aynı anda görünmeden satın alma istenmez.
2. Kullanıcı bu ekranda açıkça onay verirse kart eklenir ve aynı izole Trial takımı Pro'ya çevrilir; onay yoksa kart eklenmez, Trial sonundan önce monitor/renewal scheduler'ları kapatılır ve takımın ücret oluşturmadan Hobby'ye dönmesine izin verilir.
3. Kart ekleme/Pro dönüşümü kabul edilmiş Trial Production deployment'ının code, env, domain, manifest, VAPID veya Convex hedefini değiştirmez. Dönüşüm sonrası aynı origin'de authenticated health, scheduler, bir test push ve Billing/Usage scope'u tekrar okunur; herhangi bir farkta scheduler durur ve ilgili kabul tekrarlanır.
4. Provider hesapları Trial Production kasasına yalnız desteklenen giriş akışlarıyla zaten yeniden bağlanmıştır; Preview kasası hiçbir zaman taşınmaz.

Sonraki her kod yayını ayrı Preview kabulünden geçer. İlk boş kurulumdan sonraki her yayında Convex manuel backup alınır; mevcut Vercel production deployment ID/SHA'sı, backend fingerprint'i ve env sürümü release kaydına yazılır. Exact kabul SHA'sından `vercel deploy --prod --skip-domain` ile staged Production build başlatılır; değişmez staged URL'de authenticated health ve temel API smoke geçince bir kez promote edilir. Build Command geriye uyumlu Convex code/schema'yı deploy eder; mevcut production uygulaması backend geçişi sırasında çalışabilmelidir. Cutover sonrasında cron, renewal ve push smoke testleri tekrarlanır.

## Rollback ve kurtarma

- Her release kaydı Vercel deployment ID/URL, Git SHA, backend fingerprint ve env sürümünü eşler. Daha önce production olmuş sürüme geri dönüş `vercel rollback <deployment-id-or-url>` ile yapılır; daha önce promoted deployment tekrar promote edilmeye çalışılmaz.
- Instant Rollback rebuild yapmaz ve trafiği hedef eski deployment'ın build anındaki env/config snapshot'ına döndürür; aktif Vercel Cron Jobs tanımları rollback ile güncellenmez. Bu projede scheduler Convex olduğu için Vercel Cron Jobs listesi zaten boş olmak zorundadır. Convex backend kodu/şeması/cron'u da Vercel rollback ile geri alınmaz. Bu yüzden yalnız güncel Convex backend ile uyumlu ve aynı geçerli env sürümünü kullanan kayıt “rollback-uygun” olabilir.
- Vercel rollback sonrası production-domain auto-assignment kapanır. Hizmet doğrulandıktan sonra düzeltilmiş yeni staged deployment promote edilerek normal akış yeniden açılır.
- Her `APP_PASSWORD`, `AUTH_SECRET`, `VAULT_ACCESS_SECRET`, `CRON_SECRET`, `RENEW_SECRET`, `LOGIN_RATE_LIMIT_SECRET`, `VAPID_PRIVATE` veya encryption-key rotasyonundan önceki deployment'lar rollback-uygunsuz işaretlenir. Geri dönüş gerekirse bilinen iyi Git SHA **güncel** secret'larla yeniden build edilip staged olarak doğrulanır.
- Convex schema/function değişiklikleri bir önceki uygulamayla geriye uyumlu ve eklemeli olmak zorundadır; veri silen migration yoktur. Uyum ispatlanamıyorsa staged production build başlatılmaz.
- İlk boş yayın hariç her Production backend değişikliğinden önce manuel Convex backup alınır. Backup'ın tablo/dosya verisini içerdiği; kod, environment ve scheduled function tanımını içermediği release kaydında belirtilir. Platformun mevcut yedi günlük manuel-backup saklama süresi kayda yazılır ve bu pencere dolmadan restore seçeneği doğrulanır.
- `VAULT_ENCRYPTION_SECRET` backup'tan ayrı, kullanıcının parola yöneticisinde saklanır. Bu değer yoksa encrypted vault backup tek başına kullanılamaz. Kasa okunamıyorsa veri sessizce sıfırlanmaz; doğru secret geri yüklenir veya hesaplar kontrollü biçimde yeniden bağlanır.
- VAPID key'i değişirse eski cihaz abonelikleri uyumsuz olarak tanınır ve kullanıcı açık onarma akışıyla yeniden abone olur.

## Operasyon ve gözlemlenebilirlik

İlk 30 gün için kontrol noktaları:

- Vercel function çağrısı, cron p50/p95/p99 süresi, provisioned memory, active CPU, bant genişliği ve hata oranı;
- Convex function/database/bandwidth/cron kullanımı;
- cron'un son başarılı/kısmi/başarısız zamanı;
- renewal kuyruğunun en yaşlı işi, iki slotun durumu, son action başlangıç/terminal zamanı ve terminal-checkpoint/fallback sonucu;
- provider bazında hata sınıfı, hassas olmayan sayı olarak;
- geçersiz push aboneliği temizleme oranı;
- bildirim testinin cihaz başına oran sınırı.

Her release/rotasyon kaydı deploy key'lerin geçerli kapsamını ve eski anahtarın revoke edilip edilmediğini de kontrol eder. Release kayıtları secret değil operasyonel kimlik taşır ve repoya kişisel takım/kullanıcı adı yazmaz.

Analitik SDK veya kullanıcı davranışı izleme eklenmez. Gerekli sağlık bilgisi uygulama/Convex operasyon kayıtlarından ve bildirim panelindeki asgari durumdan gelir. E-posta, token, push endpoint'i ve ham provider yanıtı loglanmaz.

## Test ve kabul kapıları

Yayın ancak şu koşullar birlikte sağlanırsa tamamlanmış sayılır:

- repository test, typecheck ve production build tamamen yeşil; eski runtime kontrollü kapatıldıktan sonra **738/738** test geçiyor;
- clean standalone checkout veya açık doğru `turbopack.root` ile nested-worktree/NFT trace uyarısı olmayan production build alınıyor;
- görünen ürün adının `How Much AI — Özel PWA` olduğu, takım/proje/arayüzde yeni ürün için `V2` kullanılmadığı ve ilk girişte ayrı kasa/otomatik taşıma yokluğu açıklandığı;
- geçici `codex/hma-web-v2` çalışma etiketinin implementasyon başlamadan nötr yeni-ürün adına taşındığı ve eski V2 worktree/repository'sinin hedef alınmadığı;
- yeni Vercel ve Convex team ID'lerinin eski V2 team ID'lerinden farklı olduğu; Convex team doğrulanmadan project create çağrısının çalışmadığı ve yeni project parent-team ID'sinin doğrulanmış yeni team ID olduğu; secretsiz baseline manifestindeki eski Git/deployment/domain/environment adı-scope/integration/resource/Spend Management/Convex kimliklerinin yayın sonrasında değişmediği;
- eski, yanlış veya kayıtsız Convex deploy key fixture'ının wrapper tarafından `npx convex deploy` alt süreci başlamadan reddedildiği; Preview/Production key fingerprint–hedef bağlarının beklenen yeni team/project/deployment ID'leriyle eşleştiği ve ambient `CONVEX_DEPLOYMENT`/geniş kişisel token bulunmadığı;
- Trial sırasında yeni Vercel takımında ödeme yöntemi bulunmadığı, ayrı `$20` Trial kredisi, tek deployer ve yalnız How Much AI projesi bulunduğu; yeni Convex takımının kart/upgrade olmadan ayrı EU West Free kota havuzunda kaldığı;
- yalnız Trial kabulünden ve exact checkout `$20` subtotal + vergi/toplam + ilk tahsilat/yenileme tarihi + tek seat + sıfır add-on gösteriminden sonra kullanıcının ayrı satın alma onayı verdiği; onaydan önce kart veya ücretli Pro mutasyonu olmadığı;
- yeni takımda linked shared environment, team integration/resource, ücretli add-on veya Vercel Cron Job bulunmadığı;
- `$1` post-credit Spend Management + auto-pause değerinin yeni Trial takımında server tarafından kaydedildiği, reload ve Activity kaydıyla kalıcı doğrulandığı; desteklenmiyorsa hiçbir Preview/Production deployu yapılmadan exact alt sınır için yeniden onay alındığı;
- Vercel build local dosya backend'ine düşmüyor ve tam Convex yapılandırmasıyla açılıyor;
- Preview ve Production'ın farklı Sensitive deploy key kullandığı, Preview key'in yalnız branch preview ve Production key'in yalnız `deployment:deploy` yetkisi taşıdığı;
- accepted Preview ile kartsız Trial Production candidate'ın aynı exact Git SHA'dan geldiği, health fingerprint'in doğru backend'i doğruladığı ve satın alma sırasında code/env/domain/manifest/VAPID/Convex hedefinin değişmediği;
- eksik/yarım Convex yapılandırması fail-closed;
- `APP_PASSWORD` olmadan hiçbir geliştirme/üretim modu açık erişime geçmiyor;
- ana ve görev-özel secret'ların bağımsızlık/uzunluk kontrolleri geçiyor; Production'da blank/whitespace, invalid/non-`mailto:`, localhost veya kısmi `VAPID_PUBLIC`/`VAPID_PRIVATE`/`VAPID_SUBJECT` üçlüsü fail-closed ve private key health/JSON/logda görünmüyor;
- login limiter'ın güvenilir yalnız-Vercel IP kaynağını kullandığı, spoofable `cf/fly/x-real` header'larını yok saydığı, ham IP saklamadığı ve cold/multi-instance eşzamanlı fixture'larında atomik 5-IP/50-global limitlerini koruduğu;
- `ENABLE_LOCAL_CONNECT=0` altında uzak sunucu yerel CLI credential okumuyor;
- PWA manifest/icon yolları login redirect'i almıyor, diğer özel yollar alıyor;
- monitor yalnız doğru `CRON_SECRET`, renewal yalnız doğru ve bağımsız `RENEW_SECRET` ile çalışıyor; geçersiz method/path/query/host/body/secret provider ve Convex'e sıfır çağrı yapıyor ve beş dakikalık schedule deploy edilmiş;
- exact monitor ve renewal yollarının `proxy.ts` matcher'ından çıktığı, route'ların proxy fail-closed kontrollerini kendi içinde yaptığı ve birer yetkili isteğin ayrı ayrı `0 Routing Middleware + 1 Function` ürettiği;
- cron route'un `dub1`, 2 GB Standard, 15 saniye azami süre, 13 saniyelik iç deadline, ortak dış-I/O abort'u ve 1,5 saniyelik journal/commit rezerviyle p95/p99 bütçesini karşıladığı;
- UTC-ay sayacının 9.000 planlı monitor çevrimini aşmadığı; unique/fresh beş-dakika `scheduledTime` invariantının herhangi 31×24 saatte ≤8.928 ve 30 günde ≤8.640 run tuttuğu, yinelenen/eski run'ı provider'a göndermediği ve brüt monitor tavanı hesabının doğrulandığı;
- monitorün rotating credential POST'u yapmadığı; expiry≤20 dakika/401'in yalnız tek `(accountId, server-owned credentialGeneration)` DB queue işi açtığı; generation'ın browser'dan kabul edilmediği/yeniden kullanılmadığı ve connect/reconnect/manual/refresh/remove→re-add yollarında değiştiği; legacy migration/round-trip ile korunduğu; exact `98/lineage` ve `1.176/12 hesap` doğal projeksiyonunun, global 1.199/1.200/1.201 ile iki lineage'da ayrı 99/100/101 UTC/rolling testlerinin geçtiği, reconnect/remove→re-add'in lineage bütçesini sıfırlamadığı ve globali bypass etmediği; queue-admission `reservation+dispatch_started+slotEpoch+scheduledFunctionId`, action-start exact tuple CAS + actual-start-bound `reconcileFunctionId/checkpoint` atomikliğinin geçtiği; reservation/CAS'siz action/checkpoint/provider-I/O=0 ve scheduled-action execution≤dispatch≤1.200/global/100-lineage olduğu; stale checkpoint/fallback tuple mismatch'inin write/schedule=0 kaldığı; aynı `dispatchId` için action/invocation≤1 ve aynı generation için provider POST≤1 kaldığı; yalnız kanıtlı preflight `POST=0` sonucunun yeni kotalı dispatch açabildiği, ambiguity'nin açamadığı; genel `Canceled` handoff=0, yalnız exact cancel-fence/null-start/false-attempt/system-Canceled kanıtının handoff açtığı ve Pending→InProgress cancel yarışının iki commit sırasının güvenli olduğu; iki-slot dispatcher'ın schedule lag≤5 saniye zarfında 12-job burst son başlangıcını <9 dakika, son terminal/oldest queue age'i <10 dakika 30 saniye, normal scheduled execution≤5, çift cancel-race geçişini≤7, provider/Vercel I/O concurrency'yi≤2 ve monitor lag'ini <12 dakika tuttuğu;
- renewal crash matriksinde `attempt_started` sonrası send öncesi, body-send sonrası response öncesi, response sonrası journal öncesi ve encrypted-journal sonrası finalization öncesi crash; 3xx redirect-follow=0, timeout, `5xx`, sözleşmeyle pre-consumption kanıtlanmayan `429`, malformed/partial/eksik replacement ve stale/reconnect generation için aynı credential generation'a gönderilen ikinci POST sayısının **0** olduğu; committed journalın watchdog tarafından POST'suz finalize edildiği, newer credential overwrite=0 ve kanıtsız sonucun `renewal_unknown` olduğu;
- renewal route'un `dub1`, 2 GB/1 vCPU, 80 saniye hard duration, ilk 5 saniyede POST (`t>5` yeni POST=0), 60–65 saniye provider timeout, provider abort≤70, route response<80 ve action cleanup<90 bütçesini karşıladığı; son bölümde yalnız owner-fenced journal/finalization I/O'su ve aylık agregat FOT'un 96 MiB'yi aşmadığı;
- Convex'in EU West Free planda kaldığı, monitor ve renewal action'larının 64 MiB varsayılan runtime kullandığı ve `"use node"` içermediği; `pingCheck`in 20, renewal action'ın 90 saniyeyi aşmadığı; scheduled renewal action execution≤dispatch≤1.200 olduğu ve renewal action compute'un 1,875 GB-saat tavanını aşmadığı; normal/olaylı monitorün 12/20 ve renewal dispatch'in 20 function call bütçesini aşmadığı;
- aggregate snapshot operation'ının iki canlı cihaz/100.000 aylık toplam/20.000 aylık tam-cevap sayacını atomik koruduğu, keyfî stale revision ile aşılamadığı, 256 B revision/unchanged ve 10 KiB full-response sınırlarını tuttuğu; egress ve database-I/O kötü-durum hesaplarının Preview platform metriğiyle doğrulandığı;
- ilk yayın uzak build sayısı/`$0,50` (~4:45,7 Turbo build) kapısının, yetkili monitor `$7,39`, renewal `$5,23` ve birleşik `$13,12` kredi-öncesi projeksiyonunun gerçek Usage metriğiyle doğrulandığı; ücretli eklenti olmadığı;
- `tr-TR`/ISO UTC kontratının Istanbul, UTC gece yarısı ve DST kullanan ikinci saat diliminde aynı anı doğru gösterdiği;
- kartsız Trial'ın ilk gün dahil yedi ardışık gün/2.016 doğal çevrimi tamamladığı; 5,6 CPU-saat, 504 memory GB-saat, 700k invocation veya `$14` Trial kredisi yüzde-70 kapılarından hiçbirine ulaşmadığı;
- fiziksel iPhone 17 Pro Max'te standalone gesture izni, foreground, tamamen kapalı PWA + kilitli telefon, reboot sonrası PWA yeniden açılmadan locked push, Focus-allow profili, gerçek monitor olayı ve notification-tap testleri; ayrıca Windows push testi geçtiği;
- canary PII/secret taramasında Vercel/Convex logu, cron JSON'u ve hata gövdesinde e-posta, account label/id, token, endpoint, ham provider cevabı veya raw exception/cause bulunmadığı; cron safe body'nin yalnız counts + opak errorId + allowlisted class/code taşıdığı;
- Vercel/Convex usage ekranında beklenmeyen ücretli kaynak veya otomatik plan yükseltmesi yok;
- Vercel/Convex rol denetimi güven modelini karşılıyor, projeler EU West/`dub1` kararına uyuyor;
- yeni linkin exact project/org ID'si doğrulanmış ve eski V2'nin ayarı, deployment'ı, domain'i, environment **adları/scope'ları**, integration/resource bağlantıları, Spend Management ayarı ve Convex kimlikleri değişmemiş;
- rollback runbook'u rollback-uygun ve secret-rotasyonu sonrası uygunsuz fixture'larla doğrulanmış.

## Başarı ölçütü

Kullanıcı Windows veya iPhone'da terminal açmadan yeni How Much AI HTTPS adresine gider, zorunlu parola ile giriş yapar, PWA'yı kurar ve uygulama kapalıyken kullanım uyarısı alır. Satın alma öncesinde bu söz kartsız ayrı Trial, yedi günlük gerçek ritim ve fiziksel iPhone ile doğrulanır. Kullanıcı exact checkout toplamını ayrıca onaylarsa yeni uygulama aynı kullanıcı hesabı/kartla ödenen fakat eski V2'den ayrı kredisi, kullanım limiti, Spend Management eylemi, Vercel takımı ve Convex Free takımı olan tek-kiracılı bir kuruluma dönüşür. Eski V2'nin team/project/domain/env/integration/deployment/veri durumu değişmez. Güncel sabit artış vergi ve kur hariç `$20/ay`dır; tanımlı yetkili monitor + renewal + build kötü-durum bütçesi kredi öncesi yaklaşık `$13,12`dir ve gerçek kullanım yalnız yeni takım panellerinden izlenir. Üçüncü taraf provider ve işletim sistemi Web Push teslimi için yüzde 100 gelecek garantisi verilmez; ölçülmeyen veya sınır dışı kullanım satın alma onayından önce açıkça raporlanır.
