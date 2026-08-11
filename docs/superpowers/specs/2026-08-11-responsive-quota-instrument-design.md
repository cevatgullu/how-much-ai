# How Much AI — Duyarlı Kota Cetveli Tasarımı

Tarih: 2026-08-11

Durum: Görsel yön onaylandı; yazılı şartname son kullanıcı incelemesini bekliyor

## Amaç

How Much AI'ın tek sayfalık panosunu, yedi veya daha fazla hesabı 27 inç 4K Windows ekranında ve iPhone 17 Pro Max'te hızlıca karşılaştırılabilen, yüksek okunabilirlikli bir **kota ölçüm aracına** dönüştürmek.

Hosted ürünün görünen adı **How Much AI — Özel PWA**'dır; eski uygulamayla karışmaması için arayüzde yeni ürüne “V2” denmez. Her yeni tarayıcı/PWA kurulumunda ilk başarılı girişten sonra `Bu Özel PWA eski uygulamadan ayrıdır. Hesaplar ve ayarlar otomatik taşınmadı; kullanmak istediğiniz AI hesaplarını burada yeniden bağlayın.` notu gösterilir. Not, bu cihazda `Anladım` seçilene kadar kalır ve daha sonra Bilgi/Ayarlar yüzeyinden yeniden açılabilir. Kabul durumu yalnız cihazda, sürümlü bir anahtarla tutulur; başka cihazdaki onay bu notu gizlemez. Metin uyarı estetiğinde değil, sakin ve açık bir kurulum notu olarak sunulur.

Bu çalışma aynı zamanda kullanıcının iki sıralama isteğini karşılar:

1. geçerli haftalık yenilenme tarihi en yakın hesap en üstte;
2. haftalık kotası en çok kullanılan hesap en üstte.

Tasarımın imza öğesi, hesapların en yüksek haftalık kullanımını aynı 0–100 ölçeğinde gösteren tam genişlikte bir **kota cetveli**dir. Cetvel, sayfayı sıradan bir SaaS kart ızgarasından ayırır ve hangi hesabın haftalık sınırına en yakın olduğunu bir bakışta gösterir.

## Kapsam sınırı

Bu şartname yalnızca pano bilgi mimarisi, görsel sistem, hesap sıralaması, duyarlı davranış ve bunların erişilebilirlik/test kontratını kapsar. PWA kurulumu ve bildirim merkezi ayrı şartnamededir. Vercel/Convex yayını ayrı şartnamededir.

İlk sürümde şunlar yoktur:

- açık tema veya tema anahtarı;
- sürükleyerek özel sıralama;
- beş saatlik kullanıma göre ayrıca sıralama;
- grafik geçmişi, maliyet analitiği veya hesap grupları;
- yatay kaydırılan hesap karuseli;
- çok kullanıcılı rol, davet veya kişiye özel pano;
- dekoratif gradyan, cam efekti, parıltı ya da zıplayan kart animasyonu.

Koyu tema ilk sürüm için bilinçli ve kullanıcı tarafından onaylanmış kapsam kararıdır. Açık tema yerine zorlanmış renkler, yeterli kontrast ve sistem erişilebilirlik modları eksiksiz desteklenir.

## Seçilen görsel yön: Kota Cetveli / The Measure

Arayüz, “karanlık bir ölçüm masası” hissi verir: mat yüzeyler, hassas çizgiler, sıkı tipografik hiyerarşi ve yalnızca anlam taşıyan renkler. Gösterişli bir AI ürünü görünümü yerine, güvenilir bir laboratuvar aleti gibi sakin ve kesin davranır.

Değerlendirilen diğer yaklaşımlar:

- **Yenilenme zaman çizelgesi:** en yakın sıfırlamayı güçlü gösterir fakat kapasite karşılaştırmasını zayıflatır.
- **Sağlayıcı masaları:** Claude ve ChatGPT'yi ayırır fakat sağlayıcı başına hesap sayısı eşit değilse alan dengesini bozar.

Kota cetveli, hem haftalık kullanım sıralamasının temel metriğini görünür kıldığı hem de karışık sağlayıcı hesaplarını ortak ölçekte karşılaştırdığı için seçildi.

## Tasarım dili

### Renkler

Ana renk sistemi:

