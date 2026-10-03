export const TELEGRAM_COMMANDS = Object.freeze([
  { command: 'start', description: 'Buka menu utama bot' },
  { command: 'status', description: 'Lihat status agent dan posisi aktif' },
  { command: 'tokenalerts', description: 'Kelola Solana Token Runner' },
  { command: 'robinhood', description: 'Kelola Robinhood Token Runner' },
  { command: 'hunt', description: 'Mulai loop agent' },
  { command: 'stop', description: 'Hentikan loop agent' },
  { command: 'screening', description: 'Jalankan screening pool sekarang' },
  { command: 'autoscreen', description: 'Atur auto-screening' },
  { command: 'ca', description: 'Analisis CA atau pool Meteora' },
  { command: 'balance', description: 'Lihat saldo wallet' },
  { command: 'briefing', description: 'Lihat laporan agent' },
  { command: 'config', description: 'Lihat konfigurasi aktif' },
  { command: 'setconfig', description: 'Ubah konfigurasi bot' },
  { command: 'manualexit', description: 'Atur manual TA exit' },
  { command: 'dryrun', description: 'Atur mode dry run' },
  { command: 'paper', description: 'Lihat posisi paper' },
  { command: 'paperclose', description: 'Tutup posisi paper' },
  { command: 'exit', description: 'Tutup posisi aktif' },
  { command: 'block', description: 'Tambahkan token ke blocklist' },
  { command: 'unblock', description: 'Hapus token dari blocklist' },
  { command: 'blacklist', description: 'Lihat blacklist token' },
  { command: 'evolve', description: 'Lihat saran evolusi config' },
  { command: 'strategy_report', description: 'Lihat laporan strategi' },
  { command: 'claim_fees', description: 'Klaim fee posisi' },
]);

export async function registerTelegramCommandMenu(bot, chatId) {
  const scope = { type: 'chat', chat_id: chatId };

  await bot.setMyCommands(TELEGRAM_COMMANDS, { scope });
  await bot.setChatMenuButton({
    chat_id: chatId,
    menu_button: { type: 'commands' },
  });
}
