const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const TelegramBot = require('node-telegram-bot-api');
const mongoose = require('mongoose');

// Lightweight In-Memory Async Queue (Compatible with all Node.js / Serverless versions)
class SimpleQueue {
  constructor(options = {}) {
    this.concurrency = options.concurrency || 5;
    this.interval = options.interval || 0;
    this.intervalCap = options.intervalCap || this.concurrency;
    this.queue = [];
    this.running = 0;
    this.idleResolvers = [];
    this.sentInInterval = 0;
    this.intervalStartTime = Date.now();
  }

  async add(fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      this._process();
    });
  }

  async _process() {
    if (this.queue.length === 0) {
      if (this.running === 0) {
        this.idleResolvers.forEach((res) => res());
        this.idleResolvers = [];
      }
      return;
    }

    if (this.running >= this.concurrency) return;

    if (this.interval > 0) {
      const now = Date.now();
      if (now - this.intervalStartTime >= this.interval) {
        this.sentInInterval = 0;
        this.intervalStartTime = now;
      }
      if (this.sentInInterval >= this.intervalCap) {
        const wait = this.interval - (now - this.intervalStartTime) + 15;
        setTimeout(() => this._process(), wait);
        return;
      }
      this.sentInInterval++;
    }

    this.running++;
    const { fn, resolve, reject } = this.queue.shift();

    (async () => {
      try {
        const res = await fn();
        resolve(res);
      } catch (err) {
        reject(err);
      } finally {
        this.running--;
        this._process();
      }
    })();
  }

  async onIdle() {
    if (this.running === 0 && this.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleResolvers.push(resolve));
  }
}

// Environment variables & Config
const API_KEY = process.env.TELEGRAM_API_KEY || '9040402411:AAEDbRu9p9Xvh2e9Nlx50LgeULc5VNzaAsw';
const ATLAS_FALLBACK = 'mongodb+srv://Vercel-Admin-atlas-bistre-river:301KqnEoIfE1jbKd@atlas-bistre-river.y8r5lcf.mongodb.net/?retryWrites=true&w=majority';
const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI || (process.env.VERCEL ? ATLAS_FALLBACK : 'mongodb://127.0.0.1:27017/scribd_bot');
const INSTAGRAM_URL = process.env.INSTAGRAM_URL || 'https://www.instagram.com/mustaqeem_abad/';
const INSTAGRAM_HANDLE = '@mustaqeem_abad';

// Required Force-Join Channels
const REQUIRED_CHANNELS = [
  {
    id: process.env.CHANNEL_1 || '@cheggnx',
    name: 'FreelanceKar | Freelance & Tech Hub',
    url: 'https://t.me/cheggnx'
  },
  {
    id: process.env.CHANNEL_2 || '@CheggbyTnTbot',
    name: 'FreelanceKar Engineering Hub',
    url: 'https://t.me/CheggbyTnTbot'
  }
];

// Owners & Administrators
// t.me/nxproo is registered as owner along with existing admins
const ADMIN_USERNAMES = new Set(['nxproo', 'spacenx1', 'mustaqeem_abad']);
const ADMIN_IDS = new Set([7804932882, 5373286917]);

if (process.env.ADMIN_ID) {
  ADMIN_IDS.add(Number(process.env.ADMIN_ID));
}

const isServerless = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.WEBHOOK_MODE);

if (!API_KEY && !isServerless) {
  console.error('Error: TELEGRAM_API_KEY must be set in .env file');
  process.exit(1);
}

// Database Connection with Serverless Caching
let cachedDb = null;
async function connectToDatabase() {
  if (cachedDb && mongoose.connection.readyState === 1) {
    return cachedDb;
  }
  try {
    const db = await mongoose.connect(MONGO_URI, {
      serverSelectionTimeoutMS: 5000,
    });
    cachedDb = db;
    console.log('✅ Connected to MongoDB successfully');
    return db;
  } catch (err) {
    console.error('❌ MongoDB connection error:', err.message);
    if (!process.env.VERCEL) {
      process.exit(1);
    }
    throw err;
  }
}

// Auto-connect when running standalone / polling
if (!isServerless) {
  connectToDatabase();
}

// --- MongoDB Schemas ---
const UserSchema = new mongoose.Schema({
  userId: { type: Number, unique: true, required: true },
  username: { type: String, default: '' },
  firstName: { type: String, default: '' },
  isOwner: { type: Boolean, default: false },
  isAdmin: { type: Boolean, default: false },
  isBanned: { type: Boolean, default: false },
  channelsVerified: { type: Boolean, default: false },
  isVerified: { type: Boolean, default: false },
  verifiedAt: { type: Date, default: null },
  verifiedUntil: { type: Date, default: null },
  downloadsCount: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
  lastActive: { type: Date, default: Date.now },
});
const User = mongoose.model('User', UserSchema);

const InteractionSchema = new mongoose.Schema({
  userId: Number,
  username: String,
  action: String,
  details: Object,
  timestamp: { type: Date, default: Date.now },
});
const Interaction = mongoose.model('Interaction', InteractionSchema);

// Initialize Telegram Bot & Queues
const bot = new TelegramBot(API_KEY, { polling: !isServerless });
const downloadQueue = new SimpleQueue({ concurrency: 5 });
// Rate-limited broadcast queue (max 25 msgs/sec for Telegram safety)
const broadcastQueue = new SimpleQueue({ concurrency: 25, interval: 1000, intervalCap: 25 });

// --- Admin Helper Functions ---
function checkIsAdmin(userId, username) {
  if (ADMIN_IDS.has(Number(userId))) return true;
  const clean = (username || '').replace(/^@/, '').toLowerCase().trim();
  if (ADMIN_USERNAMES.has(clean)) {
    ADMIN_IDS.add(Number(userId));
    return true;
  }
  return false;
}

async function notifyAdmins(fn) {
  for (const adminId of ADMIN_IDS) {
    try {
      await fn(adminId);
    } catch (e) {
      // transient send error
    }
  }
}

async function logInteraction(userId, username, action, details) {
  try {
    await Interaction.create({ userId, username, action, details });
  } catch (err) {
    console.error('Error logging interaction:', err.message);
  }
}

