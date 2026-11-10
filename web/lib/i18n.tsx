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

  // Shared components
  "Auto-detect": "Deteksi otomatis",
  "Sending…": "Mengirim…",
  "balance unavailable": "saldo tidak tersedia",

  // Fund Wallets
  "Fund Wallets": "Isi Dana Dompet",
  "Set a Main wallet first. Fund Wallets always sends from your Main wallet.":
    "Tetapkan dompet Utama dulu. Isi Dana Dompet selalu mengirim dari dompet Utama Anda.",
  "Split native coin from your Main wallet evenly across your other wallets. Each transfer is signed by your Privy wallet in this browser, and SkyBOT checks it matches what you reviewed before broadcasting.":
    "Bagi koin native dari dompet Utama Anda secara merata ke dompet lain. Setiap transfer ditandatangani oleh dompet Privy Anda di browser ini, dan SkyBOT memeriksa kecocokannya dengan yang Anda tinjau sebelum disiarkan.",
  From: "Dari",
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
  "Send {count} Transfers": "Kirim {count} Transfer",
  "Send 1 Transfer": "Kirim 1 Transfer",
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
