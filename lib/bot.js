require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const rateLimit = require('express-rate-limit');
const mongoose = require('mongoose');
const sanitizeHtml = require('sanitize-html');
const PQueue = require('p-queue').default;

const API_KEY = process.env.TELEGRAM_API_KEY;
const MONGO_URI = process.env.MONGO_URI;
const ADMIN_ID = 7804932882;

if (!API_KEY || !MONGO_URI) {
    console.error('Error: TELEGRAM_API_KEY and MONGO_URI must be set in .env file');
    process.exit(1);
}

if (!PQueue) {
    console.error('PQueue is not defined. Ensure p-queue is installed correctly.');
    process.exit(1);
}

mongoose.connect(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
    .then(() => console.log('Connected to MongoDB'))
    .catch(err => {
        console.error('MongoDB connection error:', err);
        process.exit(1);
    });

const InteractionSchema = new mongoose.Schema({
    userId: Number,
    username: String,
    action: String,
    details: Object,
    timestamp: { type: Date, default: Date.now },
});
const Interaction = mongoose.model('Interaction', InteractionSchema);

const bot = new TelegramBot(API_KEY, { polling: true });

const queue = new PQueue({ concurrency: 5 });

async function withRetry(fn, retries = 3, delay = 1000) {
    for (let i = 0; i < retries; i++) {
        try {
            return await fn();
        } catch (error) {
            console.error(`Retry ${i + 1}/${retries} failed:`, error.message);
            if (i === retries - 1) throw error;
            await new Promise(resolve => setTimeout(resolve, delay * Math.pow(2, i)));
        }
    }
}

async function botMethod(method, data) {
    try {
        const url = `https://api.telegram.org/bot${API_KEY}/${method}`;
        const response = await withRetry(() => axios.post(url, data));
        return response.data;
    } catch (error) {
        console.error(`Error in ${method}:`, error.message);
        bot.sendMessage(ADMIN_ID, `⚠️ API Error in ${method}: ${error.message}`);
        return null;
    }
}

async function logInteraction(userId, username, action, details) {
    try {
        await Interaction.create({ userId, username, action, details });
    } catch (error) {
        console.error('Error logging interaction:', error);
        bot.sendMessage(ADMIN_ID, `⚠️ MongoDB Error: ${error.message}`);
    }
}

function validateScribdUrl(url) {
    if (!url || typeof url !== 'string') return false;
    const sanitized = sanitizeHtml(url, { allowedTags: [], allowedAttributes: {} });
    return sanitized.includes('scribd.com') && /\d+/.test(sanitized);
}

bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const name = msg.from.first_name || 'User';
    const userId = msg.from.id;
    const username = `@${msg.from.username || 'unknown'}`;
    await logInteraction(userId, username, 'start', { command: '/start' });

    await bot.sendMessage(chatId, `📚 Welcome ${name} to Scribd Downloader bot! 📖\n\nSend a Scribd document link to download it. Use /help for more options.`, {
        reply_to_message_id: msg.message_id,
        disable_web_page_preview: true,
        reply_markup: {
            inline_keyboard: [
                [{ text: 'Developer 💚', url: 'https://t.me/spacenx1' }],
                [{ text: 'How to Use 📘', url: 'https://t.me/cheggnx/58' }],
                [{ text: 'Support 🛠️', url: 'https://t.me/spacenx1' }],
            ],
        },
    });
});

bot.onText(/\/help/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const username = `@${msg.from.username || 'unknown'}`;
    await logInteraction(userId, username, 'help', { command: '/help' });

    await bot.sendMessage(chatId, 'Available commands:\n/start - Start the bot\n/help - Show this help message\n/stats - View your usage stats', {
        reply_to_message_id: msg.message_id,
    });
});

bot.onText(/\/send/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    if (userId !== ADMIN_ID) return bot.sendMessage(chatId, '⛔ You are not authorized to use this command.');

    const promoMessage = `
Hey @nxproversion 🔓 🔰 |

🚀 <b>Unlock Exclusive Opportunities with CodeworksNX!</b>

Join <b>CodeworksNX</b>—a leading freelance and job placement platform designed to connect talent with the right opportunities!

🔥 <b>Why join?</b>  
✅ Find high-paying freelance gigs  
✅ Explore career-boosting job placements  
✅ Get access to AI-powered productivity tools (coming soon!)

🎯 <b>Register now and take the first step toward success!</b>  
👉 <a href="https://codeworksnx.com">Sign Up Here</a>

#CodeworksNX #FreelanceJobs #JobPlacement #AI #TechStartup #Innovation
`;

    try {
        const users = await Interaction.aggregate([
            { $match: { action: 'scribd_download' } },
            { $group: { _id: '$userId', username: { $first: '$username' } } }
        ]);

        bot.sendMessage(chatId, `📢 Broadcasting message to ${users.length} users...`);

        for (const user of users) {
            queue.add(() =>
                bot.sendMessage(user._id, promoMessage, {
                    parse_mode: 'HTML',
                    disable_web_page_preview: false,
                }).catch(err => console.error(`❌ Failed to message ${user._id} (${user.username}):`, err.message))
            );
        }
    } catch (error) {
        console.error('❌ Error during broadcast:', error);
        bot.sendMessage(chatId, '❌ Failed to broadcast message.');
    }
});