async function getOrCreateUser(from) {
  if (!from) return null;
  const userId = from.id;
  const username = from.username ? `@${from.username}` : '@unknown';
  const firstName = from.first_name || 'User';
  const isAdm = checkIsAdmin(userId, from.username);

  let user = await User.findOne({ userId });
  if (!user) {
    user = await User.create({
      userId,
      username,
      firstName,
      isOwner: isAdm,
      isAdmin: isAdm,
      isVerified: isAdm,
      verifiedUntil: isAdm ? new Date(Date.now() + 3650 * 24 * 60 * 60 * 1000) : null,
    });
  } else {
    user.username = username;
    user.firstName = firstName;
    user.lastActive = new Date();
    if (isAdm && (!user.isAdmin || !user.isVerified)) {
      user.isAdmin = true;
      user.isOwner = true;
      user.isVerified = true;
      user.verifiedUntil = new Date(Date.now() + 3650 * 24 * 60 * 60 * 1000);
    }
    await user.save();
  }

  if (isAdm) {
    ADMIN_IDS.add(userId);
  }

  return user;
}

function checkAccess(user, userId, username) {
  if (checkIsAdmin(userId, username) || (user && (user.isAdmin || user.isOwner))) {
    return { authorized: true, daysLeft: 9999, isAdmin: true };
  }
  if (user && user.isBanned) {
    return { authorized: false, isBanned: true, daysLeft: 0, isAdmin: false };
  }
  if (user && user.isVerified && user.verifiedUntil && new Date(user.verifiedUntil) > new Date()) {
    const diffMs = new Date(user.verifiedUntil) - new Date();
    const daysLeft = Math.max(1, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));
    return { authorized: true, daysLeft, isAdmin: false, until: user.verifiedUntil };
  }
  return { authorized: false, daysLeft: 0, isAdmin: false };
}

function formatDate(date) {
  if (!date) return 'N/A';
  return new Date(date).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function extractScribdDetails(text) {
  if (!text || typeof text !== 'string') return null;
  const clean = text.replace(/<[^>]*>/g, '').trim();
  if (!clean.includes('scribd.com')) return null;

  const match = clean.match(/scribd\.com\/(?:document|doc|presentation|embeds)\/(\d+)(?:\/([a-zA-Z0-9_\-\.]+))?/i)
    || clean.match(/scribd\.com\/.*?(\d{6,})/i);

  if (!match) return null;

  const docId = match[1];
  let docTitle = match[2] ? match[2].replace(/[-_\.]+/g, ' ').trim() : `Scribd Document ${docId}`;
  return { docId, docTitle };
}

function generateUsersCsv(users) {
  const header = 'User ID,Username,First Name,Status,Verified Until,Downloads,Joined Date,Last Active\n';
  const rows = users.map(u => {
    const isAct = u.isVerified && u.verifiedUntil && new Date(u.verifiedUntil) > new Date();
    const status = u.isBanned ? 'Banned' : (u.isAdmin ? 'Admin' : (isAct ? 'Active' : 'Inactive'));
    const until = u.verifiedUntil ? new Date(u.verifiedUntil).toISOString().split('T')[0] : 'N/A';
    const joined = u.createdAt ? new Date(u.createdAt).toISOString().split('T')[0] : 'N/A';
    const last = u.lastActive ? new Date(u.lastActive).toISOString().split('T')[0] : 'N/A';
    const cleanName = (u.firstName || '').replace(/[",\n\r]/g, '');
    const cleanUser = (u.username || '').replace(/[",\n\r]/g, '');
    return `${u.userId},"${cleanUser}","${cleanName}",${status},${until},${u.downloadsCount || 0},${joined},${last}`;
  }).join('\n');
  return Buffer.from(header + rows, 'utf-8');
}

// --- Channel Subscription Enforcement ---
async function checkChannelsJoined(userId) {
  if (ADMIN_IDS.has(Number(userId))) {
    return { allJoined: true, missing: [] };
  }

  const missing = [];
  for (const ch of REQUIRED_CHANNELS) {
    try {
      const res = await bot.getChatMember(ch.id, userId);
      const status = res && res.status;
      const isMember = ['creator', 'administrator', 'member', 'restricted'].includes(status);
      if (!isMember) {
        missing.push(ch);
      }
    } catch (err) {
      const desc = err.response?.body?.description || err.message || '';
      if (
        desc.includes('PARTICIPANT_ID_INVALID') ||
        desc.includes('USER_NOT_PARTICIPANT') ||
        desc.includes('user not found') ||
        desc.includes('chat not found')
      ) {
        missing.push(ch);
      } else if (desc.includes('member list is inaccessible')) {
        const user = await User.findOne({ userId });
        if (!user || !user.channelsVerified) {
          missing.push(ch);
        }
      } else {
        console.error(`Error checking channel ${ch.id}:`, desc);
      }
    }
  }

  return {
    allJoined: missing.length === 0,
    missing
  };
}

function getForceJoinKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '📢 1. Join Tech Hub Channel', url: REQUIRED_CHANNELS[0].url }],
      [{ text: '📢 2. Join Engineering Hub Channel', url: REQUIRED_CHANNELS[1].url }],
      [{ text: '✅ Joined Both Channels (Verify)', callback_data: 'verify_channels' }],
      [{ text: '📸 Follow Instagram (@mustaqeem_abad)', url: INSTAGRAM_URL }]
    ]
  };
}

function getForceJoinMessage(name) {
  return (
    `⚠️ <b>Channel Subscription Required!</b>\n\n` +
    `Hello ${name}! To use this bot for free and download Scribd documents, you <b>must subscribe to both of our official channels</b>:\n\n` +
    `1️⃣ <a href="${REQUIRED_CHANNELS[0].url}">${REQUIRED_CHANNELS[0].name}</a>\n` +
    `2️⃣ <a href="${REQUIRED_CHANNELS[1].url}">${REQUIRED_CHANNELS[1].name}</a>\n\n` +
    `🔒 <b>The bot will NOT provide any answers or downloads until you join both channels!</b>\n\n` +
    `👉 Join both channels using the buttons below, then click <b>"✅ Joined Both Channels (Verify)"</b> to unlock!`
  );
}

