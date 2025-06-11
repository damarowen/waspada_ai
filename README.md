# 📡 Waspada AI – Monitoring System with Smart Chatbot

## 📝 Todo List

1. [v] **Integrasikan Tawk.to ke platform ini**
   - Tambahkan widget chat dari Tawk.to ke dalam halaman dashboard/internal monitoring
   - Pastikan script berjalan di environment internal

2. [v] **Branding Uptime Kuma menjadi Waspada AI**
   - Ganti seluruh teks "Uptime Kuma" → "Waspada AI"
   - Ganti logo utama (`icon.svg`, `favicon.ico`, dll)
   - Ubah title HTML dan metadata yang relevan

3. [] **Latih AI ringan di Tawk.to**
   - tambhakan faq di dasboard tawk sampe maksimal
   - Gunakan pendekatan rule-based (keyword matching)
   - Deteksi kata kunci seperti: `api`, `down`, `error`, `gangguan`, `layanan`, `status`

5. [] **Respons real-time ketika user bertanya "API down?"**
   - Integrasikan logika RAG (Retrieval-Augmented Generation) sederhana:
     - Tangkap input user di frontend via `Tawk_API.onMessageReceived`
     - Jika mengandung kata kunci terkait:
       - Panggil endpoint backend: `/status/down-today`
       - Endpoint query database Uptime Kuma (SQLite) dan return list API yang down
       - Format respons dan tampilkan lewat `Tawk_API.addEvent()`
6. . [] **Integrasikan ke notifikasi teams**

### 🔁 Alur logika interaksi

```text
[User asks via Tawk.to]: "Apa saja API yang down hari ini?"
               │
               ▼
[Bot hits middleware endpoint]: /status/down-today
               │
               ▼
[Your backend]: Query Kuma database → return list of down services
               │
               ▼
[Bot formats answer]: "Saat ini API Auth dan Payment sedang mengalami gangguan."
```


## 🎯 Kenapa Masuk Kategori Efficientia (Gede-gedean Cut Cost)

Solusi ini tepat masuk kategori **Efficientia** karena memberikan dampak langsung terhadap **efisiensi operasional internal**:

### 🔧 Otomatisasi Proses Internal
- Bot menggantikan proses manual dalam menjawab pertanyaan tentang status layanan.
- Tidak perlu buka dashboard, tidak perlu mengganggu developer atau DevOps.

### ⏱️ Pemangkasan Waktu Tanggap (MTTA)
- Waktu respon terhadap insiden sistem berkurang drastis (dari 5–10 menit menjadi < 1 menit).
- Meningkatkan kecepatan koordinasi tim internal.

### 🧠 Efisiensi Komunikasi Lintas Tim
- CS, Developer, dan Ops bisa mengakses informasi status sistem yang sama secara real-time dan konsisten.
- Tidak perlu menunggu broadcast manual atau tanya ke grup chat teknis.

### 💸 Penghematan Biaya Operasional
- Tidak menggunakan layanan monitoring berbayar.
- Stack teknologi open-source dan gratis (Uptime Kuma, Tawk.to, Express.js).

### 🔐 Pengurangan Risiko Potensial
- Dengan mempercepat deteksi dan respons, downtime bisa ditangani lebih cepat.
- Mengurangi potential loss akibat sistem terlambat ditangani (transaksi gagal, reputasi, SLA internal).

### 🧩 Modular dan Scalable
- Bisa dikembangkan untuk mendeteksi jenis gangguan lain (delay, spike, latency).
- Bisa dikombinasikan dengan Notion, Slack, atau tools internal lainnya ke depannya.

---

## 🧪 Studi Kasus Simulasi

Misalnya:
- Tanpa bot: Downtime 10 menit → 1000 transaksi gagal × Rp10.000 = Rp10.000.000 potensi loss
- Dengan bot: Deteksi lebih cepat, downtime hanya 4 menit → potensi loss turun jadi Rp4.000.000
- ➤ **Efisiensi potensi loss: ±60%**

---

## 🚀 Kesimpulan

Waspada AI adalah solusi praktis, murah, dan scalable yang fokus pada pemangkasan beban kerja manual, mempercepat respon internal, dan mengurangi potensi kerugian akibat downtime.  
Sangat tepat masuk kategori **Efficientia – Gede-gedean Cut Cost** dalam AI Competition PaDi UMKM 2025.
