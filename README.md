# Sesli Oda

Sunucusuz, hesapsız, ücretsiz sesli sohbet odası. Ses ve sohbet doğrudan tarayıcılar arasında (WebRTC, DTLS-SRTP ile uçtan uca şifreli) akar. Derleme adımı yoktur; dosyaları herhangi bir statik barındırmaya (GitHub Pages, Cloudflare Pages, Netlify…) koymak yeterli.

## Nasıl çalışır

| Katman | Ne kullanılıyor | Neden |
| --- | --- | --- |
| Eşleşme (sinyalleşme) | [Trystero](https://github.com/dmotz/trystero) + Nostr röleleri | Tek bir merkezi sunucu yok. Herkes aynı 7 röleye bağlanır; birkaçı çökse de oda çalışır. "Oda sahibi" yoktur, kimse ayrıldığında oda dağılmaz ya da ikiye bölünmez. |
| Ses taşıma | WebRTC tam mesh, Opus 64 kbps | Küçük gruplar (≤10 kişi) için en düşük gecikme. |
| Gürültü engelleme | [RNNoise](https://github.com/sapphi-red/web-noise-suppressor) (AudioWorklet + WASM) | Klavye, fan ve arka plan seslerini tarayıcıda temizler. |
| Ses kapısı ve seviye ölçer | Kendi AudioWorklet'imiz (`js/worklets/gate.js`) | Ses iş parçacığında çalışır; sekme arka plandayken de konuşmanın başı kesilmez. |
| Şifreli odalar | Oda adı + şifre → SHA-256 oda kimliği, SDP'ler AES-GCM ile şifreli | Şifreyi bilmeyen odayı bulamaz bile. |

### Dosyalar

```
index.html              sayfa iskeleti
css/app.css             tasarım (Remotion tasarım dilinden esinlenildi)
js/config.js            site sahibi ayarları: röleler, TURN, oda limiti
js/main.js              arayüz ve akış
js/room.js              Trystero oturumu ve doğrulanan mesaj protokolü
js/audio.js             ses motoru (mikrofon zinciri, uzak sesler)
js/worklets/gate.js     ses kapısı + seviye ölçer
js/sounds.js            bip ve soundboard sesleri (sentezlenir)
vendor/                 paketlenmiş kütüphaneler (çalışma anında CDN gerekmez)
```

## Yerelde çalıştırma

Mikrofon ve AudioWorklet güvenli bağlam (HTTPS ya da `localhost`) ister:

```bash
npm run dev            # http://localhost:5173
```

## TURN sunucusu (önerilir)

Mobil veri ve bazı kurumsal ağlar doğrudan bağlantıyı engeller. Bu kişilerin bağlanabilmesi için bir TURN sunucusu gerekir. Seçenekler:

- **Cloudflare Realtime TURN**: ücretsiz kota sunar.
- **Metered**: ücretsiz kota sunar. `TURN_CREDENTIALS_URL` ile kısa ömürlü kimlik bilgisi çekilebilir.
- **Kendi sunucun**: [coturn](https://github.com/coturn/coturn) ya da [eturnal](https://github.com/processone/eturnal).

Bilgileri `js/config.js` içindeki `TURN_SERVERS` alanına ekleyin. Kullanıcılar kendi TURN bilgilerini Ayarlar → Bağlantı bölümünden de girebilir. Ses yine uçtan uca şifreli kalır; TURN sunucusu yalnızca şifreli paketleri aktarır.

## Kütüphaneleri güncelleme

```bash
npm install
npm run vendor         # vendor/ klasörünü yeniden üretir
```

Bir Nostr rölesi kalıcı olarak kapanırsa `js/config.js` içindeki `NOSTR_RELAYS` listesinden çıkarın. Uygulamadaki "Ağ x/7" göstergesi kaç rölenin bağlı olduğunu gösterir.

## Kısayollar

- `M`: mikrofonu aç/kapat
- `D`: sesi aç/kapat
- Bas-konuş tuşu ayarlardan seçilir (varsayılan: Boşluk). Mobilde bas-konuş butonunu basılı tutun.