| Rol | Değer | Kullanım |
| --- | --- | --- |
| Tuval | `#111614` | Sayfa zemini |
| Panel | `#19201D` | Kartlar, araç şeritleri, modal yüzeyleri |
| Cetvel çizgisi | `#697770` | Ölçek, ayırıcı ve ikincil çerçeveler |
| Ana metin | `#F1F4EF` | Başlıklar ve kritik değerler |
| İkincil metin | `#A5B1AA` | Açıklama ve zaman bilgisi |
| Kalibrasyon mavisi | `#78A7BF` | Nötr seçili durum, odak ve ölçüm işaretleri |
| Claude mercanı | `#D97757` | Yalnızca Claude kimliği |
| Kehribar | `#D9A557` | Yükselen kullanım; dekorasyon için kullanılmaz |
| Kırmızı | `#E05B5B` | Kritik kullanım ve hata; panel zemininde normal metin için 4.60:1 kontrast |

ChatGPT/OpenAI kimliği mevcut siyah-beyaz karakterini korur. Sağlayıcı rengi, kartı tamamen boyamaz; avatar, ince kimlik çizgisi ve küçük etiketlerle sınırlı kalır. Kullanım şiddeti sağlayıcı renginden bağımsızdır.

`#697770` tam kuvvette yalnız cetvel ve kontrol sınırında kullanılan `rule-strong` değeridir. Kart iç ayırıcıları aynı rengin `%42` alfa türevi `rule-soft` değerini kullanır; kart çizgileri cetvelden daha baskın olmaz.

Renk hiçbir zaman tek durum ileticisi değildir. “Eski veri”, “yeniden bağla”, “kritik” ve “hata” durumları metin veya simge ile de belirtilir.

### Tipografi

Yerel Next.js 16.2.11 font dışa aktarımları doğrulanmıştır:

- ekran ve bölüm başlıkları: `Barlow Condensed`, ağırlık 500–700;
- gövde ve arayüz metni: `Atkinson Hyperlegible Next`, değişken ağırlık;
- yüzdeler, saatler ve cetvel değerleri: `Atkinson Hyperlegible Mono`, değişken ağırlık.

Her üç aile `latin-ext` alt kümesiyle Next/font tarafından build sırasında alınır; çalışma anında Google Fonts isteği yapılmaz. Font değişkeni zincirde ilk, iOS için `-apple-system` ve Windows için `Segoe UI Variable` yalnız sonraki fallback'lerdir. Bu seçim Vercel build'inde ağ erişimini kabul eder; ileride tamamen çevrimdışı deterministik build istenirse lisans dosyalarıyla WOFF2'ler `next/font/local` üzerinden vendorizelenir.

Asgari boyutlar:

- mobil gövde: 15 px;
- masaüstü gövde: 15–17 px;
- ikincil açıklamalar: en az 12.5 px, tercihen 13 px;
- dokunulabilir kontroller: en az 44 × 44 CSS px;
- alt komut çubuğu eylemleri: en az 48 px yükseklik.

Mevcut 11 px kritik etiketler büyütülür. Yüzdeler ve zamanlar `tabular-nums` kullanır.

## Veri modeli ve ortak haftalık metrik

Sıralama ile kota cetveli aynı saf hesaplama katmanını kullanır. Böylece kullanıcı cetvelde gördüğü değer ile kart sırasının nedenini farklı yorumlamaz.

Bir hesabın **haftalık aday satırları**, normalleştirilmiş kullanım çubuklarından şu türlerde olanlardır:

- `weekly_all`;
- `weekly_oauth_apps`;
- `weekly_scoped`.

GPT-5.3-Codex-Spark haftalık satırı sağlayıcı normalleştirme sınırında zaten dışlandığından pano, cetvel, sıralama ve bildirimler onu hiçbir zaman aday olarak görmez.

Hesap başına türetilen alanlar:

- `highestWeeklyUsedPercent`: adaylar arasındaki en yüksek sonlu `usedPercent`;
- `highestWeeklyLimitKey` / `highestWeeklyLimitLabel`: maksimum kullanımı sağlayan satırın kimliği ve görünür Türkçe etiketi;
- `nearestWeeklyResetAt`: adaylar arasındaki geçerli ve şu andan sonraki en erken `resetsAt`;
- `nearestWeeklyResetKey` / `nearestWeeklyResetLabel`: en erken tarihi sağlayan satırın kimliği ve görünür Türkçe etiketi;
- `hasFreshReading`: gösterilen anlık görüntünün taze olup olmadığı;
- `sourceIndex`: hesabın şifreli kasadaki özgün sırası.

