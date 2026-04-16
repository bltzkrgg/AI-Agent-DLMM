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

    let message = '📋 <b>Daftar Strategi DLMM:</b>\n\n';
    strategies.forEach((s, i) => {
      // Aegis Fix: Parameters is already an object from unified strategyManager
      const params = s.parameters || {};
      const deploy = s.deploy || {};
      
      message += `${i + 1}. <b>${s.name}</b>\n`;
      if (s.description) message += `📝 ${s.description}\n`;
      message += `⚙️ Type: <code>${s.type || s.strategy_type || 'spot'}</code>\n`;
      
      const range = deploy.priceRangePct || params.priceRangePercent || 'Auto';
      const step  = params.binStep || 'Auto';
      
      message += `📊 Range: ${range}% | Bin Step: ${step}\n`;
      if (s.created_by || s._db) message += `👤 Source: ${s.created_by || 'Database'}\n`;
      if (s.logic) message += `🔧 Custom logic: Ya\n`;
      message += '\n';
    });

    message += `<i>Gunakan nama strategi saat buka posisi, contoh: "Buka posisi pakai strategi Spot Balanced di pool xxx"</i>`;
    bot.sendMessage(chatId, message, { parse_mode: 'HTML' });
    return;
  }

  // /addstrategy — mulai proses tambah strategi
  if (text.startsWith('/addstrategy')) {
    const parts = text.split(' ');
    const password = parts[1];

    if (!password) {
      bot.sendMessage(chatId, '🔐 Format: <code>/addstrategy &lt;password&gt;</code>', { parse_mode: 'HTML' });
      return;
    }

    if (!verifyAdminPassword(password)) {
      bot.sendMessage(chatId, '❌ Password salah. Akses ditolak.');
      return;
    }

    // Mulai sesi tambah strategi
    pendingSessions.set(userId, { step: 'name', data: {}, action: 'add' });
    bot.sendMessage(chatId,
      '✅ <b>Password benar! Mode Admin aktif.</b>\n\n' +
      '📝 Mari tambah strategi baru.\n\n' +
      '<b>Langkah 1/5:</b> Masukkan nama strategi:\n<i>(contoh: "Spot Aggressive", "Curve Conservative")</i>',
      { parse_mode: 'HTML' }
    );
    return;
  }

  // /deletestrategy — hapus strategi
  if (text.startsWith('/deletestrategy')) {
    const parts = text.split(' ');
    const password = parts[1];
    const name = parts.slice(2).join(' ');

    if (!password || !name) {
      bot.sendMessage(chatId, '🔐 Format: <code>/deletestrategy &lt;password&gt; &lt;nama strategi&gt;</code>', { parse_mode: 'HTML' });
      return;
    }

    if (!verifyAdminPassword(password)) {
      bot.sendMessage(chatId, '❌ Password salah. Akses ditolak.');
      return;
    }

    const deleted = deleteStrategy(name);
    if (deleted) {
      bot.sendMessage(chatId, `✅ Strategi <b>"${name}"</b> berhasil dihapus.`, { parse_mode: 'HTML' });
    } else {
      bot.sendMessage(chatId, `❌ Strategi <b>"${name}"</b> tidak ditemukan atau tidak bisa dihapus (strategi bawaan sistem tidak bisa dihapus).`, { parse_mode: 'HTML' });
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
    case 'name': {
      if (text.length < 3) {
        bot.sendMessage(chatId, '⚠️ Nama terlalu pendek, minimal 3 karakter. Coba lagi:');
        return;
      }
      // Cek duplikat
      if (getStrategyByName(text)) {
        bot.sendMessage(chatId, `⚠️ Strategi dengan nama <b>"${text}"</b> sudah ada. Gunakan nama lain:`, { parse_mode: 'HTML' });
        return;
      }
      data.name = text;
      session.step = 'description';
      bot.sendMessage(chatId,
        `✅ Nama: <b>${text}</b>\n\n<b>Langkah 2/5:</b> Masukkan deskripsi strategi:\n<i>(contoh: "Cocok untuk market sideways dengan volatilitas rendah")</i>`,
        { parse_mode: 'HTML' }
      );
      break;
    }

    case 'description': {
      data.description = text;
      session.step = 'type';
      bot.sendMessage(chatId,
        `✅ Deskripsi tersimpan.\n\n<b>Langkah 3/5:</b> Pilih tipe strategi:\n\n` +
        `• <code>spot</code> — distribusi merata\n` +
        `• <code>curve</code> — terkonsentrasi di tengah\n` +
        `• <code>bid_ask</code> — spread lebar dua sisi\n\n` +
        `Ketik salah satu tipe di atas:`,
        { parse_mode: 'HTML' }
      );
      break;
    }

    case 'type': {
      const validTypes = ['spot', 'curve', 'bid_ask'];
      if (!validTypes.includes(text.toLowerCase())) {
        bot.sendMessage(chatId, '⚠️ Tipe tidak valid. Pilih: <code>spot</code>, <code>curve</code>, atau <code>bid_ask</code>', { parse_mode: 'HTML' });
        return;
      }
      data.strategyType = text.toLowerCase();
      session.step = 'parameters';
      bot.sendMessage(chatId,
        `✅ Tipe: <b>${text}</b>\n\n<b>Langkah 4/5:</b> Masukkan parameter dalam format JSON:\n\n` +
        `<pre><code>{"priceRangePercent": 5, "binStep": 10}</code></pre>\n\n` +
        `Parameter yang tersedia:\n` +
        `• <code>priceRangePercent</code> — range harga dalam % (contoh: 5)\n` +
        `• <code>binStep</code> — ukuran bin (contoh: 10)\n` +
        `• <code>maxActiveBinSlippage</code> — slippage tolerance (contoh: 3)\n` +
        `• Parameter custom lainnya sesuai kebutuhan`,
        { parse_mode: 'HTML' }
      );
      break;
    }

    case 'parameters': {
      try {
        const params = JSON.parse(text);
        if (!params.priceRangePercent || !params.binStep) {
          bot.sendMessage(chatId, '⚠️ Parameter harus mengandung minimal <code>priceRangePercent</code> dan <code>binStep</code>. Coba lagi:', { parse_mode: 'HTML' });
          return;
        }
        data.parameters = params;
        session.step = 'logic';
        bot.sendMessage(chatId,
          `✅ Parameter tersimpan.\n\n<b>Langkah 5/5 (Opsional):</b> Masukkan custom logic dalam JavaScript:\n\n` +
          `Ini untuk mendefinisikan behavior khusus strategi, misalnya kondisi kapan auto-close.\n\n` +
          `Contoh:\n<pre><code>// Auto close kalau price drop &gt; 10%\nif (currentPrice &lt; entryPrice * 0.9) { return 'close'; }</code></pre>\n\n` +
          `Atau ketik <code>skip</code> kalau tidak ada custom logic.`,
          { parse_mode: 'HTML' }
        );
      } catch (e) {
        bot.sendMessage(chatId, '⚠️ Format JSON tidak valid. Contoh yang benar:\n<code>{"priceRangePercent": 5, "binStep": 10}</code>\n\nCoba lagi:', { parse_mode: 'HTML' });
      }
      break;
    }

    case 'logic': {
      data.logic = text.toLowerCase() === 'skip' ? null : text;
      session.step = 'confirm';

      const params = data.parameters;
      let summary = `📋 <b>Konfirmasi Strategi Baru:</b>\n\n`;
      summary += `📌 Nama: <b>${data.name}</b>\n`;
      summary += `📝 Deskripsi: ${data.description}\n`;
      summary += `⚙️ Tipe: <code>${data.strategyType}</code>\n`;
      summary += `📊 Range: ${params.priceRangePercent}% | Bin Step: ${params.binStep}\n`;
      summary += `🔧 Custom logic: ${data.logic ? 'Ya' : 'Tidak'}\n\n`;
      summary += `Ketik <code>ya</code> untuk simpan atau <code>batal</code> untuk membatalkan.`;

      bot.sendMessage(chatId, summary, { parse_mode: 'HTML' });
      break;
    }

    case 'confirm': {
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
            `🎉 <b>Strategi "${data.name}" berhasil ditambahkan!</b>\n\n` +
            `ID: ${result.id}\n\n` +
            `Strategi ini sekarang bisa dipakai dengan mengetik:\n` +
            `<i>"Buka posisi pakai strategi ${data.name} di pool [alamat pool]"</i>`,
            { parse_mode: 'HTML' }
          );
        } catch (e) {
          bot.sendMessage(chatId, `❌ Gagal simpan strategi: ${e.message}`);
        }
      } else if (text.toLowerCase() === 'batal') {
        pendingSessions.delete(userId);
        bot.sendMessage(chatId, '❌ Penambahan strategi dibatalkan.');
      } else {
        bot.sendMessage(chatId, 'Ketik <code>ya</code> untuk simpan atau <code>batal</code> untuk membatalkan.', { parse_mode: 'HTML' });
      }
      break;
    }
  }
}

export function isInStrategySession(userId) {
  return pendingSessions.has(userId);
}

export { pendingSessions };