// --- UI Generators ---
function getUserKeyboard(isAuthorized) {
  return {
    inline_keyboard: [
      [
        { text: '📸 Follow Instagram (@mustaqeem_abad)', url: INSTAGRAM_URL },
      ],
      [
        { text: '📊 My Status', callback_data: 'check_status' },
        { text: '📘 Help & Guide', callback_data: 'show_help' }
      ],
      [
        { text: '👨‍💻 Developer & Owner (@nxproo)', url: 'https://t.me/nxproo' }
      ]
    ]
  };
}

function getAdminKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '📊 Refresh Stats', callback_data: 'admin_stats' },
        { text: '📋 View User List', callback_data: 'admin_userlist' }
      ],
      [
        { text: '📥 Export Users CSV', callback_data: 'admin_export_csv' },
        { text: '📢 Broadcast Help', callback_data: 'admin_broadcast_help' }
      ]
    ]
  };
}

function getWelcomeMessage(name, access) {
  const statusLine = access.isAdmin
    ? '👑 <b>Role:</b> Owner / Administrator (Unlimited Access)'
    : (access.authorized
      ? `✅ <b>Status:</b> Active Subscriber (${access.daysLeft} days remaining)`
      : '❌ <b>Status:</b> Inactive (Follow Instagram & send screenshot to unlock 1 Month)');

  return (
    `📚 <b>Welcome ${name} to Scribd Downloader Bot!</b> ⚡\n\n` +
    `I can unlock and provide direct reading & downloading links for documents on Scribd!\n\n` +
    `🎁 <b>FREE 1-Month Pass:</b>\n` +
    `1️⃣ Follow us on Instagram: <a href="${INSTAGRAM_URL}">${INSTAGRAM_HANDLE}</a>\n` +
    `2️⃣ Send a screenshot of your follow here in this chat!\n` +
    `3️⃣ Your <b>1-Month FREE Access</b> activates immediately!\n\n` +
    `${statusLine}\n\n` +
    `📥 <b>Ready?</b> Just paste any Scribd document link below!`
  );
}

function getHelpMessage() {
  return (
    `📖 <b>Scribd Downloader Bot — Guide & Help</b>\n\n` +
    `🔹 <b>Step 1: Get 1-Month Free Access</b>\n` +
    `• Follow <a href="${INSTAGRAM_URL}">${INSTAGRAM_HANDLE}</a> on Instagram.\n` +
    `• Take a screenshot showing you followed.\n` +
    `• Send that photo/screenshot directly to this chat.\n` +
    `• Instant 1-Month free pass is granted!\n\n` +
    `🔹 <b>Step 2: Download Documents</b>\n` +
    `• Send any Scribd link like: <code>https://www.scribd.com/document/123456789/Title</code>\n` +
    `• Bot returns direct embed reader link.\n` +
    `• Open link ➡️ Press <b>Ctrl + P</b> (or Print in browser) ➡️ Select <b>Save as PDF</b>.\n\n` +
    `🔹 <b>Available Commands:</b>\n` +
    `• <code>/start</code> or <code>start</code> - Main menu\n` +
    `• <code>/status</code> - Check subscription & days left\n` +
    `• <code>/help</code> - Show this guide\n` +
    `• Send any photo 📸 - Verify Instagram follow for 1 month\n` +
    `• <b>Admin / Owner:</b> @nxproo`
  );
}

async function renderAdminDashboard() {
  const totalUsers = await User.countDocuments();
  const activeUsers = await User.countDocuments({
    isVerified: true,
    verifiedUntil: { $gt: new Date() },
    isBanned: false
  });
  const bannedUsers = await User.countDocuments({ isBanned: true });
  const totalDownloads = await Interaction.countDocuments({ action: 'scribd_download' });
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const newToday = await User.countDocuments({ createdAt: { $gte: startOfToday } });

  return (
    `👑 <b>Admin & Owner Dashboard</b>\n` +
    `👤 <b>Owners:</b> @nxproo | @spacenx1\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `👥 <b>Total Users:</b> <code>${totalUsers}</code>\n` +
    `💎 <b>Active Subscribed:</b> <code>${activeUsers}</code>\n` +
    `🆕 <b>New Users Today:</b> <code>${newToday}</code>\n` +
    `🚫 <b>Banned Users:</b> <code>${bannedUsers}</code>\n` +
    `📥 <b>Total Scribd Downloads:</b> <code>${totalDownloads}</code>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `💡 <i>Tap buttons below or use commands:</i>\n` +
    `• <code>/userlist</code> - View recent users\n` +
    `• <code>/export</code> - Export full users CSV\n` +
    `• <code>/grant &lt;id&gt; &lt;days&gt;</code> - Grant days\n` +
    `• <code>/revoke &lt;id&gt;</code> - Revoke access\n` +
    `• <code>/ban &lt;id&gt;</code> - Ban user\n` +
    `• <code>/broadcast &lt;msg&gt;</code> or send Photo with caption <code>/broadcast &lt;msg&gt;</code>`
  );
}