Yüzde 0–100 aralığında kalır. Geçersiz, sonsuz veya eksik değer aday değildir. Geçmişte kalmış bir yenilenme tarihi “yakın tarih” sayılmaz. Son başarılı fakat eskimiş anlık görüntü, kartta açıkça `son veri` olarak işaretlenmek koşuluyla metrik sağlayabilir; metriği hiç olmayan hesaplar ilgili sıralamada sona gider.

Maksimum yüzde veya en erken tarih aynı hesabın birden fazla satırında eşitse kazanan satır sırası `weekly_all`, `weekly_oauth_apps`, ardından anahtarı sözlüksel sıralı `weekly_scoped` olur. Yenilenme metriği, sağlayıcının bildirdiği tüm haftalık satırları `isActive` ve mevcut yüzde ayrımı yapmadan kapsar; `%0` veya pasif bir model kotası da daha erken bir tarih sağlayabilir. Arayüz bu nedenle kazanan limit etiketini tarihin yanında gösterir ve yakın yenilenmeyi “kritik kullanım” gibi sunmaz.

## Sıralama kontratı

İlk sürümde tam olarak üç seçenek vardır:

1. **Kayıt sırası** — şifreli kasadaki değişmeyen özgün sıra;
2. **En çok haftalık kullanım** — `highestWeeklyUsedPercent` azalan;
3. **En yakın haftalık yenilenme** — `nearestWeeklyResetAt` artan.

Eşitlikler önce `sourceIndex`, son savunma olarak hesap kimliği ile kararlı çözülür. Görsel sıralama kasadaki hesap dizisini değiştirmez, kayıt etmez ve cihazlar arasında senkronlanmaz. Yalnızca seçili tarayıcı/PWA cihazında sürümlü bir tercih olarak saklanır. Bozuk veya gelecekteki sürüme ait tercih güvenli biçimde `Kayıt sırası`na döner.

Sağlayıcı sıra numaraları sıralanmış karta göre yeniden hesaplanmaz. Örneğin kasadaki ikinci Claude hesabı üst sıraya çıksa bile `Claude 2` olarak kalır; bildirim ve pano etiketi tutarlı olur.

### Yenileme sırasında sıra davranışı

Kartlar ilk yüklemede her hesap sonucu geldiğinde zıplamaz. Seçili sıralama:

- kasa yüklendiğinde geçici olarak kayıt sırasını gösterir;
- ilk toplu yenileme tamamlandığında veya tüm sonuçlar hata/timeout ile sonlandığında bir kez uygulanır;
- “Tümünü yenile” sırasında mevcut sırayı korur ve toplu işlem sonlandığında bir kez yeniden hesaplanır;
- tek hesap yenilemesinde o işlemin sonucu kesinleşince yeniden hesaplanır;
- hesap ekleme/silme/yeniden adlandırmada kararlı eşitlik kurallarını korur.

Dakikalık görsel saat sayacı tek başına kart sırasını değiştirmez. Bir `resetsAt` zamanı geçmişe düştüğünde hesap, bir sonraki kesinleşmiş kullanım yenilemesinde yeni sağlayıcı verisiyle yeniden değerlendirilir. Böylece kartlar kullanıcı etkileşimi yokken yalnız saat ilerledi diye yer değiştirmez.

İlk toplu yenileme kesinleşene kadar sıralama kontrolü seçilmiş tercihi ve `veri bekleniyor` durumunu birlikte gösterir, seçim değişikliğine kapalıdır. Hiçbir hesapta kullanılabilir metrik oluşmazsa özgün sıra kalır ve `Sıralamak için kullanılabilir haftalık veri yok` açıklaması görünür. Snapshot kabul anında gelecekte olan reset metriği o snapshot için dondurulur; saat bu tarihi geçince etiket `yenilenme verisi bekleniyor` olur, fakat bir sonraki gerçek kullanım sonucu gelmeden sıra değişmez.

Klavye odağı veya etkin pointer bir kart içindeyken yeniden sıralama gerekiyorsa uygulama yeni sırayı o karttan çıkılana kadar erteler. Sonra aynı hesabı `block: nearest` scroll anchor olarak korur. Kartlar konum değiştirirken animasyon kullanılmaz; DOM anahtarı hesap kimliğidir, açık/kapalı mobil durumu ve odak aynı hesaba bağlı kalır.

