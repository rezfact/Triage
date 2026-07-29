import TelegramBot from 'node-telegram-bot-api';
import { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } from '../config.js';

export const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

/**
 * Edit a Telegram message in-place, falling back to sendMessage when editing fails.
 * Shared by callbacks, input, and menus — canonical copy lives here.
 */
export async function editMenuMessage(query, text, extra = {}) {
  const chatId = query.message?.chat?.id || TELEGRAM_CHAT_ID;
  const messageId = query.message?.message_id;
  if (!messageId) {
    return bot.sendMessage(chatId, text, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...extra,
    });
  }
  try {
    return await bot.editMessageText(text, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...extra,
    });
  } catch (err) {
    if (/message is not modified/i.test(err.message)) return null;
    return bot.sendMessage(chatId, text, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...extra,
    });
  }
}