// --- Photo / Screenshot & Broadcast Handler ---
async function handlePhoto(msg) {
  const chatId = msg.chat.id;
  const from = msg.from;
  if (!from) return;

  const userId = from.id;
  const username = from.username ? `@${from.username}` : '@unknown';
  const firstName = from.first_name || 'User';
  const caption = (msg.caption || '').trim();
  const isAdm = checkIsAdmin(userId, from.username);

  const user = await getOrCreateUser(from);

  if (user && user.isBanned) {
    return bot.sendMessage(chatId, '⛔ You have been banned from using this bot.');
  }

  // 1. ADMIN PHOTO BROADCAST
  // If admin sends a photo with caption starting with /broadcast or /send
  if (isAdm && (caption.startsWith('/broadcast') || caption.startsWith('/send'))) {
    const broadcastText = caption.replace(/^\/(?:broadcast|send)\s*/i, '').trim();
    const highestPhotoId = msg.photo[msg.photo.length - 1].file_id;

    const users = await User.find({ isBanned: false }, 'userId username');
    const startMsg = await bot.sendMessage(
      chatId,
      `📢 <b>Photo Broadcast Started...</b>\n🎯 Targets: <code>${users.length}</code> users`,
      { parse_mode: 'HTML' }
    );

    let sent = 0;
    let failed = 0;
    const startTime = Date.now();

    for (const u of users) {
      broadcastQueue.add(async () => {
        try {
          await bot.sendPhoto(u.userId, highestPhotoId, {
            caption: broadcastText || undefined,
            parse_mode: 'HTML'
          });
          sent++;
        } catch (err) {
          failed++;
        }
      });
    }

    await broadcastQueue.onIdle();
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);

    await bot.sendMessage(
      chatId,
      `✅ <b>Photo Broadcast Completed!</b>\n\n` +
      `🎯 <b>Total Targets:</b> ${users.length}\n` +
      `📤 <b>Successfully Sent:</b> ${sent}\n` +
      `❌ <b>Failed / Blocked:</b> ${failed}\n` +
      `⏱ <b>Time Taken:</b> ${duration}s`,
      { parse_mode: 'HTML', reply_to_message_id: startMsg.message_id }
    );
    return;
  }

  // 2. REGULAR USER: Channel Subscription Check
  if (!isAdm) {
    const chCheck = await checkChannelsJoined(userId);
    if (!chCheck.allJoined) {
      await bot.sendMessage(
        chatId,
        `⚠️ <b>Channel Subscription Required First!</b>\n\n` +
        `Before activating your 1-Month Free Pass, you must subscribe to both of our official channels:\n\n` +
        `1️⃣ <a href="${REQUIRED_CHANNELS[0].url}">${REQUIRED_CHANNELS[0].name}</a>\n` +
        `2️⃣ <a href="${REQUIRED_CHANNELS[1].url}">${REQUIRED_CHANNELS[1].name}</a>\n\n` +
        `Join both channels, then click the verify button below or send your screenshot again!`,
        {
          reply_to_message_id: msg.message_id,
          parse_mode: 'HTML',
          reply_markup: getForceJoinKeyboard()
        }
      );
      return;
    }
  }

  // 3. REGULAR USER: Instagram Follow Screenshot Verification (1 Month)
  const now = new Date();
  const validUntil = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  user.isVerified = true;
  user.verifiedAt = now;
  user.verifiedUntil = validUntil;
  await user.save();

  await logInteraction(userId, username, 'screenshot_verification', {
    date: now,
    validUntil
  });

  const formattedDate = formatDate(validUntil);

  await bot.sendMessage(
    chatId,
    `🎉 <b>Proof Received & Verified!</b>\n\n` +
    `✅ <b>1-Month FREE Access Activated!</b>\n` +
    `📅 <b>Valid Until:</b> <code>${formattedDate}</code> (30 Days)\n\n` +
    `Thank you for following <a href="${INSTAGRAM_URL}">${INSTAGRAM_HANDLE}</a>! 🚀\n\n` +
    `Now simply paste any Scribd document link to get instant access!`,
    {
      reply_to_message_id: msg.message_id,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: getUserKeyboard(true)
    }
  );

  // Notify Admins
  const highestPhoto = msg.photo[msg.photo.length - 1].file_id;
  await notifyAdmins(async (adminId) => {
    await bot.sendPhoto(adminId, highestPhoto, {
      caption:
        `📸 <b>New Follow Screenshot Submitted!</b>\n\n` +
        `👤 <b>User:</b> ${username} (ID: <code>${userId}</code>)\n` +
        `🏷 <b>Name:</b> ${firstName}\n` +
        `⏰ <b>Status:</b> Auto-activated for 30 Days (until ${formattedDate})`,
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '➕ Add +30 Days', callback_data: `admin_extend_${userId}` },
            { text: '❌ Revoke', callback_data: `admin_revoke_${userId}` }
          ]
        ]
      }
    });
  });
}
bot.on('photo', handlePhoto);