## Masaüstü bilgi mimarisi

### Üst şerit

Yapışkan üst şerit üç bölgedir:

1. marka: `How Much AI — Özel PWA` ve kısa `Kota cetveli` tanımı;
2. sağlık özeti: son başarılı kontrol, izlenen hesap sayısı ve hata varsa sayısı;
3. eylemler: `Panoyu canlı izle`, tümünü yenileme, bildirimler, hesap ekleme ve çıkış.

Geniş ekranda metinli eylemler, dar ekranda simge ve erişilebilir ad kullanılır. İngilizce/Türkçe karışımı kaldırılır; `html lang="tr"` ve tüm görünür/ARIA metinleri Türkçedir. Claude, ChatGPT ve model adları özel isim olarak değişmez.

`Panoyu canlı izle` yalnız görünür panonun mevcut HttpOnly oturumla korunan tek toplu sunucu snapshot'ını en sık 60 saniyede bir takip etmesini yönetir; tarayıcı Convex'e doğrudan bağlanmaz ve sunucu bildirim monitorünü değiştirmez. Aynı anda en fazla iki görünür cihaz canlı pano lease'i alır; üçüncü cihazda `İki canlı pano kullanımda · Bu cihaz odaklanınca veya elle yenilenir.` açıklaması görünür. Aylık snapshot koruması dolarsa ilk satır yalnız `Canlı pano maliyet korumasında · Son görülen veri {zaman}.` der. Kapalıyken üst şeritte kalıcı `Pano takibi kapalı · Son görülen veri {zaman}.` satırı görünür ve mevcut kartlar güncelmiş gibi sunulmaz. Her iki durumda da altındaki ayrı durum satırı gerçek monitor durumuna göre `Tüm cihazlar için sunucu izlemesi açık · Bildirimler devam ediyor.`, `Tüm cihazlar için sunucu izlemesi kapalı · Yeni kullanım hiçbir cihaz için kontrol edilmiyor.` veya `Maliyet koruması etkin · Yeni kullanım kontrol edilmiyor.` der.

Bu yerelleştirme sınırı pano, giriş/bootstrap/OAuth geri dönüş sayfaları, hesap ekleme/yeniden bağlama akışları, kullanım kartları, bildirim paneli, modal ve hata/boş durumlarını kapsar. Sağlayıcının ham teknik hata metni doğrudan gösterilmez; Türkçe güvenli özet ve referans kodu kullanılır. Kaynak kodu geliştirici mesajları ve sağlayıcı/model özel isimleri çeviri kapsamı dışındadır.

### Kota cetveli

Üst şeridin altında, hesap ızgarasından önce tam genişlikte yer alır:

- ana ölçek işaretleri gerçek kullanım şiddetiyle uyumlu 0, 50, 85 ve 100'dür; 25 ve 75 daha kısa ikincil tick olarak kalır;
- her hesabın `highestWeeklyUsedPercent` değeri kimliklendirilmiş bir işaretçidir;
- masaüstünde yüzde konumu piksele çevrildikten sonra etiketler en az 8 px yatay aralıkla en fazla üç lane'e açgözlü ve kararlı biçimde yerleştirilir; üç lane'e sığmayan aynı bölge `+N` küme düğmesine dönüşür;
- işaretçi etiketi takma ad yoksa kararlı `Claude 2` / `ChatGPT 1` adını kullanır;
- eskimiş değer `son veri` metni ve farklı çizgi deseniyle belirtilir;
- metriği olmayan hesaplar cetvelin sonunda `ilk veri bekleniyor` alanında listelenir;
- hiçbir bilgi yalnızca hover ile açılmaz.

`+N` kümesi tıklama/Enter ile o kümedeki hesapları, yüzdeleri ve kazanan limit etiketlerini küçük erişilebilir bir açılır listede gösterir. Mobilde 104 px yüksekliğindeki track tüm hesapların etiketsiz kısa tick'lerini taşır, yalnız en yüksek hesap doğrudan etiketlenir; altında `En yoğun` okuması bulunur. Böylece 440 px görünümde yedi-on iki uzun etiket sıkıştırılmaz.

