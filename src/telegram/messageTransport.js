const TG_MAX = 4000;

function splitText(text) {
  if (text.length <= TG_MAX) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= TG_MAX) {
      chunks.push(remaining);
      break;
    }
    let cutAt = remaining.lastIndexOf('\n', TG_MAX);
    // If no newline found before TG_MAX, cut at TG_MAX
    // Otherwise, cut at the newline position (but keep at least 50% of TG_MAX)
    if (cutAt === -1 || cutAt < TG_MAX * 0.5) {
      cutAt = TG_MAX;
    }
    chunks.push(remaining.slice(0, cutAt));
    remaining = remaining.slice(cutAt).trimStart();
  }
  return chunks;
}

export function createMessageTransport(bot, allowedId) {
  async function sendLong(chatId, text, opts = {}) {
    const chunks = splitText(String(text));
    const finalOpts = {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...opts
    };

    for (const chunk of chunks) {
      try {
        await bot.sendMessage(chatId, chunk, finalOpts);
      } catch (e) {
        // Fallback: Jika HTML rusak (karena data dinamis/AI), kirim sebagai teks polos
        if (e.message?.includes('parse') || e.message?.includes('Bad Request')) {
          try {
            const plainOpts = { ...finalOpts };
            delete plainOpts.parse_mode;
            await bot.sendMessage(chatId, chunk, plainOpts);
          } catch (e2) {
            console.error('sendLong fallback error:', e2.message);
          }
        } else {
          console.error('sendLong error:', e.message);
        }
      }
    }
  }

  async function notify(text, opts = {}) {
    return sendLong(allowedId, text, opts);
  }

  // updateStatus: Mengedit pesan yang sudah ada untuk progres real-time
  async function updateStatus(chatId, messageId, text, opts = {}) {
    if (!messageId) return null;
    try {
      return await bot.editMessageText(text, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...opts
      });
    } catch (e) {
      // Ignore "message is not modified" errors
      if (!e.message?.includes('message is not modified')) {
        console.error('updateStatus error:', e.message);
      }
      return null;
    }
  }

  return { sendLong, notify, updateStatus };
}
