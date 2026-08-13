# Yerel kalıcı kurulum — hazırlık durumu ve çalıştırma

Bu, `docs/WINDOWS_SECURE_LOCAL.md` **Installation** iş akışının çalıştırılmaya
hazır hâli. Cevat "birlikte yapalım" dediğinde bu belgeden gidilir.

Hazırlık tarihi: 2026-08-13.

---

## Neden ayrı bir script var

İş akışı güven çıpalarını (`$trustedManifestSha256`, `$trustedNodeSha256`,
`$trustedPs51Sha256` …) **oturum değişkenlerinde** tutuyor ve açıkça diyor ki:

> Keep this PowerShell session open; the retained hashes below are trust anchors
> and must not be recomputed after a failed check.

Her komutu ayrı bir süreçte çalıştırmak bu çıpaları kaybettirir. Bu yüzden
dokümandaki 6 PowerShell bloğu (ilk blok hariç — o yalnızca çocuk kabuğu *açan*
komut) sırayla **tek dosyaya** çıkarıldı:

```
<scratchpad>\kurulum\kurulum-tam.ps1     1080 satır
```

Bloklar elle kopyalanmadı; dokümandan programatik olarak çıkarıldı, yani
transkripsiyon hatası yok. PowerShell ayrıştırıcısıyla sözdizimi doğrulandı
(5641 token, 0 hata).

Çalıştırma:

```powershell
& "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "<scratchpad>\kurulum\kurulum-tam.ps1"
```

Script'in kendisi ilk iş olarak şunları doğruluyor ve sağlanmazsa duruyor:
PowerShell 5.1 olması, **yükseltilmemiş** çalışması, `NODE_*`/`NPM_CONFIG_*`/`GIT_*`
değişkenlerinin temizlenmesi, modül yolunun sistem dizinine sabitlenmesi,
cmdlet'lerin beklenen kaynaklardan gelmesi.

---

## Güvenlik kapısı — durum

Doküman, blok 2 ile 3 **arasında**, kod olmayan bir adım olarak şunu şart koşuyor:

> Tedarik zinciri risk denetimi + kapsamlı Semgrep taraması + güvensiz varsayılan
> incelemesi. Açıklanamayan install script, maintainer devralma sinyali,
> **sabitlenmemiş çalıştırılabilir indirme**, yüksek riskli paket veya
> **çözülmemiş production high/critical bulgu** varsa devam etme.

Codex'in "sonuçlar var ama sabitlenmemiş" dediği kapı buydu. Durum:

### ✅ Production high/critical — ÇÖZÜLDÜ

`npm audit --omit=dev --audit-level=high` başlangıçta **1 high** veriyordu:

```
nanoid <3.3.17 — custom generators can loop indefinitely when size is zero
```

`nanoid` `postcss`'in altında geliyor ve postcss zaten `^3.3.16` istiyor, yani
`3.3.18` **kendi kabul aralığında** — semver riski yok. `overrides` içine
sabitlendi, lockfile'da yalnız o girdi güncellendi (integrity registry'den
bağımsız doğrulandı). Kapı artık **exit 0**.

Kalan 2 bulgu **moderate** (postcss `<=8.5.22` sourceMappingURL, ve ona bağlı
next). Kapı yalnız high/critical'da durduruyor; moderate'ler bilinçli olarak
kabul ediliyor çünkü postcss'in yayınlanmış düzeltilmiş sürümü yok.

### ✅ Sabitlenmemiş çalıştırılabilir indirme — YOK

Yaşam döngüsü script'i olan 5 paket var:

| Paket | Script | Değerlendirme |
|---|---|---|
| `esbuild@0.27.0` | `postinstall: node install.js` | **Tek gerçek aday.** Aşağıda. |
| `enhanced-resolve` | `prepare: husky` | `prepare` registry kurulumunda çalışmaz |
| `lightningcss` | `prepare: patch-package` | aynı |
| `csstype` | `prepublish` | yalnız yayıncıda çalışır |
| `minimist` | `prepublish` (guard'lı) | aynı |

`esbuild` için: 27 platform paketinin **hepsi lockfile'da integrity hash'iyle
sabit**. İkili registry'den içerik doğrulamalı geliyor, `install.js` indirmiyor.
Ayrıca kurulum `--ignore-scripts` ile yapılıyor, yani script hiç çalışmıyor.
Diskteki `@esbuild/win32-x64/esbuild.exe` normal optional bağımlılık olarak,
hash doğrulanarak gelmiş.

### ✅ Semgrep — ÇALIŞTIRILDI

Semgrep 1.159.0 kuruldu ve tarandı: **214 kural, 237 dosya, 7 bulgu.**

Windows notu: Türkçe kod sayfasında (cp1254) semgrep kural setini sistem
kodlamasıyla yazmaya çalışıp `UnicodeEncodeError` veriyor. `PYTHONUTF8=1` ile
çözülüyor — tekrar çalıştıracak olan için.

```
semgrep scan --config=p/default --config=p/typescript --config=p/nodejs   --exclude=node_modules --exclude=.next --exclude=public   app lib components convex scripts
```

| Bulgu | Adet | Değerlendirme |
|---|---|---|
| `detect-child-process` (ERROR) | 4 | **Yanlış pozitif.** Üç çağrı yerinin hepsi `shell: false` + dizi argüman kullanıyor; kabuk devrede değil, enjeksiyon yüzeyi yok. Çalıştırılabilirler hash-doğrulanmış çıpalardan (`trusted.nodePath`, `assertExpectedNpmTree`'den geçmiş `npmPath`) geliyor. Ayrıca `scripts/audit/` altındalar — denetim aracı, üretim kodu değil. |
| `detect-non-literal-regexp` (WARNING) | 1 | `groupCode`'un `group` parametresi sabit varsayılanla geliyor; tek çağrı yeri (`pairing-core.ts:47`) argüman geçmiyor. `.{1,N}` geri izleme patlaması üretmez. |
| `hardcoded-hmac-key` (WARNING) | 2 | `lib/vault.test.ts` içinde test sabitleri. |

**Production high/critical: 0.** Kapının durdurma ölçütü karşılanmıyor.

### ✅ Güvensiz varsayılanlar

Fail-open desen taraması temiz. `NODE_TLS_REJECT_UNAUTHORIZED` yalnız
`strict-local-mode.ts` içindeki **yasak listesinde** geçiyor — tersi değil.
`assertProductionSecretEnvironment` hata varsa istisna atıyor (fail-closed).

---

## Ön koşullar (çalıştırmadan önce)

- [ ] Çalışma ağacı temiz, her şey commit'li (`git status --short` boş)
- [ ] Uygulama **kapalı**: iki görev `Ready`, 37645'te dinleyici yok, özel Edge kapalı
- [ ] `npm ci` + test + typecheck + build yeşil
- [ ] Node 22.18.0+ (bu makinede 24.14.0)
- [ ] Kabuk **yükseltilmemiş** (script bunu kendi kontrol ediyor)
- [x] Semgrep tarandı — 0 production high/critical

## Eski kurulumun çıpası

Güncelleme, eski kurulumun `manifestSha256`'sını compare-and-swap çıpası olarak
kullanıyor. Script bunu `install.json`'dan kendi okuyor; **elle girme.**

Şu anda kurulu: commit `678461d`.
Kurulacak: `codex/local-quota-instrument` HEAD.

## Başarısız olursa

Kurucu kendi geri alma günlüğünü tutuyor: aktivasyon başarısız olursa **eski
sürümü tamamen geri yükler ve iki görevi durdurulmuş bırakır.** Geri alma
kanıtlanamazsa günlüğü ve yedekleri silmez — o durumda aynı çıpalarla yeniden
çalıştırmak deterministik toparlanma sağlar.

Yani en kötü senaryo: uygulama kapalı kalır, veri kaybı olmaz. Kasa,
`secrets.dpapi` ve Edge profili hiçbir durumda kopyalanmaz/değiştirilmez.

## Kurulumdan sonra

Doküman **Verification commands** bölümündeki kontroller: kurulu bütünlük,
görev planı, değişmez runtime, son durum doğrulayıcısı, tek loopback dinleyici,
HTTP 200.

Sonra hesaplar bağlanır. **Grok bu yolla bağlanmaz** — doküman açıkça
"hiçbir kimlik bilgisini, çerezi … bir kabuğa, dosyaya, panoya, günlüğe veya
sohbete yapıştırmayın" diyor. Grok barındırılan sürümden bağlanır.