Görsel ölçek ve çizgiler `aria-hidden`dır. Aynı bölümde başlıklı, yüzdesi azalan ve eşitlikte kasa sırası kullanılan gerçek bir `<ol>` tüm hesap adlarını, yüzdeleri, limit etiketlerini ve `son veri` durumunu erişilebilir metin olarak sunar. Görsel konumlandırma CSS `order` ile ekran okuyucu sırasını değiştirmez; kümelerin erişilebilir adı içindeki tüm hesapları sayar.

Cetvel altında üç sıkı okuma bulunur: hesap sayısı, en yüksek haftalık kullanım ve en yakın haftalık yenilenme. Son ikisi hesap adıyla birlikte kazanan limit etiketini de gösterir. Bunlar mevcut üç büyük KPI kartının yerini alır; mobilde ayrı küçük kutulara dönüşmez. Masaüstü sıralama kontrolü bu okuma şeridinin sağında, kart ızgarasından hemen önce bulunur.

### Hesap kartları

Kartların açık masaüstü yapısı:

1. sağlayıcı kimliği, kararlı sıra numarası, takma ad/plan ve sağlık durumu;
2. sağlayıcının döndürdüğü tüm görünür kota satırları; en önemli gerçek satırlar tipografiyle öne çıkar fakat yinelenmiş özet satırı oluşturmaz;
3. yalnızca gerektiğinde hata, yeniden bağlama ve hesap eylemleri.

E-posta birincil başlık değildir; hassas tanımlayıcı olarak ikincil ve gerektiğinde kırpılmış kalır. Takma ad ve kararlı sağlayıcı numarası karşılaştırmanın ana kimliğidir. Kart yüksekliğini eşitlemek için gerçek veriler gizlenmez; ızgara satır yüksekliği içeriğe göre büyür.

### 4K ve ara ekranlar

İçerik artık 1152 px'e kilitlenmez. Duyarlı kontrat:

| CSS görünüm genişliği | İçerik ve sütun davranışı |
| --- | --- |
| `>= 2880` | `min(3264px, 90vw)` içerik, 4 sütun, 24 px gap, kart en az 600 px; 3840 px'te 288 px yan boşluk ve yaklaşık 798 px kart |
| `1920–2879` | `min(3264px, 90vw)` içerik, 3 sütun, 24 px gap, kart en az 560 px; 2560 px'te 2304 px içerik / 752 px kart, 1920 px'te 1728 px içerik / 560 px kart |
| `960–1919` | `calc(100% - 2 × clamp(24px, 4vw, 64px))` içerik, 2 sütun, 20 px gap, kart en az 420 px |
| `< 960` | 16 px + safe-area yan boşlukla 1 sütun, 16 px gap |

Cetvel görsel alanı 960–2879 aralığında 176 px, `>=2880` görünümde 196 px yüksekliğindedir. `>=3200` görünümde gövde en az 18 px, ikincil metin 14 px, hesap adı 20 px ve ana değer 24 px olur; 4K %100 görünüm boş ve minyatür kalmaz.

27 inç 4K ekranın Windows'ta %150 ölçeklemesi tipik olarak yaklaşık 2560 × 1440 CSS görünümü verdiğinden birincil masaüstü kabul görünümü budur. 3840 × 2160 %100 ölçek ayrıca doğrulanır; içerik gereksiz biçimde ortaya sıkışmaz.

## iPhone bilgi mimarisi

Apple'ın iPhone 17 Pro Max için bildirdiği mantıksal görünüm 440 × 956 pt ve @3x fiziksel çözünürlüktür. Tasarım sabit 956 px yüksekliğe veya elle yazılmış çentik boşluğuna güvenmez:

- `viewport-fit=cover`;
- `100dvh`, desteklemeyen ortamlar için `100vh` geri dönüşü;
- `env(safe-area-inset-top/right/bottom/left)`;
- taşan metin yerine `min-width: 0`, kontrollü satır kırma ve görünür durum etiketi.

### Kota defteri

Mobilde masaüstü kartları küçültülmez; **kota defteri** satırlarına dönüşür:

