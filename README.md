# Futures DCA / Martingale Backtest & Simülasyon Terminali

Masaüstü tarayıcılarda tam ekran (`100vw x 100vh`) çalışan, çevrimdışı (offline) kullanıma uygun, Pitch-Black OLED Dark temalı **Kripto Vadeli İşlemler (Futures) DCA / Martingale Backtest ve Simülasyon Terminali**.

## Özellikler

- **Pitch-Black OLED Dark Arayüz:** `#000000` ana arka plan, `#0A0D12` panel yüzeyleri, `#1C222D` kenarlıklar, `#00E676` kâr, `#FF5252` zarar/likidasyon ve `#FF9800` EMA 50 vurguları.
- **Canlı Geçmiş Veri Motoru + Çevrimdışı Önbellek:**
  - Bybit V5 Public Linear Kline API üzerinden otomatik sayfalama (pagination) ile eksiksiz geçmiş mum verisi çeker.
  - CORS veya erişim hatası durumunda otomatik olarak Binance Futures Public API yedeğine geçer.
  - Çekilen mum verilerini `IndexedDB` üzerinde saklayarak çevrimdışı (offline) ve anında tekrar test imkânı sunar.
  - Yerel `.csv` ve `.json` OHLCV mum verisi yüklemeyi destekler.
- **Matematiksel Backtest Motoru:**
  - EMA 50 altı Long giriş, her `%1.5` düşüşte Martingale (`2.0x`) veya Lineer (`+$0.50`) kademeli ekleme, ağırlıklı ortalama giriş fiyatı ve EMA 50 temas çıkışı.
  - Gidiş-dönüş komisyon kesintisi (`%0.05`), *"Sadece Ortalama Giriş Üstündeyken EMA 50'de Sat"* koruması ve *"Çapraz Kasa Likidasyon Kontrolü"*.
- **Birleşik İşlemler Listesi & İnteraktif Grafik:**
  - TradingView Lightweight Charts (v4) üzerinde mumlar, EMA 50, kademeli ortalama giriş çizgisi, sonraki ekleme seviyesi ve birleşik `#N AL` / `#N SAT` etiketleri.
  - Tablodan herhangi bir işlem satırına tıklandığında grafiğin otomatik olarak o işlem aralığına odaklanması.
  - Kasa Büyüme Eğrisi, anlık Kademe & Likidasyon Tablosu ve tek tıkla `.csv` dışa aktarma.

## Kullanım

Harici bir kurulum veya derleme gerektirmez. `index.html` dosyasını doğrudan modern bir masaüstü tarayıcıda açmanız yeterlidir.
