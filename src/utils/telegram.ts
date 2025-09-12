import TelegramBot from 'node-telegram-bot-api';
import { AppConfig } from '../config';
import { logger } from './logger';

let bot: TelegramBot | null = null;
let cachedToken = '';

function getBot(config: AppConfig): TelegramBot | null {
  const token = config.telegram.botToken;
  if (!token || !config.telegram.chatId) return null;
  if (bot && cachedToken === token) return bot;
  try {
    bot = new TelegramBot(token, { polling: false });
    cachedToken = token;
    return bot;
  } catch (e) {
    logger.warn('Failed to initialize Telegram bot:', e);
    return null;
  }
}

export async function sendTelegram(config: AppConfig, text: string) {
  try {
    const b = getBot(config);
    if (!b) return;
    await b.sendMessage(config.telegram.chatId, text, { disable_web_page_preview: true });
  } catch (e) {
    logger.warn('Failed to send Telegram message:', (e as Error)?.message ?? e);
  }
}