// --- Callback Queries (Inline Buttons) ---
async function handleCallback(query) {
  const chatId = query.message?.chat.id;
  const messageId = query.message?.message_id;
  const data = query.data || '';
  const from = query.from;
  const userId = from.id;
  const username = from.username ? `@${from.username}` : '@unknown';
  const isAdm = checkIsAdmin(userId, from.username);

  try {
    await bot.answerCallbackQuery(query.id);

    // Channel Force-Join Verification Callback
    if (data === 'verify_channels') {
      const chCheck = await checkChannelsJoined(userId);
      if (chCheck.allJoined) {
        const user = await getOrCreateUser(from);
        user.channelsVerified = true;
        await user.save();

        await bot.sendMessage(
          chatId,
          `🎉 <b>Channel Subscription Verified!</b>\n\n` +
          `✅ You have joined all required channels!\n\n` +
          `Now you can use the bot. Paste any Scribd document link to get your document, or send an Instagram follow screenshot to activate your 1-Month Free Pass!`,
          {
            parse_mode: 'HTML',
            reply_markup: getUserKeyboard(checkAccess(user, userId, from.username).authorized)
          }
        );
      } else {
        const missingList = chCheck.missing.map(m => `• <a href="${m.url}">${m.name}</a>`).join('\n');
        await bot.sendMessage(
          chatId,
          `❌ <b>You haven't joined both channels yet!</b>\n\n` +
          `Please join the missing channel(s) below:\n${missingList}\n\n` +
          `After joining both, click the <b>Verify</b> button again!`,
          {
            parse_mode: 'HTML',
            reply_markup: getForceJoinKeyboard()
          }
        );
      }
      return;
    }

    // Regular user status check
    if (data === 'check_status') {
      const user = await getOrCreateUser(from);
      const access = checkAccess(user, userId, from.username);

      let statusMsg = '';
      if (access.isAdmin) {
        statusMsg =
          `👑 <b>Account Status: Owner / Administrator</b>\n\n` +
          `♾ <b>Access:</b> Unlimited Access\n` +
          `📊 <b>Your Total Downloads:</b> ${user.downloadsCount || 0}`;
      } else if (access.authorized) {
        statusMsg =
          `✅ <b>Account Status: Active Subscriber</b>\n\n` +
          `⏳ <b>Remaining Time:</b> ${access.daysLeft} Days\n` +
          `📅 <b>Valid Until:</b> <code>${formatDate(user.verifiedUntil)}</code>\n` +
          `📊 <b>Your Total Downloads:</b> ${user.downloadsCount || 0}`;
      } else {
        statusMsg =
          `❌ <b>Account Status: Inactive / Expired</b>\n\n` +
          `To activate <b>1-Month FREE Access</b>:\n` +
          `1. Follow <a href="${INSTAGRAM_URL}">${INSTAGRAM_HANDLE}</a>\n` +
          `2. Send a screenshot of your follow here in this chat!`;
      }

      await bot.sendMessage(chatId, statusMsg, {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: getUserKeyboard(access.authorized)
      });
      return;
    }

    // Help display
    if (data === 'show_help') {
      await bot.sendMessage(chatId, getHelpMessage(), {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: getUserKeyboard(true)
      });
      return;
    }

    // ADMIN ONLY CALLBACKS
    if (data.startsWith('admin_')) {
      if (!isAdm) {
        return bot.sendMessage(chatId, '⛔ Access Denied. Administrator only.');
      }

      // Refresh Stats
      if (data === 'admin_stats') {
        const text = await renderAdminDashboard();
        await bot.editMessageText(text, {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'HTML',
          reply_markup: getAdminKeyboard()
        });
        return;
      }

      // View User List
      if (data === 'admin_userlist') {
        const total = await User.countDocuments();
        const users = await User.find().sort({ lastActive: -1 }).limit(15);
        let listText = `📋 <b>User List (Recent 15 of ${total})</b>\n━━━━━━━━━━━━━━━━━━━━\n`;
        users.forEach((u, i) => {
          const act = u.isVerified && u.verifiedUntil && new Date(u.verifiedUntil) > new Date();
          const tag = u.isBanned ? '🚫' : (u.isAdmin ? '👑' : (act ? '✅' : '⏳'));
          listText += `${i + 1}. ${tag} <b>${u.firstName}</b> (${u.username || 'no-username'})\n   ID: <code>${u.userId}</code> | DLs: ${u.downloadsCount || 0} | Exp: ${formatDate(u.verifiedUntil)}\n`;
        });
        listText += `━━━━━━━━━━━━━━━━━━━━\n💡 <i>Export full list with the CSV button below!</i>`;

        await bot.sendMessage(chatId, listText, {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: '📥 Download Full Users CSV', callback_data: 'admin_export_csv' }],
              [{ text: '🔙 Back to Dashboard', callback_data: 'admin_stats' }]
            ]
          }
        });
        return;
      }

      // Export CSV
      if (data === 'admin_export_csv') {
        const users = await User.find().sort({ createdAt: -1 });
        const csvBuffer = generateUsersCsv(users);
        await bot.sendDocument(chatId, csvBuffer, {
          caption: `📊 <b>Complete User Database Export</b>\nTotal Users: <code>${users.length}</code>`,
          parse_mode: 'HTML'
        }, {
          filename: `scribd_bot_users_${new Date().toISOString().split('T')[0]}.csv`,
          contentType: 'text/csv'
        });
        return;
      }

      // Broadcast Help
      if (data === 'admin_broadcast_help') {
        await bot.sendMessage(
          chatId,
          `📢 <b>How to Broadcast:</b>\n\n` +
          `1️⃣ <b>Text Broadcast:</b>\n` +
          `Send: <code>/broadcast Your message here</code>\n\n` +
          `2️⃣ <b>Photo / Image Broadcast:</b>\n` +
          `Send any photo with caption: <code>/broadcast Your caption here</code>\n\n` +
          `⚡ Broadcast is rate-limited automatically to keep the bot completely safe from Telegram spam limits.`,
          { parse_mode: 'HTML' }
        );
        return;
      }

      // Extend User
      if (data.startsWith('admin_extend_')) {
        const targetId = Number(data.replace('admin_extend_', ''));
        const targetUser = await User.findOne({ userId: targetId });
        if (targetUser) {
          const base = (targetUser.verifiedUntil && new Date(targetUser.verifiedUntil) > new Date())
            ? new Date(targetUser.verifiedUntil)
            : new Date();
          targetUser.isVerified = true;
          targetUser.verifiedUntil = new Date(base.getTime() + 30 * 24 * 60 * 60 * 1000);
          await targetUser.save();

          await bot.sendMessage(chatId, `✅ Extended 30 days for user ${targetUser.username} (ID: <code>${targetId}</code>).\nValid until: <code>${formatDate(targetUser.verifiedUntil)}</code>`, { parse_mode: 'HTML' });
          bot.sendMessage(targetId, `🎉 <b>Your Free Access has been extended by 30 days!</b>\nValid until: <code>${formatDate(targetUser.verifiedUntil)}</code>`, { parse_mode: 'HTML' }).catch(() => {});
        }
        return;
      }

      // Revoke User
      if (data.startsWith('admin_revoke_')) {
        const targetId = Number(data.replace('admin_revoke_', ''));
        const targetUser = await User.findOne({ userId: targetId });
        if (targetUser) {
          targetUser.isVerified = false;
          targetUser.verifiedUntil = new Date(0);
          await targetUser.save();

          await bot.sendMessage(chatId, `❌ Access revoked for user ${targetUser.username} (ID: <code>${targetId}</code>).`, { parse_mode: 'HTML' });
          bot.sendMessage(targetId, `⚠️ <b>Your access has expired or was revoked.</b>\nPlease send a new follow screenshot to re-activate!`, { parse_mode: 'HTML' }).catch(() => {});
        }
        return;
      }
    }
  } catch (err) {
    console.error('Error handling callback query:', err.message);
  }
}
bot.on('callback_query', handleCallback);