- kapalı satır yüksekliği içerik durumuna göre yaklaşık 100–112 px;
- sağlayıcı/hesap/takma ad, plan, en yüksek beş saatlik kullanım, en yüksek haftalık kullanım ve en yakın haftalık yenilenme görünür;
- hata, eski veri, yeniden bağlama veya kritik durum kapalıyken de görünür;
- kapalı özetin kendi expand düğmesine dokununca tüm kullanım çubukları ve hesap eylemleri ilişkili panelde açılır;
- birden fazla hesap aynı anda açık kalabilir;
- expand düğmesi `aria-expanded` ve `aria-controls` taşır; panel kararlı hesap kimliğinden türetilen `id` ve kapalıyken `hidden` kullanır. Yenile/adlandır/sil kontrolleri düğmenin içine gömülmez, yalnız açılan panelde bulunur.

Kapalı özette bulunmayan bir metrik `—` ve uygun kısa açıklamayla gösterilir; eksik veri hiçbir zaman `%0 kullanıldı` biçiminde sunulmaz.

Mobilde hesapların yatay karuseli yoktur. Dikey tarama, ekran okuyucu sırası ve tarayıcı içi arama doğal kalır.

### Mobil komutlar

Üstte marka ve sağlık durumu için sade bir satır, altında seçili sıralamayı gösteren kompakt bir şerit bulunur. Sıralama seçenekleri yatay çip dizisi yerine alttan açılan seçim sayfasında gösterilir.

Ekranın altında güvenli alanı kullanan dört eylemli komut çubuğu vardır:

- `Yenile`;
- `Hesap`;
- `Uyarılar`;
- `Menü`.

Kesin eylemler:

- `Yenile`: tüm hesapların mevcut toplu yenilemesini başlatır;
- `Hesap`: hesap ekleme modalını açar; erişilebilir adı `Hesap ekle`dir;
- `Uyarılar`: bildirim kontrol merkezini açar;
- `Menü`: `Panoyu canlı izle` anahtarı, çıkış ve yasal/güvenlik bilgisini içeren yardımcı alt sayfayı açar. Bu anahtar sunucu bildirim monitorünü kapatmaz; monitor yalnız Bildirimler içindeki `Tüm cihazlar için sunucu izlemesi` kontrolüyle durdurulur.

Kompakt sıralama şeridi ayrı bir düğmedir ve üç sıralama seçeneğini içeren alt sayfayı açar. Her iki alt sayfa da `ModalShell` odak kapanı, inert arka plan, Escape/kapatma ve çağıran düğmeye odak dönüşü kontratını kullanır; aynı anda yalnız biri açıktır.

Çubuk içerik üzerine binmez; ana alan alt dolgusuna çubuk yüksekliği ve `safe-area-inset-bottom` eklenir. Klavye veya modal açıldığında iki ayrı alt çubuk üst üste gelmez.

Genel `<960` tek sütun kuralının tek istisnası `orientation: landscape`, `min-width: 900px` ve `max-height: 500px` birleşimidir. 956 × 440 iPhone yatay görünümünde iki sıkı kapalı özet sütunu kullanılır. Plan/e-posta ve dekoratif açıklamalar gizlenebilir; en yüksek haftalık kullanım, en yakın yenilenme, hata/yeniden bağlama ve ana eylem kalır. Modallar dikey ortalanmak yerine üst-güvenli alandan başlar.

## Durumlar ve hata davranışı

- İlk yükleme iskeletleri gerçek son düzeni taklit eder; yanıltıcı yüzde göstermez.
- Başarılı eski veri görünür kalır fakat `son veri` ve zamanı belirtilir.
- Yenileme hatası, mevcut son başarılı veriyi silmez.
- Yeniden bağlama gereken hesap kapalı mobil satırda da belirgindir.
- Metrik eksikliği `0%` olarak yorumlanmaz.
- Sıralama tercihi kaydedilemezse pano çalışmaya devam eder ve Türkçe, eyleme dönük hata gösterir.
- Pano dili veya saat biçimi yüzünden sağlayıcının ISO zaman damgası değiştirilmez; görüntüleme `tr-TR` ve cihaz saat dilimiyle yapılır.

## Hareket, erişilebilirlik ve giriş yöntemleri

Hareket yalnızca durum değişimini açıklamak için kullanılır. Cetvel işaretçisi ve kota dolumu kısa, mesafesi sınırlı geçiş kullanabilir; kartların sıralama konumu animasyonlandırılmaz. `prefers-reduced-motion` altında kalan hareket de kaldırılır. Sürekli parıltı, kart kaldırma veya dekoratif yükleme animasyonu yoktur.