bot.onText(/\/broadcast (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    if (userId !== ADMIN_ID) return bot.sendMessage(chatId, '⛔ You are not authorized to use this command.');

    const message = match[1];
    if (!message) return bot.sendMessage(chatId, '❌ Please provide a message to broadcast.');

    try {
        const users = await Interaction.aggregate([
            { $match: { action: 'scribd_download' } },
            { $group: { _id: '$userId', username: { $first: '$username' } } }
        ]);

        bot.sendMessage(chatId, `📢 Broadcasting to ${users.length} users...`);

        for (const user of users) {
            queue.add(() =>
                bot.sendMessage(user._id, `📢 Broadcast:\n\n${message}`)
                    .catch(err => console.error(`Failed to message ${user._id} (${user.username}):`, err.message))
            );
        }
    } catch (error) {
        console.error('Error during broadcast:', error);
        bot.sendMessage(chatId, '❌ Error broadcasting message.');
    }
});

bot.onText(/\/stats/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const username = `@${msg.from.username || 'unknown'}`;

    try {
        const stats = await Interaction.countDocuments({ userId });
        await logInteraction(userId, username, 'stats', { command: '/stats', count: stats });
        await bot.sendMessage(chatId, `📊 Your stats:\nTotal interactions: ${stats}`, {
            reply_to_message_id: msg.message_id,
        });
    } catch (error) {
        console.error('Error fetching stats:', error);
        await bot.sendMessage(chatId, '❌ Error fetching stats. Try again later.', {
            reply_to_message_id: msg.message_id,
        });
    }
});

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const fromId = msg.from?.id;
    const user = `@${msg.from?.username || 'unknown'}`;
    const name = msg.from?.first_name || 'User';
    const text = msg.text || '';
    const messageId = msg.message_id;

    try {
        const joinStatus1 = (await botMethod('getChatMember', { chat_id: '@cheggnx', user_id: fromId }))?.result?.status;
        const joinStatus2 = (await botMethod('getChatMember', { chat_id: '@CheggbyTnTbot', user_id: fromId }))?.result?.status;

        if ([joinStatus1, joinStatus2].includes('left') || [joinStatus1, joinStatus2].includes('kicked')) {
            await bot.deleteMessage(chatId, messageId);
            await bot.sendMessage(fromId, `Welcome ${name} 🔓 🔰 | You must subscribe to the channels to use the bot for free.`, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '• Join Channel 1 - ', url: 'https://t.me/cheggnx' }],
                        [{ text: '• Join Channel 2 - ', url: 'https://t.me/CheggbyTnTbot' }],
                    ],
                },
            });
            return;
        }
    } catch (error) {
        console.error('Error checking channel subscription:', error);
        await bot.sendMessage(chatId, '❌ Error checking channel subscription. Try again later.', {
            reply_to_message_id: messageId,
        });
        return;
    }

    if (validateScribdUrl(text)) {
        await queue.add(async () => {
            try {
                const linkParts = text.split(' ').find((part) => part.includes('scribd.com'));
                const matches = linkParts.match(/\d+/g);
                if (!matches || !matches[0]) {
                    await bot.sendMessage(chatId, messages.en.invalidUrl, {
                        reply_to_message_id: messageId,
                    });
                    return;
                }

                const documentId = matches[0];
                const scrii = `https://www.scribd.com/embeds/${documentId}/content`;

                await logInteraction(fromId, user, 'scribd_download', { documentId, url: text });

                await bot.sendMessage(chatId, `📚 Welcome ${name} to Scribd Downloader bot! 📖\n\nSend a Scribd document link to download it.`, {
                    reply_to_message_id: messageId,
                    disable_web_page_preview: true,
                    parse_mode: 'HTML',
                });

                await bot.sendMessage(chatId, `📚 Welcome ${name} to Scribd Downloader bot\n👁‍🗨: ${user}\nYour Document ✅: <a href='${scrii}'>Click Here</a>\n\nMade With ❤ By @spacenx1\n\nHello ${user}! 👋\n\nThank you for your support. Please follow us on Instagram: https://www.instagram.com/mustaqeem_abad/.`, {
                    reply_to_message_id: messageId,
                    disable_web_page_preview: true,
                    parse_mode: 'HTML',
                    reply_markup: {
                        inline_keyboard: [[{ text: 'Download Document ✅', url: scrii }]],
                    },
                });

                bot.sendMessage(ADMIN_ID, `User Name: ${user}\n\nLink: ${text}`);
            } catch (error) {
                console.error('Error processing Scribd link:', error);
                await bot.sendMessage(chatId, '❌ Error downloading document. Please try again.', {
                    reply_to_message_id: messageId,
                });
            }
        });
    }
});

bot.on('callback_query', async (callbackQuery) => {
    const userId = callbackQuery.from.id;
    const username = `@${callbackQuery.from.username || 'unknown'}`;

    try {
        await logInteraction(userId, username, 'callback_query', { data: callbackQuery.data });
        await bot.answerCallbackQuery(callbackQuery.id);
    } catch (error) {
        console.error('Error handling callback query:', error);
    }
});

bot.on('polling_error', (error) => {
    console.error('Polling error:', error);
    bot.sendMessage(ADMIN_ID, `⚠️ Polling error: ${error.message}`);
});

const messages = {
    en: {
        welcome: '📚 Welcome {name} to Scribd Downloader bot! 📖\n\nSend a Scribd document link to download it.',
        invalidUrl: '❌ Invalid Scribd URL. Please provide a valid link.',
    },
    es: {
        welcome: '📚 ¡Bienvenido {name} al bot de descarga de Scribd! 📖\n\nEnvía un enlace de documento de Scribd para descargarlo.',
        invalidUrl: '❌ URL de Scribd no válida. Por favor, proporciona un enlace válido.',
    },
};

const http = require('http');
http.createServer((req, res) => {
    res.writeHead(200);
    res.end('Bot is running');
}).listen(process.env.PORT || 3000);

module.exports = { bot };