// --- General Message Handler ---
async function handleMessage(msg) {
  // Photos are handled by handlePhoto
  if (msg.photo && msg.photo.length > 0) return;

  const chatId = msg.chat.id;
  const from = msg.from;
  if (!from) return;

  const fromId = from.id;
  const username = from.username ? `@${from.username}` : '@unknown';
  const name = from.first_name || 'User';
  const text = (msg.text || '').trim();
  const lower = text.toLowerCase();
  const messageId = msg.message_id;

  const isAdm = checkIsAdmin(fromId, from.username);
  const user = await getOrCreateUser(from);
  const access = checkAccess(user, fromId, from.username);

  // Check Ban Status
  if (user && user.isBanned && !isAdm) {
    return bot.sendMessage(chatId, '⛔ You have been banned from using this bot.');
  }

  // Force-Join Channel Check: Bot will NOT respond or give answers until user joins BOTH channels!
  if (!isAdm) {
    const chCheck = await checkChannelsJoined(fromId);
    if (!chCheck.allJoined) {
      await logInteraction(fromId, username, 'force_join_blocked', { missing: chCheck.missing });
      await bot.sendMessage(chatId, getForceJoinMessage(name), {
        reply_to_message_id: messageId,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: getForceJoinKeyboard()
      });
      return; // Stop execution: No answer or download will be given until joined!
    }
  }

  // 1. Start & Menu keywords
  const startKeywords = ['/start', 'start', 'menu', '/menu', 'hi', 'hello', 'hey'];
  if (startKeywords.includes(lower) || lower.startsWith('/start ')) {
    await logInteraction(fromId, username, 'start', { command: text });
    await bot.sendMessage(chatId, getWelcomeMessage(name, access), {
      reply_to_message_id: messageId,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: getUserKeyboard(access.authorized)
    });
    return;
  }

  // 2. Help keywords
  const helpKeywords = ['/help', 'help', '/guide', 'guide', 'how to use'];
  if (helpKeywords.includes(lower)) {
    await logInteraction(fromId, username, 'help', { command: text });
    await bot.sendMessage(chatId, getHelpMessage(), {
      reply_to_message_id: messageId,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: getUserKeyboard(access.authorized)
    });
    return;
  }

  // 3. Stats & Status Handling
  // If ADMIN runs /stats or /admin, show Global Admin Dashboard
  // If REGULAR USER runs /stats or /status, show personal status
  if (lower === '/stats' || lower === 'stats' || lower === '/admin' || lower === 'admin') {
    if (isAdm) {
      await logInteraction(fromId, username, 'admin_dashboard', {});
      const dashboardText = await renderAdminDashboard();
      await bot.sendMessage(chatId, dashboardText, {
        reply_to_message_id: messageId,
        parse_mode: 'HTML',
        reply_markup: getAdminKeyboard()
      });
      return;
    } else {
      // Regular user stats
      let statusMsg = '';
      if (access.authorized) {
        statusMsg =
          `✅ <b>Account Status: Active Subscriber</b>\n\n` +
          `⏳ <b>Remaining Time:</b> ${access.daysLeft} Days\n` +
          `📅 <b>Valid Until:</b> <code>${formatDate(user.verifiedUntil)}</code>\n` +
          `📊 <b>Your Total Downloads:</b> ${user.downloadsCount || 0}`;
      } else {
        statusMsg =
          `❌ <b>Account Status: Inactive / Expired</b>\n\n` +
          `To activate <b>1-Month FREE Access</b>:\n` +
          `1. Follow <a href="${INSTAGRAM_URL}">${INSTAGRAM_HANDLE}</a>\n` +
          `2. Send a screenshot of your follow here in this chat!`;
      }

      await bot.sendMessage(chatId, statusMsg, {
        reply_to_message_id: messageId,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: getUserKeyboard(access.authorized)
      });
      return;
    }
  }

  // Regular user /status command
  if (lower === '/status' || lower === 'status' || lower === 'plan' || lower === '/plan' || lower === 'profile') {
    await logInteraction(fromId, username, 'status', {});
    let statusMsg = '';
    if (access.isAdmin) {
      statusMsg =
        `👑 <b>Account Status: Owner / Administrator</b>\n\n` +
        `♾ <b>Access:</b> Unlimited Access\n` +
        `📊 <b>Total Downloads:</b> ${user.downloadsCount || 0}`;
    } else if (access.authorized) {
      statusMsg =
        `✅ <b>Account Status: Active Subscriber</b>\n\n` +
        `⏳ <b>Remaining Time:</b> ${access.daysLeft} Days\n` +
        `📅 <b>Valid Until:</b> <code>${formatDate(user.verifiedUntil)}</code>\n` +
        `📊 <b>Your Total Downloads:</b> ${user.downloadsCount || 0}`;
    } else {
      statusMsg =
        `❌ <b>Account Status: Inactive / Expired</b>\n\n` +
        `To activate <b>1-Month FREE Access</b>:\n` +
        `1. Follow <a href="${INSTAGRAM_URL}">${INSTAGRAM_HANDLE}</a>\n` +
        `2. Send a screenshot of your follow here in this chat!`;
    }

    await bot.sendMessage(chatId, statusMsg, {
      reply_to_message_id: messageId,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: getUserKeyboard(access.authorized)
    });
    return;
  }

  // --- ADMIN COMMANDS ---
  if (isAdm) {
    // 4. Admin User List
    if (lower === '/userlist' || lower === '/users' || lower === 'userlist') {
      const total = await User.countDocuments();
      const users = await User.find().sort({ lastActive: -1 }).limit(20);
      let listText = `📋 <b>User List (Recent 20 of ${total})</b>\n━━━━━━━━━━━━━━━━━━━━\n`;
      users.forEach((u, i) => {
        const act = u.isVerified && u.verifiedUntil && new Date(u.verifiedUntil) > new Date();
        const tag = u.isBanned ? '🚫' : (u.isAdmin ? '👑' : (act ? '✅' : '⏳'));
        listText += `${i + 1}. ${tag} <b>${u.firstName}</b> (${u.username || 'no-username'})\n   ID: <code>${u.userId}</code> | DLs: ${u.downloadsCount || 0} | Exp: ${formatDate(u.verifiedUntil)}\n`;
      });
      listText += `━━━━━━━━━━━━━━━━━━━━\n💡 <i>Export full database with /export or the button below!</i>`;

      await bot.sendMessage(chatId, listText, {
        reply_to_message_id: messageId,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: '📥 Export Full CSV', callback_data: 'admin_export_csv' }],
            [{ text: '🔙 Admin Panel', callback_data: 'admin_stats' }]
          ]
        }
      });
      return;
    }

    // 5. Admin Export CSV
    if (lower === '/export' || lower === '/csv') {
      const users = await User.find().sort({ createdAt: -1 });
      const csvBuffer = generateUsersCsv(users);
      await bot.sendDocument(chatId, csvBuffer, {
        caption: `📊 <b>Complete User Database Export</b>\nTotal Users: <code>${users.length}</code>`,
        parse_mode: 'HTML'
      }, {
        filename: `scribd_bot_users_${new Date().toISOString().split('T')[0]}.csv`,
        contentType: 'text/csv'
      });
      return;
    }

    // 6. Admin Text Broadcast
    if (lower.startsWith('/broadcast') || lower.startsWith('/send')) {
      const broadcastMsg = text.replace(/^\/(?:broadcast|send)\s*/i, '').trim();
      if (!broadcastMsg) {
        return bot.sendMessage(
          chatId,
          `⚠️ <b>Broadcast Usage:</b>\n\n` +
          `• <b>Text:</b> <code>/broadcast Your message here</code>\n` +
          `• <b>Photo:</b> Send any photo with caption: <code>/broadcast Your text here</code>`,
          { parse_mode: 'HTML' }
        );
      }

      const users = await User.find({ isBanned: false }, 'userId username');
      const startMsg = await bot.sendMessage(
        chatId,
        `📢 <b>Broadcast Started...</b>\n🎯 Targets: <code>${users.length}</code> users`,
        { parse_mode: 'HTML' }
      );

      let sent = 0;
      let failed = 0;
      const startTime = Date.now();

      for (const u of users) {
        broadcastQueue.add(async () => {
          try {
            await bot.sendMessage(u.userId, broadcastMsg, { parse_mode: 'HTML' });
            sent++;
          } catch (e) {
            failed++;
          }
        });
      }

      await broadcastQueue.onIdle();
      const duration = ((Date.now() - startTime) / 1000).toFixed(1);

      await bot.sendMessage(
        chatId,
        `✅ <b>Broadcast Completed!</b>\n\n` +
        `🎯 <b>Total Targets:</b> ${users.length}\n` +
        `📤 <b>Successfully Sent:</b> ${sent}\n` +
        `❌ <b>Failed / Blocked:</b> ${failed}\n` +
        `⏱ <b>Time Taken:</b> ${duration}s`,
        { parse_mode: 'HTML', reply_to_message_id: startMsg.message_id }
      );
      return;
    }

    // 7. Admin Grant Access: /grant <userId> <days>
    if (lower.startsWith('/grant')) {
      const parts = text.split(/\s+/);
      const targetId = Number(parts[1]);
      const days = Number(parts[2]) || 30;

      if (!targetId) {
        return bot.sendMessage(chatId, 'Usage: <code>/grant &lt;userId&gt; [days]</code>', { parse_mode: 'HTML' });
      }

      const targetUser = await User.findOne({ userId: targetId });
      if (!targetUser) {
        return bot.sendMessage(chatId, `❌ User with ID <code>${targetId}</code> not found in database.`, { parse_mode: 'HTML' });
      }

      const base = (targetUser.verifiedUntil && new Date(targetUser.verifiedUntil) > new Date())
        ? new Date(targetUser.verifiedUntil)
        : new Date();
      targetUser.isVerified = true;
      targetUser.verifiedUntil = new Date(base.getTime() + days * 24 * 60 * 60 * 1000);
      await targetUser.save();

      await bot.sendMessage(
        chatId,
        `✅ Granted <b>${days} days</b> to user ${targetUser.username} (<code>${targetId}</code>).\nValid until: <code>${formatDate(targetUser.verifiedUntil)}</code>`,
        { parse_mode: 'HTML' }
      );
      bot.sendMessage(targetId, `🎉 <b>Admin has granted you ${days} Days of Free Access!</b>\nValid until: <code>${formatDate(targetUser.verifiedUntil)}</code>`, { parse_mode: 'HTML' }).catch(() => {});
      return;
    }

    // 8. Admin Revoke Access: /revoke <userId>
    if (lower.startsWith('/revoke')) {
      const parts = text.split(/\s+/);
      const targetId = Number(parts[1]);
      if (!targetId) {
        return bot.sendMessage(chatId, 'Usage: <code>/revoke &lt;userId&gt;</code>', { parse_mode: 'HTML' });
      }

      const targetUser = await User.findOne({ userId: targetId });
      if (!targetUser) {
        return bot.sendMessage(chatId, `❌ User with ID <code>${targetId}</code> not found.`, { parse_mode: 'HTML' });
      }

      targetUser.isVerified = false;
      targetUser.verifiedUntil = new Date(0);
      await targetUser.save();

      await bot.sendMessage(chatId, `❌ Access revoked for user ${targetUser.username} (<code>${targetId}</code>).`, { parse_mode: 'HTML' });
      bot.sendMessage(targetId, `⚠️ <b>Your access was revoked by admin.</b>`, { parse_mode: 'HTML' }).catch(() => {});
      return;
    }

    // 9. Admin Ban / Unban: /ban <userId>, /unban <userId>
    if (lower.startsWith('/ban')) {
      const targetId = Number(text.split(/\s+/)[1]);
      if (!targetId) return bot.sendMessage(chatId, 'Usage: <code>/ban &lt;userId&gt;</code>', { parse_mode: 'HTML' });
      const targetUser = await User.findOne({ userId: targetId });
      if (targetUser) {
        targetUser.isBanned = true;
        await targetUser.save();
        await bot.sendMessage(chatId, `🚫 User <code>${targetId}</code> (${targetUser.username}) has been <b>banned</b>.`, { parse_mode: 'HTML' });
      }
      return;
    }

    if (lower.startsWith('/unban')) {
      const targetId = Number(text.split(/\s+/)[1]);
      if (!targetId) return bot.sendMessage(chatId, 'Usage: <code>/unban &lt;userId&gt;</code>', { parse_mode: 'HTML' });
      const targetUser = await User.findOne({ userId: targetId });
      if (targetUser) {
        targetUser.isBanned = false;
        await targetUser.save();
        await bot.sendMessage(chatId, `✅ User <code>${targetId}</code> (${targetUser.username}) has been <b>unbanned</b>.`, { parse_mode: 'HTML' });
      }
      return;
    }
  }

  // 10. Scribd Document Link Processing
  const scribdDetails = extractScribdDetails(text);
  if (scribdDetails || lower.includes('scribd.com')) {
    if (!scribdDetails) {
      await bot.sendMessage(
        chatId,
        `❌ <b>Invalid Scribd URL</b>\n\nPlease send a valid Scribd document link, e.g.:\n<code>https://www.scribd.com/document/123456789/Title</code>`,
        { reply_to_message_id: messageId, parse_mode: 'HTML' }
      );
      return;
    }

    // Access Gate: User must follow Instagram & send screenshot
    if (!access.authorized) {
      await logInteraction(fromId, username, 'download_blocked_unauthorized', { url: text });
      await bot.sendMessage(
        chatId,
        `🔒 <b>1-Month FREE Pass Required to Download!</b>\n\n` +
        `To unlock free unlimited downloads & answers for <b>1 Month</b>:\n\n` +
        `1️⃣ Follow our Instagram: <a href="${INSTAGRAM_URL}">${INSTAGRAM_HANDLE}</a>\n` +
        `2️⃣ Take a screenshot showing you followed.\n` +
        `3️⃣ <b>Send the screenshot directly to this chat!</b> 📸\n\n` +
        `⚡ <i>Once you send the screenshot, your 1-Month Free Pass is instantly activated!</i>`,
        {
          reply_to_message_id: messageId,
          parse_mode: 'HTML',
          disable_web_page_preview: false,
          reply_markup: {
            inline_keyboard: [
              [{ text: '📸 Follow on Instagram', url: INSTAGRAM_URL }],
              [{ text: '📊 Check My Status', callback_data: 'check_status' }],
              [{ text: '🛠️ Support (@nxproo)', url: 'https://t.me/nxproo' }]
            ]
          }
        }
      );
      return;
    }

    // Process Document
    await downloadQueue.add(async () => {
      try {
        const { docId, docTitle } = scribdDetails;
        const readerUrl = `https://www.scribd.com/embeds/${docId}/content`;

        user.downloadsCount = (user.downloadsCount || 0) + 1;
        await user.save();

        await logInteraction(fromId, username, 'scribd_download', {
          documentId: docId,
          docTitle,
          url: text
        });

        await bot.sendMessage(
          chatId,
          `📚 <b>Scribd Document Unlocked!</b>\n\n` +
          `📄 <b>Title:</b> <i>${docTitle}</i>\n` +
          `🆔 <b>Document ID:</b> <code>${docId}</code>\n` +
          `👤 <b>User:</b> ${username}\n` +
          `⏳ <b>Access Remaining:</b> ${access.isAdmin ? 'Unlimited (Owner)' : `${access.daysLeft} Days`}\n\n` +
          `✅ <b>Direct Document Reader:</b>\n<a href="${readerUrl}">${readerUrl}</a>\n\n` +
          `💡 <b>How to Save as PDF:</b>\n` +
          `1. Click the button below to open the document.\n` +
          `2. Press <b>Ctrl + P</b> (or browser menu ➡️ Print).\n` +
          `3. Choose <b>Save as PDF</b> and download.\n\n` +
          `Made with ❤️ by @nxproo | Follow @mustaqeem_abad`,
          {
            reply_to_message_id: messageId,
            parse_mode: 'HTML',
            disable_web_page_preview: false,
            reply_markup: {
              inline_keyboard: [
                [{ text: '📖 Open & Read Document ✅', url: readerUrl }],
                [{ text: '⚡ Alternative Downloader', url: 'https://docdownloader.com/' }],
                [{ text: '📊 My Status', callback_data: 'check_status' }]
              ]
            }
          }
        );

        // Notify Admins of download activity
        if (!isAdm) {
          await notifyAdmins(async (adminId) => {
            await bot.sendMessage(
              adminId,
              `📥 <b>New Download Activity</b>\n👤 <b>User:</b> ${username} (<code>${fromId}</code>)\n📄 <b>Title:</b> ${docTitle}\n🔗 <b>Link:</b> ${text}`,
              { parse_mode: 'HTML' }
            );
          });
        }
      } catch (err) {
        console.error('Error processing Scribd document:', err.message);
        await bot.sendMessage(
          chatId,
          `❌ <b>Error processing document.</b> Please try again or check the link.`,
          { reply_to_message_id: messageId, parse_mode: 'HTML' }
        );
      }
    });
    return;
  }

  // 11. General / Unrecognized text handler
  await bot.sendMessage(
    chatId,
    `👋 Hello ${name}!\n\n` +
    `Send me any <b>Scribd document link</b> to unlock it!\n\n` +
    `🎁 <b>Need 1-Month Free Access?</b>\n` +
    `Follow <a href="${INSTAGRAM_URL}">${INSTAGRAM_HANDLE}</a> on Instagram and send a screenshot here to activate your 30-day pass!\n\n` +
    `Type <code>/help</code> for instructions or <code>/status</code> to check your plan.`,
    {
      reply_to_message_id: messageId,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: getUserKeyboard(access.authorized)
    }
  );
}
bot.on('message', handleMessage);

// Central Update Handler for Webhook (awaits completion before returning)
async function handleUpdate(update) {
  if (!update || typeof update !== 'object') return;
  try {
    if (update.callback_query) {
      await handleCallback(update.callback_query);
    } else if (update.message) {
      if (update.message.photo && update.message.photo.length > 0) {
        await handlePhoto(update.message);
      } else {
        await handleMessage(update.message);
      }
    }
  } catch (err) {
    console.error('Error in handleUpdate:', err.message);
  }
}

// Polling Error Logger
bot.on('polling_error', (error) => {
  if (error.code !== 'EFATAL' && !error.message.includes('ETELEGRAM')) {
    console.error('Polling warning:', error.message);
  } else {
    console.error('Polling error:', error.message);
  }
});

console.log('🚀 Scribd Downloader Bot is running (Owner: @nxproo)...');

module.exports = { bot, connectToDatabase, handleUpdate, User, Interaction };
