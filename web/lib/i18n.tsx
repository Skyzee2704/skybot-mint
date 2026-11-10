// SPDX-License-Identifier: AGPL-3.0-only
// Language: English (default) and Bahasa Indonesia. The English string is the key, so any string not yet
// translated falls back to English automatically — pages can be translated incrementally.
// The choice is stored in localStorage and defaults to English.
"use client";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

export type Lang = "en" | "id";
export const LANGS: { code: Lang; label: string }[] = [
  { code: "en", label: "English" },
  { code: "id", label: "Bahasa Indonesia" },
];
export const LANG_STORAGE_KEY = "skybot-lang";

/** English string -> Indonesian translation. Add entries as pages are translated. */
const ID_STRINGS: Record<string, string> = {
  // Navigation
  Wallets: "Dompet",
  NFTs: "NFT",
  Withdraw: "Tarik",
  Jobs: "Tugas",
  Settings: "Pengaturan",
  More: "Lainnya",
  "Telegram Bot": "Bot Telegram",
  "Sign Out": "Keluar",
  "Sign In": "Masuk",
  "Sign In with Telegram": "Masuk dengan Telegram",

  // App shell
  "Loading…": "Memuat…",
  "Signing you in with Telegram…": "Memasukkan Anda dengan Telegram…",
  "Signing you in…": "Memasukkan Anda…",
  "Signed in with Telegram. Connect with Privy to import or generate wallets.":
    "Masuk dengan Telegram. Hubungkan Privy untuk mengimpor atau membuat dompet.",
  "Connect with Privy": "Hubungkan Privy",
  Language: "Bahasa",

  // Wallets page
  "Wallets ({count})": "Dompet ({count})",
  "updating…": "memperbarui…",
  unavailable: "tidak tersedia",
  "Imported with a private key (held by Privy)": "Diimpor dengan private key (disimpan oleh Privy)",
  "Created by Privy": "Dibuat oleh Privy",
  "Wallets are held by Privy. SkyBOT never sees your private keys. Removing a wallet never moves funds.":
    "Dompet disimpan oleh Privy. SkyBOT tidak pernah melihat private key Anda. Menghapus dompet tidak pernah memindahkan dana.",
  "Refresh Balances": "Perbarui Saldo",
  "Refreshing…": "Memperbarui…",
  "Updated {time}": "Diperbarui {time}",
  "checking…": "memeriksa…",
  Label: "Label",
  Address: "Alamat",
  Balance: "Saldo",
  Main: "Utama",
  Imported: "Diimpor",
  Created: "Dibuat",
  "Set Main": "Jadikan Utama",
  "Main set": "Dompet utama diubah",
  Remove: "Hapus",
  "No wallets yet.": "Belum ada dompet.",
  "Removed wallets ({count})": "Dompet yang dihapus ({count})",
  "Hidden from SkyBOT. They stay in your Privy account with their funds.":
    "Disembunyikan dari SkyBOT. Dompet tetap ada di akun Privy Anda beserta dananya.",
  Restore: "Pulihkan",
  "{label} restored": "{label} dipulihkan",
  "Wallet removed.": "Dompet dihapus.",
  "Create Wallets": "Buat Dompet",
  "Creates Privy embedded wallets owned by you, then syncs them here.":
    "Membuat dompet embedded Privy milik Anda, lalu menyinkronkannya di sini.",
  Generate: "Buat",
  "Created {count}": "Dibuat {count}",
  "Import Private Key": "Impor Private Key",
  "Imported into Privy — SkyBOT only keeps the address + Privy wallet id.":
    "Diimpor ke Privy — SkyBOT hanya menyimpan alamat + id dompet Privy.",
  "Wallet import runs inside Privy, so it needs a Privy session. Connect with Telegram to continue.":
    "Impor dompet berjalan di dalam Privy, jadi perlu sesi Privy. Hubungkan dengan Telegram untuk melanjutkan.",
  "Import via Privy": "Impor via Privy",
  "Imported via Privy": "Diimpor via Privy",
  "Keys are exported only in Privy's own window (Export Private Key in the remove dialog, or home.privy.io); SkyBOT never sees them.":
    "Key hanya bisa diekspor di jendela Privy sendiri (Export Private Key di dialog hapus, atau home.privy.io); SkyBOT tidak pernah melihatnya.",
  "Signed in as {account} · {count} Privy wallet(s) connected": "Masuk sebagai {account} · {count} dompet Privy terhubung",
  "This wallet is already in your Privy account: added it back to SkyBOT Mint.":
    "Dompet ini sudah ada di akun Privy Anda: ditambahkan kembali ke SkyBOT Mint.",

  // Bulk import
  "Bulk Import Private Keys": "Impor Private Key Massal",
  "Paste many private keys, one per line (max {max}). Each goes through the same Privy import as a single key — SkyBOT only keeps the address + Privy wallet id.":
    "Tempel banyak private key, satu per baris (maks {max}). Setiap key melewati impor Privy yang sama seperti impor satu key — SkyBOT hanya menyimpan alamat + id dompet Privy.",
  "Label prefix (optional, e.g. WL)": "Awalan label (opsional, mis. WL)",
  "Import All via Privy": "Impor Semua via Privy",
  "Importing {done}/{total}…": "Mengimpor {done}/{total}…",
  "{imported} imported · {already} already in account · {failed} failed":
    "{imported} diimpor · {already} sudah ada di akun · {failed} gagal",
  imported: "diimpor",
  "already in account": "sudah ada di akun",
  failed: "gagal",
  "Keys are sent only to Privy in your browser, never to SkyBOT's server. The pasted keys are cleared when the import finishes.":
    "Key hanya dikirim ke Privy di browser Anda, tidak pernah ke server SkyBOT. Key yang ditempel akan dihapus setelah impor selesai.",
  "Bulk import finished: {ok} imported/added back, {failed} failed.":
    "Impor massal selesai: {ok} diimpor/ditambahkan kembali, {failed} gagal.",
  "Paste at least one private key.": "Tempel setidaknya satu private key.",
  "Bulk import is limited to {max} keys at a time.": "Impor massal dibatasi {max} key sekali jalan.",
  "Already in your Privy account — added back.": "Sudah ada di akun Privy Anda — ditambahkan kembali.",
  "Imported via Privy.": "Diimpor via Privy.",
  "Imported {count} wallet(s) in Privy, but syncing them to SkyBOT failed: {error}":
    "Berhasil mengimpor {count} dompet di Privy, tapi sinkronisasi ke SkyBOT gagal: {error}",

  // Remove wallet dialog
  "Remove {label}": "Hapus {label}",
  "Primary Privy wallet": "Dompet utama Privy",
  "Checking balances on all chains…": "Memeriksa saldo di semua chain…",
  "This wallet still holds:": "Dompet ini masih berisi:",
  "Unknown balance on {chain} (couldn't be read)": "Saldo tidak diketahui di {chain} (tidak bisa dibaca)",
  "{count} NFT(s) per the last holdings scan": "{count} NFT berdasarkan pemindaian kepemilikan terakhir",
  "Empty on all {count} chains.": "Kosong di semua {count} chain.",
  "Connect with Privy in this browser to export": "Hubungkan dengan Privy di browser ini untuk mengekspor",
  "Withdraw first": "Tarik dana dulu",
  "Send NFTs first": "Kirim NFT dulu",
  "Export Private Key (Privy)": "Ekspor Private Key (Privy)",
  "Connect with Privy in a browser to export, or use home.privy.io.":
    "Hubungkan dengan Privy di browser untuk mengekspor, atau gunakan home.privy.io.",
  "Export failed": "Ekspor gagal",
  "New Main wallet": "Dompet utama baru",
  "I understand funds and NFTs left in this wallet will no longer be accessible from SkyBOT.":
    "Saya mengerti dana dan NFT yang tersisa di dompet ini tidak akan bisa lagi diakses dari SkyBOT.",
  "Remove and Archive in Privy": "Hapus dan Arsipkan di Privy",
  "Remove from SkyBOT": "Hapus dari SkyBOT",
  "Hide from SkyBOT (restorable)": "Sembunyikan dari SkyBOT (bisa dipulihkan)",
  Cancel: "Batal",
  "Remove {label} permanently? This can't be undone in SkyBOT.": "Hapus {label} secara permanen? Ini tidak bisa dibatalkan di SkyBOT.",

  // Landing page
  "Open Telegram Bot": "Buka Bot Telegram",
  "Community Mint Desk": "Pusat Mint Komunitas",
  "Mint faster.": "Mint lebih cepat.",
  "Miss less.": "Lebih jarang ketinggalan.",
  "SkyBOT Mint resolves any OpenSea drop or contract from a link, checks every wallet for allowlist and balance, simulates gas, then mints across your fleet — on web or Telegram.":
    "SkyBOT Mint menyelesaikan drop OpenSea atau kontrak apa pun dari sebuah tautan, memeriksa setiap dompet untuk allowlist dan saldo, mensimulasikan gas, lalu mint di semua dompet Anda — lewat web atau Telegram.",
  "Open Dashboard": "Buka Dashboard",
  "Sign In with Email or Google": "Masuk dengan Email atau Google",
  "Enter App": "Masuk ke Aplikasi",
  "OpenSea + Any Contract": "OpenSea + Kontrak Apa Pun",
  "SeaDrop public & signed stages via the official API, plus generic verified ABIs on 10 chains.":
    "Tahap publik & bertanda SeaDrop lewat API resmi, plus ABI generik terverifikasi di 10 chain.",
  "Allowlist Without Funding": "Allowlist Tanpa Pendanaan",
  "Know who's on the list before you top up. Fake-balance simulation and OpenSea ordering keep checks honest.":
    "Ketahui siapa yang ada di daftar sebelum Anda isi saldo. Simulasi saldo palsu dan pengurutan OpenSea menjaga pemeriksaan tetap jujur.",
  "Your Keys, Privy Custody": "Key Anda, Dijaga Privy",
  "Embedded HD wallets and imports live with Privy. SkyBOT never stores private keys — scheduled mints use session signers.":
    "Dompet HD embedded dan impor tinggal di Privy. SkyBOT tidak pernah menyimpan private key — mint terjadwal memakai session signer.",
  "Telegram Twin": "Kembaran Telegram",
  "Open SkyBOT inside Telegram with the same account. /check any drop for every wallet's eligibility and get notified when mints land.":
    "Buka SkyBOT di dalam Telegram dengan akun yang sama. /check drop apa pun untuk kelayakan setiap dompet dan dapatkan notifikasi saat mint berhasil.",
  Source: "Sumber",

  // Shared components
  "Auto-detect": "Deteksi otomatis",
  "Sending…": "Mengirim…",
  "balance unavailable": "saldo tidak tersedia",

  // Mint page
  // Known server warnings/notes (resolve + eligibility): rendered through t(), so they translate.
  "Sold out (remaining supply is 0).": "Habis terjual (sisa pasokan 0).",
  "Sold out (or not enough supply left for this quantity).": "Habis terjual (atau sisa pasokan tidak cukup untuk jumlah ini).",
  "Public stage has ended.": "Tahap publik sudah berakhir.",
  "Mint price getter not found — enter the price manually; simulation will confirm.":
    "Harga mint tidak ditemukan — masukkan harga secara manual; simulasi akan mengonfirmasi.",
  "Drop restricts fee recipients and none are allowed — public mint cannot be built.":
    "Drop membatasi penerima fee dan tidak ada yang diizinkan — mint publik tidak bisa dibuat.",
  "ERC-1155 SeaDrop drops are not supported by OpenSea's mint API; only on-chain public stage can be attempted.":
    "Drop ERC-1155 SeaDrop tidak didukung API mint OpenSea; hanya tahap publik on-chain yang bisa dicoba.",
  "Kalos lists this drop, but the contract allows the OpenSea SeaDrop, so stages come from OpenSea.":
    "Kalos mencatat drop ini, tapi kontrak mengizinkan OpenSea SeaDrop, jadi tahap diambil dari OpenSea.",
  "The contract allows both SeaDrops. Using Kalos because the link is a Kalos drop.":
    "Kontrak mengizinkan kedua SeaDrop. Memakai Kalos karena tautannya adalah drop Kalos.",
  "The contract allows both SeaDrops. Using OpenSea because the link is not a Kalos drop.":
    "Kontrak mengizinkan kedua SeaDrop. Memakai OpenSea karena tautannya bukan drop Kalos.",
  "The contract's SeaDrop list does not include Kalos or OpenSea. Using the Kalos drop record.":
    "Daftar SeaDrop kontrak tidak mencakup Kalos atau OpenSea. Memakai catatan drop Kalos.",
  "Destination is a smart contract. Make sure it can receive native tokens (exchanges and multisigs may not).":
    "Tujuan adalah smart contract. Pastikan bisa menerima token native (bursa dan multisig mungkin tidak bisa).",
  "You have not sent NFTs to this address before. Double-check every character.":
    "Anda belum pernah mengirim NFT ke alamat ini. Periksa lagi setiap karakternya.",
  "You have not withdrawn to this address before. Double-check every character.":
    "Anda belum pernah menarik ke alamat ini. Periksa lagi setiap karakternya.",
  // Known stage names from the drop APIs (proper names stay as-is; only the description translates)
  "GTD (Guaranteed)": "GTD (Terjamin)",
  "FCFS (First Come, First Served)": "FCFS (Siapa Cepat, Dia Dapat)",
  "Resolving…": "Menyelesaikan…",
  "Checking wallets…": "Memeriksa dompet…",
  "Simulating…": "Mensimulasikan…",
  "Verifying {count} wallet(s) with OpenSea…": "Memverifikasi {count} dompet dengan OpenSea…",
  "wallet(s) couldn't be verified with OpenSea from this device.": "dompet tidak bisa diverifikasi dengan OpenSea dari perangkat ini.",
  "live now": "live sekarang",
  "live · ends {time}": "live · berakhir {time}",
  "starts {time}": "mulai {time}",
  Unknown: "Tidak diketahui",
  Free: "Gratis",
  "No eligible stage is live any more": "Tidak ada tahap yang memenuhi syarat yang sedang live",
  "is no longer available": "tidak lagi tersedia",
  "so timing switched to {name}.": "jadi waktu beralih ke {name}.",
  Mint: "Mint",
  "Paste an OpenSea link, collection slug, or contract address.": "Tempel tautan OpenSea, slug koleksi, atau alamat kontrak.",
  Resolve: "Cari",
  Contract: "Kontrak",
  Chain: "Chain",
  Supply: "Pasokan",
  "({count} left)": "({count} tersisa)",
  Recommended: "Direkomendasikan",
  "Not mintable with SkyBOT": "Tidak bisa di-mint dengan SkyBOT",
  Stage: "Tahap",
  Type: "Tipe",
  Price: "Harga",
  "Max / wallet": "Maks / dompet",
  Schedule: "Jadwal",
  "Live now": "Live sekarang",
  "ends {time}": "berakhir {time}",
  "Starts {time}": "Mulai {time}",
  Upcoming: "Akan datang",
  "Ended {time}": "Berakhir {time}",
  Ended: "Berakhir",
  "Generic Contract": "Kontrak Generik",
  "1 · Strategy": "1 · Strategi",
  "Choose…": "Pilih…",
  price: "harga",
  tokenId: "tokenId",
  "Check all wallets": "Periksa semua dompet",
  "Select wallets": "Pilih dompet",
  "Check Eligibility": "Periksa Kelayakan",
  "Loading wallets…": "Memuat dompet…",
  "{count} wallet(s)": "{count} dompet",
  "Select All": "Pilih Semua",
  Clear: "Bersihkan",
  "No wallets yet. Add some on": "Belum ada dompet. Tambahkan di",
  "2 · Wallet Eligibility": "2 · Kelayakan Dompet",
  "No mint stage is live or scheduled right now.": "Tidak ada tahap mint yang live atau terjadwal saat ini.",
  "Connect with Privy to verify upcoming OpenSea stages for your wallets automatically.":
    "Hubungkan dengan Privy untuk memverifikasi tahap OpenSea mendatang untuk dompet Anda secara otomatis.",
  "{count} unknown": "{count} tidak diketahui",
  "{eligible}/{total} eligible": "{eligible}/{total} memenuhi syarat",
  "Mint immediately": "Mint sekarang",
  Now: "Sekarang",
  "{count} selected": "{count} dipilih",
  "{count} not eligible hidden": "{count} tidak memenuhi syarat disembunyikan",
  Wallet: "Dompet",
  Simulation: "Simulasi",
  Qty: "Jml",
  Cost: "Biaya",
  passes: "lolos",
  "max {count}": "maks {count}",
  "none left": "tidak tersisa",
  "No wallets are eligible for this stage.": "Tidak ada dompet yang memenuhi syarat untuk tahap ini.",
  "No wallets. Add some on {link}.": "Tidak ada dompet. Tambahkan di {link}.",
  "3 · Timing": "3 · Waktu",
  Gas: "Gas",
  Eco: "Hemat",
  Normal: "Normal",
  Aggressive: "Agresif",
  "Offset (ms)": "Offset (ms)",
  Simulate: "Simulasikan",
  "Pick a stage above.": "Pilih tahap di atas.",
  "Runs now": "Berjalan sekarang",
  "Scheduled {time}": "Dijadwalkan {time}",
  "4 · Confirm": "4 · Konfirmasi",
  Value: "Nilai",
  "Max Gas": "Gas Maks",
  "Worst Case": "Kasus Terburuk",
  "Daily / Cap": "Harian / Batas",
  "Stage: {name}": "Tahap: {name}",
  "scheduled for {time}": "dijadwalkan {time}",
  "runs immediately": "berjalan segera",
  "{count} wallet(s) skipped (not eligible)": "{count} dompet dilewati (tidak memenuhi syarat)",
  "Scheduled for {time}": "Dijadwalkan {time}",
  Result: "Hasil",
  "Max Cost": "Biaya Maks",
  "Will mint · ": "Akan mint · ",
  "Ready to mint": "Siap mint",
  "Won't mint · ": "Tidak akan mint · ",
  "Public stage: include anyway (the transaction may fail and still cost gas)":
    "Tahap publik: tetap sertakan (transaksi bisa gagal dan tetap memakan gas)",
  "Technical details": "Detail teknis",
  "Re-simulate": "Simulasikan Ulang",
  "including {count} override(s)": "termasuk {count} pengecualian",
  "I confirm this will broadcast real transactions ({count} mint(s), est. cost up to {cost} {symbol}{suffix}).":
    "Saya mengonfirmasi ini akan menyiarkan transaksi nyata ({count} mint, perkiraan biaya hingga {cost} {symbol}{suffix}).",
  ", at {time}": ", pada {time}",
  "Schedule Mint": "Jadwalkan Mint",
  "Mint Now": "Mint Sekarang",
  "Mint scheduled": "Mint dijadwalkan",
  "Mint started": "Mint dimulai",
  "for {time}": "untuk {time}",
  "Track it on": "Lacak di",
  "Allowlist (signed)": "Allowlist (bertanda)",
  Allowlist: "Allowlist",
  "Token-gated": "Token-gated",
  "max {count}/wallet": "maks {count}/dompet",
  "Mint in {name}": "Mint di {name}",
  Decrease: "Kurangi",
  Increase: "Tambah",
  Quantity: "Jumlah",
  "Quantity for {label}": "Jumlah untuk {label}",
  Public: "Publik",

  // NFTs page
  "Refreshing holdings…": "Menyegarkan kepemilikan…",
  "Scanning wallets for NFTs (first time only)…": "Memindai dompet untuk NFT (hanya pertama kali)…",
  "Checking ownership and gas…": "Memeriksa kepemilikan dan gas…",
  "an earlier transfer from this wallet failed": "transfer sebelumnya dari dompet ini gagal",
  " · checking…": " · memeriksa…",
  " · last full refresh {time}": " · penyegaran penuh terakhir {time}",
  "Refresh in {count}s": "Segarkan dalam {count} dtk",
  Refresh: "Segarkan",
  "NFTs held by your wallets on every supported chain. Holdings are scanned once and saved, so opening this page doesn't use RPC calls. Names and images are checked against each token's on-chain metadata, so revealed collections update automatically. Use Refresh after receiving NFTs elsewhere. Each transfer is signed by your Privy wallet in this browser, and SkyBOT checks it matches what you reviewed before broadcasting.":
    "NFT yang dimiliki dompet Anda di semua chain yang didukung. Kepemilikan dipindai sekali dan disimpan, jadi membuka halaman ini tidak memakai panggilan RPC. Nama dan gambar diperiksa terhadap metadata on-chain tiap token, jadi koleksi yang terungkap diperbarui otomatis. Gunakan Segarkan setelah menerima NFT di tempat lain. Setiap transfer ditandatangani oleh dompet Privy Anda di browser ini, dan SkyBOT memeriksa kecocokannya dengan yang Anda tinjau sebelum disiarkan.",
  "Couldn't scan {count} wallet/chain pairs ({chains}). Previous results are kept; try Refresh later.":
    "Tidak bisa memindai {count} pasangan dompet/chain ({chains}). Hasil sebelumnya disimpan; coba Segarkan nanti.",
  "Some wallets hold more than 1,000 NFTs on a chain; only the first 1,000 are listed.":
    "Beberapa dompet menyimpan lebih dari 1.000 NFT di sebuah chain; hanya 1.000 pertama yang ditampilkan.",
  "All wallets": "Semua dompet",
  "All chains": "Semua chain",
  "All collections": "Semua koleksi",
  "Search name, collection or token ID": "Cari nama, koleksi, atau ID token",
  "By Wallet": "Per Dompet",
  "By Collection": "Per Koleksi",
  "Clear Visible": "Bersihkan yang Terlihat",
  "Select All ({count})": "Pilih Semua ({count})",
  "Clear Selection": "Bersihkan Pilihan",
  "Show {count} likely spam": "Tampilkan {count} kemungkinan spam",
  "{count} selected · {count2} shown": "{count} dipilih · {count2} ditampilkan",
  "No NFTs match these filters.": "Tidak ada NFT yang cocok dengan filter ini.",
  "No NFTs found in your wallets yet.": "Belum ada NFT di dompet Anda.",
  "No image": "Tidak ada gambar",
  "Select {name}": "Pilih {name}",
  "Spam?": "Spam?",
  "Quantity must be 1 to {max}": "Jumlah harus 1 sampai {max}",
  "Send Selected NFTs": "Kirim NFT yang Dipilih",
  "Destination address (0x…)": "Alamat tujuan (0x…)",
  "Review {count} Transfers": "Tinjau {count} Transfer",
  "Review 1 Transfer": "Tinjau 1 Transfer",
  "Enter a full 0x address (42 characters). ENS names are not supported.":
    "Masukkan alamat 0x lengkap (42 karakter). Nama ENS tidak didukung.",
  "Select up to 100 NFTs per batch.": "Pilih hingga 100 NFT per batch.",
  "Confirm Transfer": "Konfirmasi Transfer",
  Destination: "Tujuan",
  "Smart contract on {chains}": "Kontrak pintar di {chains}",
  "Regular wallet (EOA)": "Dompet biasa (EOA)",
  ' · your wallet "{label}"': ' · dompet Anda "{label}"',
  " · used before": " · pernah dipakai",
  NFT: "NFT",
  From: "Dari",
  "Skipped: ": "Dilewati: ",
  Transfers: "Transfer",
  "of {total}": "dari {total}",
  "Fees on {chain}": "Biaya di {chain}",
  "I checked the full destination address above. NFT transfers cannot be reversed.":
    "Saya sudah memeriksa alamat tujuan lengkap di atas. Transfer NFT tidak bisa dibatalkan.",
  "Send {count} Transfers": "Kirim {count} Transfer",
  "Send 1 Transfer": "Kirim 1 Transfer",
  List: "Daftar",
  "{count} per row": "{count} per baris",

  // Withdraw page
  "Preparing withdrawal…": "Menyiapkan penarikan…",
  "Send the native token from one or more of your wallets to a single address. Each transfer is signed by your Privy wallet in this browser; SkyBOT checks that the signed transaction matches what you reviewed before broadcasting it.":
    "Kirim token native dari satu atau beberapa dompet Anda ke satu alamat. Setiap transfer ditandatangani oleh dompet Privy Anda di browser ini; SkyBOT memeriksa bahwa transaksi yang ditandatangani cocok dengan yang Anda tinjau sebelum menyiarkannya.",
  "Withdrawals are signed with your Privy wallet. Connect with Privy to continue.":
    "Penarikan ditandatangani dengan dompet Privy Anda. Hubungkan dengan Privy untuk melanjutkan.",
  "Max for All": "Maks untuk Semua",
  "Select {label}": "Pilih {label}",
  "Amount for {label}": "Jumlah untuk {label}",
  "Review Withdrawal": "Tinjau Penarikan",
  "Confirm Withdrawal": "Konfirmasi Penarikan",
  "Destination on {chain}": "Tujuan di {chain}",
  "Smart contract": "Kontrak pintar",
  "Left in Wallet": "Sisa di Dompet",
  "I checked the full destination address above. Transfers cannot be reversed.":
    "Saya sudah memeriksa alamat tujuan lengkap di atas. Transfer tidak bisa dibatalkan.",

  // Jobs page
  Scheduled: "Dijadwalkan",
  Waiting: "Menunggu",
  Running: "Berjalan",
  Done: "Selesai",
  Failed: "Gagal",
  Cancelled: "Dibatalkan",
  Pending: "Tertunda",
  Signed: "Ditandatangani",
  Sent: "Terkirim",
  Confirmed: "Terkonfirmasi",
  Reverted: "Dibatalkan (revert)",
  "Timed out": "Waktu habis",
  "Cancel this mint? It is about to start. If it sends its transactions before the cancel lands, it can't be stopped.":
    "Batalkan mint ini? Mint akan segera dimulai. Jika transaksinya terkirim sebelum pembatalan sampai, mint tidak bisa dihentikan.",
  "Cancel this scheduled mint? Nothing has been sent yet.": "Batalkan mint terjadwal ini? Belum ada yang terkirim.",
  When: "Kapan",
  Strategy: "Strategi",
  Results: "Hasil",
  "Runs {time}": "Berjalan {time}",
  "created {time}": "dibuat {time}",
  "{count}/{total} confirmed": "{count}/{total} terkonfirmasi",
  "Cancelling…": "Membatalkan…",
  Tx: "Tx",
  "Token IDs": "ID Token",
  "No jobs yet. Simulate and confirm a mint on the Mint page to create one.":
    "Belum ada pekerjaan. Simulasikan dan konfirmasi mint di halaman Mint untuk membuat satu.",

  // Settings page
  "Login linked. You can now sign in with it to reach this same account.":
    "Login tertaut. Anda sekarang bisa masuk dengannya untuk mencapai akun yang sama.",
  "Could not link this login ({code}). It may already belong to another account.":
    "Tidak bisa menautkan login ini ({code}). Mungkin sudah milik akun lain.",
  Saved: "Tersimpan",
  "Sign-In Methods": "Metode Masuk",
  "Email, Google and Telegram all open the same SkyBOT account. Link each one once and use whichever is handy, on the web or inside Telegram.":
    "Email, Google, dan Telegram semuanya membuka akun SkyBOT yang sama. Tautkan masing-masing sekali dan gunakan mana yang nyaman, di web atau di dalam Telegram.",
  "You are signed in with a Telegram session": "Anda masuk dengan sesi Telegram",
  ". Connect with Privy to link email or Google and to import wallets.":
    ". Hubungkan dengan Privy untuk menautkan email atau Google dan mengimpor dompet.",
  "Not linked": "Belum tertaut",
  "Link Telegram": "Tautkan Telegram",
  "Link Email": "Tautkan Email",
  "Link Google": "Tautkan Google",
  "for /mint, /wallets and job notifications.": "untuk /mint, /wallets, dan notifikasi pekerjaan.",
  "Spend Caps (Optional)": "Batas Belanja (Opsional)",
  "Off = unlimited. Always on: {list}": "Mati = tanpa batas. Selalu aktif: {list}",
  "Max Price / NFT": "Harga Maks / NFT",
  "Max Daily Spend": "Belanja Harian Maks",
  "Max / NFT": "Maks / NFT",
  "Max Daily": "Maks Harian",
  "Spent Today": "Terpakai Hari Ini",
  "Save Cap Values": "Simpan Nilai Batas",
  "OpenSea Verification": "Verifikasi OpenSea",
  "To check upcoming OpenSea stages, SkyBOT signs OpenSea's off-chain sign-in message for your wallets (free, no gas, never a transaction), which accepts OpenSea's":
    "Untuk memeriksa tahap OpenSea mendatang, SkyBOT menandatangani pesan masuk off-chain OpenSea untuk dompet Anda (gratis, tanpa gas, bukan transaksi), yang menerima",
  "Chain Health": "Kesehatan Chain",
  "Run Check": "Jalankan Pemeriksaan",
  Block: "Blok",

  // Admin pages
  "Admin · Users": "Admin · Pengguna",
  "Test OpenSea keys": "Uji Key OpenSea",
  "No OpenSea API keys configured.": "Tidak ada key API OpenSea yang dikonfigurasi.",
  Email: "Email",
  Role: "Peran",
  "Last Seen": "Terakhir Dilihat",
  disabled: "dinonaktifkan",
  linked: "tertaut",
  Enable: "Aktifkan",
  Disable: "Nonaktifkan",
  "Admin · Gallery": "Admin · Galeri",
  "Promo clips — private, admin-only. Not publicly hosted; share the downloaded file.":
    "Klip promo — privat, khusus admin. Tidak dihosting publik; bagikan file yang diunduh.",
  Download: "Unduh",

  // Source page
  "Source Code": "Kode Sumber",
  "SkyBOT Mint is free software licensed under the": "SkyBOT Mint adalah perangkat lunak bebas yang dilisensikan di bawah",
  "(AGPL-3.0-only). You are entitled to the complete corresponding source code of the version running on this site.":
    "(AGPL-3.0-only). Anda berhak atas kode sumber lengkap yang sesuai dengan versi yang berjalan di situs ini.",
  "The operator of this instance has not yet configured a public repository link":
    "Operator instans ini belum mengonfigurasi tautan repositori publik",
  "). Please contact the operator to obtain the source code.": "). Silakan hubungi operator untuk mendapatkan kode sumber.",
  "Back to SkyBOT Mint": "Kembali ke SkyBOT Mint",

  // Compact wallet list (search + pagination)
  "Scroll down for more": "Gulir ke bawah untuk melihat lebih banyak",
  "Search wallets…": "Cari dompet…",
  "Search wallets to fund…": "Cari dompet untuk diisi…",
  Previous: "Sebelumnya",
  Next: "Berikutnya",
  "Page {page} of {pages}": "Halaman {page} dari {pages}",
  "{count} wallet(s) found": "{count} dompet ditemukan",
  "No wallets match this search.": "Tidak ada dompet yang cocok dengan pencarian ini.",

  // Fund Wallets
  "Fund Wallets": "Isi Dana Dompet",
  "Set a Main wallet first. Fund Wallets always sends from your Main wallet.":
    "Tetapkan dompet Utama dulu. Isi Dana Dompet selalu mengirim dari dompet Utama Anda.",
  "Split native coin from your Main wallet evenly across your other wallets. Each transfer is signed by your Privy wallet in this browser, and SkyBOT checks it matches what you reviewed before broadcasting.":
    "Bagi koin native dari dompet Utama Anda secara merata ke dompet lain. Setiap transfer ditandatangani oleh dompet Privy Anda di browser ini, dan SkyBOT memeriksa kecocokannya dengan yang Anda tinjau sebelum disiarkan.",
  "Balance {amount}": "Saldo {amount}",
  "Add another wallet to fund it from Main.": "Tambah dompet lain untuk mengisinya dari Utama.",
  "Send to all ({count})": "Kirim ke semua ({count})",
  "{selected} of {total} selected": "{selected} dari {total} dipilih",
  "Total amount to split": "Total yang dibagi",
  Max: "Maks",
  "Main balance minus the network fees of all transfers": "Saldo Utama dikurangi biaya jaringan semua transfer",
  "Review Funding": "Tinjau Pendanaan",
  "Max sends your Main balance minus the exact network fees for every transfer, split evenly. The exact amount per wallet is shown on review.":
    "Maks mengirim saldo Utama Anda dikurangi biaya jaringan yang tepat untuk setiap transfer, dibagi rata. Jumlah pasti per dompet ditampilkan saat peninjauan.",
  "per wallet": "per dompet",
  "({amount} wei rounding stays in Main)": "({amount} wei pembulatan tetap di Utama)",
  "Network fees are added on review.": "Biaya jaringan ditambahkan saat peninjauan.",
  "Enter the total to split evenly across the selected wallets.": "Masukkan total untuk dibagi rata ke dompet yang dipilih.",
  "The amount is more than your Main balance on this chain.": "Jumlahnya melebihi saldo Utama Anda di chain ini.",
  "Preparing transfers…": "Menyiapkan transfer…",
  "Stopped. Nothing was sent.": "Dihentikan. Tidak ada yang terkirim.",
  "not sent because an earlier transfer did not go through": "tidak terkirim karena transfer sebelumnya gagal",
  "stopped before signing": "dihentikan sebelum penandatanganan",
  queued: "antre",
  signing: "menandatangani",
  sent: "terkirim",
  confirmed: "terkonfirmasi",
  skipped: "dilewati",
  "Confirm Funding": "Konfirmasi Pendanaan",
  "From Main on {chain}": "Dari Utama di {chain}",
  "balance {amount}": "saldo {amount}",
  To: "Ke",
  Amount: "Jumlah",
  "Network Fee": "Biaya Jaringan",
  Status: "Status",
  Ready: "Siap",
  View: "Lihat",
  "Total Sent": "Total Terkirim",
  "Total Network Fees": "Total Biaya Jaringan",
  "Left in Main": "Sisa di Utama",
  "Waiting for your wallet signature (up to 60s per transfer)…": "Menunggu tanda tangan dompet Anda (hingga 60 dtk per transfer)…",
  Stop: "Berhenti",
  "{sent} of {total} transfers sent": "{sent} dari {total} transfer terkirim",
  "{count} not sent": "{count} tidak terkirim",
  "Retry {count} Unsent": "Coba Lagi {count} yang Belum Terkirim",
  Close: "Tutup",
  "I reviewed the amounts above. Transfers cannot be reversed.": "Saya sudah meninjau jumlah di atas. Transfer tidak bisa dibatalkan.",
  "Transfers are signed with your Privy wallet. Connect with Privy to send.":
    "Transfer ditandatangani dengan dompet Privy Anda. Hubungkan Privy untuk mengirim.",
};

