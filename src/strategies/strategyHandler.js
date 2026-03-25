import { addStrategy, updateStrategy, deleteStrategy, getAllStrategies, getStrategyByName } from './strategyManager.js';

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

if (!ADMIN_PASSWORD) {
  console.warn('⚠️  ADMIN_PASSWORD tidak di-set di .env — fitur /addstrategy dan /dryrun tidak akan bisa dipakai.');
}

// State untuk track user yang lagi dalam proses tambah strategi
const pendingSessions = new Map();

// Verifikasi password admin
export function verifyAdminPassword(password) {
  if (!ADMIN_PASSWORD) return false;
  return password === ADMIN_PASSWORD;
}

// Parse pesan strategi dari Telegram
// Format yang diterima:
// /addstrategy <password>
// Lalu bot akan tanya step by step
export function handleStrategyCommand(bot, msg, allowedUserId) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = msg.text || '';

  if (userId !== allowedUserId) return;

  // /strategies — lihat semua strategi
  if (text === '/strategies') {
    const strategies = getAllStrategies();
    if (strategies.length === 0) {
      bot.sendMessage(chatId, '📭 Belum ada strategi tersimpan.');
      return;
    }

    let message = '📋 *Daftar Strategi DLMM:*\n\n';
    strategies.forEach((s, i) => {
      const params = JSON.parse(s.parameters);
      message += `*${i + 1}. ${s.name}*\n`;
      message += `📝 ${s.description}\n`;
      message += `⚙️ Type: \`${s.strategy_type}\`\n`;
      message += `📊 Range: ${params.priceRangePercent}% | Bin Step: ${params.binStep}\n`;
      message += `👤 Dibuat: ${s.created_by}\n`;
      if (s.logic) message += `🔧 Custom logic: Ya\n`;
      message += '\n';
    });

    message += `_Gunakan nama strategi saat buka posisi, contoh: "Buka posisi pakai strategi Spot Balanced di pool xxx"_`;
    bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    return;
  }

  // /addstrategy — mulai proses tambah strategi
  if (text.startsWith('/addstrategy')) {
    const parts = text.split(' ');
    const password = parts[1];

    if (!password) {
      bot.sendMessage(chatId, '🔐 Format: `/addstrategy <password>`', { parse_mode: 'Markdown' });
      return;
    }

    if (!verifyAdminPassword(password)) {
      bot.sendMessage(chatId, '❌ Password salah. Akses ditolak.');
      return;
    }

    // Mulai sesi tambah strategi
    pendingSessions.set(userId, { step: 'name', data: {}, action: 'add' });
    bot.sendMessage(chatId,
      '✅ *Password benar! Mode Admin aktif.*\n\n' +
      '📝 Mari tambah strategi baru.\n\n' +
      '*Langkah 1/5:* Masukkan nama strategi:\n_(contoh: "Spot Aggressive", "Curve Conservative")_',
      { parse_mode: 'Markdown' }
    );
    return;
  }

  // /deletestrategy — hapus strategi
  if (text.startsWith('/deletestrategy')) {
    const parts = text.split(' ');
    const password = parts[1];
    const name = parts.slice(2).join(' ');

    if (!password || !name) {
      bot.sendMessage(chatId, '🔐 Format: `/deletestrategy <password> <nama strategi>`', { parse_mode: 'Markdown' });
      return;
    }

    if (!verifyAdminPassword(password)) {
      bot.sendMessage(chatId, '❌ Password salah. Akses ditolak.');
      return;
    }

    const deleted = deleteStrategy(name);
    if (deleted) {
      bot.sendMessage(chatId, `✅ Strategi *"${name}"* berhasil dihapus.`, { parse_mode: 'Markdown' });
    } else {
      bot.sendMessage(chatId, `❌ Strategi *"${name}"* tidak ditemukan atau tidak bisa dihapus (strategi bawaan sistem tidak bisa dihapus).`, { parse_mode: 'Markdown' });
    }
    return;
  }

  // Handle conversation steps untuk tambah strategi
  const session = pendingSessions.get(userId);
  if (!session) return false;

  handleStrategySteps(bot, chatId, userId, text, session);
  return true;
}

