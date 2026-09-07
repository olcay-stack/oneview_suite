# Shop-Floor Agent Index

16 rol-tabanlı agentic AI ajanının (bakım, üretim, İK, raporlama) demo arayüzü. API anahtarı yalnızca bu backend'de tutulur; tarayıcıya hiçbir zaman gönderilmez.

```
[public/index.html]  →  POST /api/agent/:id/ask  →  [server.js]  →  Anthropic API
      (key yok)                                      (key .env'den okunur)
```

## Kurulum

```bash
npm install
cp .env.example .env
# .env dosyasını açıp ANTHROPIC_API_KEY değerini console.anthropic.com'dan aldığınız
# gerçek anahtarla değiştirin
npm start
```

Sonra tarayıcıda `http://localhost:3000` adresini açın. Sayfanın üst kısmındaki durum
göstergesi anahtarın tanınıp tanınmadığını söyler; her kartın altındaki **Ask agent**
butonu o ajanla konuşmaya açılan bir konsol paneli açar.

## Yeni bir agent eklemek

`server.js` içindeki `AGENTS` nesnesine `"X-05": "You are the ... Agent ..."` şeklinde
bir sistem talimatı ekleyin, `public/index.html`'de aynı `data-id`'ye sahip bir kart
oluşturun — hepsi aynı `ANTHROPIC_API_KEY`'i paylaşır, ayrı bir anahtar gerekmez.