function interpolate(text: string, vars?: Record<string, string | number>): string {
  if (!vars) return text;
  let out = text;
  for (const [k, v] of Object.entries(vars)) out = out.replaceAll(`{${k}}`, String(v));
  return out;
}

export function translate(lang: Lang, text: string, vars?: Record<string, string | number>): string {
  const base = lang === "id" ? (ID_STRINGS[text] ?? text) : text;
  return interpolate(base, vars);
}

type LangState = { lang: Lang; setLang: (l: Lang) => void; t: (text: string, vars?: Record<string, string | number>) => string };
const LangCtx = createContext<LangState>({ lang: "en", setLang: () => {}, t: (text, vars) => translate("en", text, vars) });

export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>("en");
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(LANG_STORAGE_KEY);
      if (saved === "en" || saved === "id") setLangState(saved);
    } catch {
      /* ignore */
    }
  }, []);
  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    try {
      window.localStorage.setItem(LANG_STORAGE_KEY, l);
    } catch {
      /* ignore */
    }
  }, []);
  const t = useCallback((text: string, vars?: Record<string, string | number>) => translate(lang, text, vars), [lang]);
  return <LangCtx.Provider value={{ lang, setLang, t }}>{children}</LangCtx.Provider>;
}

export function useLang(): LangState {
  return useContext(LangCtx);
}

/** English / Bahasa Indonesia switch (default English, choice saved in localStorage). */
export function LangSwitch() {
  const { lang, setLang, t } = useLang();
  return (
    <span className="lang-switch" role="group" aria-label={t("Language")}>
      {LANGS.map((l) => (
        <button key={l.code} type="button" className={lang === l.code ? "active" : ""} onClick={() => setLang(l.code)}>
          {l.code.toUpperCase()}
        </button>
      ))}
    </span>
  );
}