function handleStrategySteps(bot, chatId, userId, text, session) {
  const { step, data } = session;

  switch (step) {
    case 'name':
      if (text.length < 3) {
        bot.sendMessage(chatId, '⚠️ Nama terlalu pendek, minimal 3 karakter. Coba lagi:');
        return;
      }
      // Cek duplikat
      if (getStrategyByName(text)) {
        bot.sendMessage(chatId, `⚠️ Strategi dengan nama *"${text}"* sudah ada. Gunakan nama lain:`, { parse_mode: 'Markdown' });
        return;
      }
      data.name = text;
      session.step = 'description';
      bot.sendMessage(chatId,
        `✅ Nama: *${text}*\n\n*Langkah 2/5:* Masukkan deskripsi strategi:\n_(contoh: "Cocok untuk market sideways dengan volatilitas rendah")_`,
        { parse_mode: 'Markdown' }
      );
      break;

    case 'description':
      data.description = text;
      session.step = 'type';
      bot.sendMessage(chatId,
        `✅ Deskripsi tersimpan.\n\n*Langkah 3/5:* Pilih tipe strategi:\n\n` +
        `• \`spot\` — distribusi merata\n` +
        `• \`curve\` — terkonsentrasi di tengah\n` +
        `• \`bid_ask\` — spread lebar dua sisi\n\n` +
        `Ketik salah satu tipe di atas:`,
        { parse_mode: 'Markdown' }
      );
      break;

    case 'type':
      const validTypes = ['spot', 'curve', 'bid_ask'];
      if (!validTypes.includes(text.toLowerCase())) {
        bot.sendMessage(chatId, '⚠️ Tipe tidak valid. Pilih: `spot`, `curve`, atau `bid_ask`', { parse_mode: 'Markdown' });
        return;
      }
      data.strategyType = text.toLowerCase();
      session.step = 'parameters';
      bot.sendMessage(chatId,
        `✅ Tipe: *${text}*\n\n*Langkah 4/5:* Masukkan parameter dalam format JSON:\n\n` +
        `Contoh:\n\`\`\`\n{"priceRangePercent": 5, "binStep": 10}\n\`\`\`\n\n` +
        `Parameter yang tersedia:\n` +
        `• \`priceRangePercent\` — range harga dalam % (contoh: 5)\n` +
        `• \`binStep\` — ukuran bin (contoh: 10)\n` +
        `• \`maxActiveBinSlippage\` — slippage tolerance (contoh: 3)\n` +
        `• Parameter custom lainnya sesuai kebutuhan`,
        { parse_mode: 'Markdown' }
      );
      break;

    case 'parameters':
      try {
        const params = JSON.parse(text);
        if (!params.priceRangePercent || !params.binStep) {
          bot.sendMessage(chatId, '⚠️ Parameter harus mengandung minimal `priceRangePercent` dan `binStep`. Coba lagi:', { parse_mode: 'Markdown' });
          return;
        }
        data.parameters = params;
        session.step = 'logic';
        bot.sendMessage(chatId,
          `✅ Parameter tersimpan.\n\n*Langkah 5/5 (Opsional):* Masukkan custom logic dalam JavaScript:\n\n` +
          `Ini untuk mendefinisikan behavior khusus strategi, misalnya kondisi kapan auto-close.\n\n` +
          `Contoh:\n\`\`\`\n// Auto close kalau price drop > 10%\nif (currentPrice < entryPrice * 0.9) { return 'close'; }\n\`\`\`\n\n` +
          `Atau ketik \`skip\` kalau tidak ada custom logic.`,
          { parse_mode: 'Markdown' }
        );
      } catch (e) {
        bot.sendMessage(chatId, '⚠️ Format JSON tidak valid. Contoh yang benar:\n`{"priceRangePercent": 5, "binStep": 10}`\n\nCoba lagi:', { parse_mode: 'Markdown' });
      }
      break;

    case 'logic':
      data.logic = text.toLowerCase() === 'skip' ? null : text;
      session.step = 'confirm';

      const params = data.parameters;
      let summary = `📋 *Konfirmasi Strategi Baru:*\n\n`;
      summary += `📌 Nama: *${data.name}*\n`;
      summary += `📝 Deskripsi: ${data.description}\n`;
      summary += `⚙️ Tipe: \`${data.strategyType}\`\n`;
      summary += `📊 Range: ${params.priceRangePercent}% | Bin Step: ${params.binStep}\n`;
      summary += `🔧 Custom logic: ${data.logic ? 'Ya' : 'Tidak'}\n\n`;
      summary += `Ketik \`ya\` untuk simpan atau \`batal\` untuk membatalkan.`;

      bot.sendMessage(chatId, summary, { parse_mode: 'Markdown' });
      break;

    case 'confirm':
      if (text.toLowerCase() === 'ya') {
        try {
          const result = addStrategy({
            name: data.name,
            description: data.description,
            strategyType: data.strategyType,
            parameters: data.parameters,
            logic: data.logic,
            createdBy: 'admin',
          });

          pendingSessions.delete(userId);
          bot.sendMessage(chatId,
            `🎉 *Strategi "${data.name}" berhasil ditambahkan!*\n\n` +
            `ID: ${result.id}\n\n` +
            `Strategi ini sekarang bisa dipakai dengan mengetik:\n` +
            `_"Buka posisi pakai strategi ${data.name} di pool [alamat pool]"_`,
            { parse_mode: 'Markdown' }
          );
        } catch (e) {
          bot.sendMessage(chatId, `❌ Gagal simpan strategi: ${e.message}`);
        }
      } else if (text.toLowerCase() === 'batal') {
        pendingSessions.delete(userId);
        bot.sendMessage(chatId, '❌ Penambahan strategi dibatalkan.');
      } else {
        bot.sendMessage(chatId, 'Ketik `ya` untuk simpan atau `batal` untuk membatalkan.', { parse_mode: 'Markdown' });
      }
      break;
  }
}

export function isInStrategySession(userId) {
  return pendingSessions.has(userId);
}

export { pendingSessions };