Kabul gereksinimleri:

- her işlev klavye ile erişilebilir ve görünür odak halkasına sahiptir;
- tüm dokunma hedefleri en az 44 × 44 CSS px;
- `forced-colors` altında ilerleme ve durum ayrımları korunur;
- yüzde çubukları erişilebilir ad, güncel değer ve bağlam taşır;
- 200% yakınlaştırmada işlev kaybı ve yatay sayfa kaydırması olmaz;
- iPhone'da `document.documentElement.scrollWidth <= clientWidth`; yalnızca sınırlandırılmış kod örnekleri istisna olabilir;
- VoiceOver ve Windows Narrator okuma sırası görsel sıra ile uyumludur;
- canlı bölgeler yalnızca kullanıcının başlattığı yenileme/kaydetme sonucu için kullanılır; dakikalık pasif güncellemeler ekran okuyucuyu sürekli bölmez.

## Test ve kabul planı

### Saf mantık testleri

- üç sıralama modu;
- çoklu haftalık satırdan doğru maksimum kullanım;
- çoklu haftalık satırdan yalnızca gelecekteki en yakın tarih;
- geçersiz, eksik ve geçmiş zamanların sona gitmesi;
- eşitlikte kasa sırası ve hesap kimliğiyle kararlılık;
- eski verinin görünür metrik sağlaması, verisiz hesabın `0` sayılmaması;
- kasadaki dizinin sıralama sonucunda mutasyona uğramaması;
- sağlayıcı sıra numarasının görsel sıradan etkilenmemesi;
- Spark haftalık satırının hiçbir türetilmiş metrikte görünmemesi;
- bozuk cihaz tercihi için kayıt sırası geri dönüşü.
- reset zamanının görüntü saatiyle “şimdi”yi geçmesi halinde sıranın snapshot yenilenene kadar donması.

### Bileşen ve etkileşim testleri

- ilk toplu yenilemede kartların ara sonuçlarla zıplamaması;
- kaydedilmiş sıralama için `veri bekleniyor`, tüm sonuçlar hatalı/verisizken açıklamalı özgün sıra;
- tekli/toplu yenileme sonunda bir kez yeniden sıralama;
- sıralama değiştirilirken klavye/pointer odağının aynı hesapta ve viewport'ta kalması;
- mobil satırların bağımsız açılıp kapanması;
- yeniden sıralamadan sonra açık satır durumunun hesap kimliğiyle korunması;
- eski/hata/yeniden bağlama durumlarının kapalı satırda görünmesi;
- tüm görünür ve erişilebilir arayüz metninin Türkçe olması;
- kullanıcının sıralama seçiminin uygun canlı geri bildirim vermesi, pasif yenilemenin ekran okuyucuyu bölmemesi;
- 12 hesapta üç lane ve `+N` kümelerinin deterministik olması, erişilebilir `<ol>` sırasının doğru kalması.

### Görsel matris

- iPhone 17 Pro Max: 440 × 956 dikey ve 956 × 440 yatay;
- 390 × 844 küçük iPhone güvenlik görünümü;
- 768 × 1024 tablet;
- 1366 × 768 ve 1440 × 900 dizüstü;
- 1920 × 1080;
- 2560 × 1440, 27 inç 4K / %150 ölçek birincil masaüstü görünümü;
- 3840 × 2160 / %100 ölçek;
- 200% tarayıcı yakınlaştırması, azaltılmış hareket ve zorlanmış renkler.

Breakpoint sınırları ayrıca 959/960, 1919/1920 ve 2879/2880 px'te; yatay istisna 899/900 px genişlik ve 500/501 px yükseklikte doğrulanır.

Görsel regresyon incelemesinde özellikle cetvel etiket çakışması, uzun Türkçe metin, yedi ve on iki hesap, takma adsız hesaplar, çok sayıda model kotası ve e-posta taşması kontrol edilir.

## Başarı ölçütü

Kullanıcı 27 inç 4K ekranda veya iPhone'da sayfayı açtığında üç saniye içinde şu iki soruyu cevaplayabilmelidir:

1. “Şu anda haftalık kotası en dolu hesap hangisi?”
2. “Haftalık kotası en önce yenilenecek hesap hangisi?”

Bu cevaplar cetvel, seçili sıralama ve kart özeti arasında çelişmemelidir.
