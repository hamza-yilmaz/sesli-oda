// Site sahibinin düzenleyebileceği sabit ayarlar.

// Trystero uygulama kimliği. Değiştirilirse eski sürümle aynı odada buluşulamaz.
export const APP_ID = 'sesli-oda-yilmaz-v2';

// Varsayılan oda.
export const DEFAULT_ROOM = 'genel';

// Bir odada en fazla kaç kişi olabilir. Tam mesh topolojide her kişi sesini
// herkese ayrı ayrı yükler; 8 kişiden sonra ev bağlantıları zorlanır.
export const MAX_MEMBERS = 10;

// Eşleşme (sinyalleşme) için kullanılan Nostr röleleri. Herkes bu listenin tamamına
// bağlanır; birkaçı çökse bile ortak röle kalır. Liste Trystero'nun önerdiği
// röleler arasından erişilebilir olanlarla seçildi (Kasım 2026). Bir röle kalıcı
// olarak kapanırsa listeden çıkarın; boş bırakılırsa Trystero varsayılanları kullanılır.
export const NOSTR_RELAYS = [
  'wss://nos.lol',
  'wss://relay.degmods.com',
  'wss://nostr.stakey.net',
  'wss://relay.nostr.dev.br',
  'wss://relay.routstr.com',
  'wss://relay.piazza.today',
  'wss://relay.grigic.org',
];

// Kendi TURN sunucunuz (coturn, Cloudflare Realtime TURN, Metered vb.) varsa
// buraya ekleyin. Simetrik NAT arkasındaki (mobil veri, kurumsal ağ) kişilerin
// bağlanabilmesi için gereklidir. Kullanıcılar ayarlardan kendi TURN bilgisini
// de ekleyebilir.
// Örnek: {urls: ['turn:turn.ornek.com:3478', 'turns:turn.ornek.com:5349'], username: 'u', credential: 'p'}
export const TURN_SERVERS = [];

// Tek bir JSON uç noktasından kısa ömürlü TURN bilgisi çekmek için (ör. Metered:
// https://UYGULAMA.metered.live/api/v1/turn/credentials?apiKey=ANAHTAR).
// Dönen yanıt RTCIceServer dizisi olmalıdır.
export const TURN_CREDENTIALS_URL = '';
