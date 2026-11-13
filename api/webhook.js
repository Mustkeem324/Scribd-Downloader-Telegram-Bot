let botModule = null;

function getBotModule() {
  if (!botModule) {
    try {
      botModule = require('../lib/bot');
    } catch (err) {
      console.error('Failed to load bot module:', err);
      throw err;
    }
  }
  return botModule;
}

module.exports = async (req, res) => {
  // 1. GET Request: Render beautiful HTML Status Page for browsers
  if (req.method === 'GET') {
    const isJsonRequested = req.headers.accept && req.headers.accept.includes('application/json');

    if (isJsonRequested) {
      return res.status(200).json({
        status: 'online',
        service: 'Scribd Telegram Bot Webhook Server',
        bot: '@scribdnxprobot',
        owner: '@nxproo',
        timestamp: new Date().toISOString()
      });
    }

    const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Webhook Status — Scribd Downloader Bot</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Plus Jakarta Sans', sans-serif; }
    body {
      background: #090d16;
      color: #f1f5f9;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 1.5rem;
      background-image: radial-gradient(circle at 50% 30%, rgba(59, 130, 246, 0.15) 0%, transparent 60%);
    }
    .card {
      background: rgba(22, 27, 46, 0.8);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 20px;
      padding: 2.5rem 2rem;
      max-width: 520px;
      width: 100%;
      text-align: center;
      box-shadow: 0 20px 40px rgba(0,0,0,0.5);
      backdrop-filter: blur(16px);
    }
    .status-pill {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      background: rgba(16, 185, 129, 0.15);
      border: 1px solid rgba(16, 185, 129, 0.35);
      color: #34d399;
      padding: 0.35rem 0.9rem;
      border-radius: 9999px;
      font-size: 0.85rem;
      font-weight: 700;
      margin-bottom: 1.5rem;
    }
    .dot {
      width: 8px;
      height: 8px;
      background: #10b981;
      border-radius: 50%;
      box-shadow: 0 0 10px #10b981;
      animation: pulse 2s infinite;
    }
    @keyframes pulse {
      0% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.4; transform: scale(0.85); }
      100% { opacity: 1; transform: scale(1); }
    }
    h1 { font-size: 1.75rem; font-weight: 800; margin-bottom: 0.5rem; }
    p { color: #94a3b8; font-size: 0.95rem; line-height: 1.5; margin-bottom: 1.75rem; }
    .meta-box {
      background: rgba(0,0,0,0.3);
      border: 1px solid rgba(255,255,255,0.06);
      border-radius: 12px;
      padding: 1rem;
      text-align: left;
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.85rem;
      color: #cbd5e1;
      margin-bottom: 1.75rem;
    }
    .meta-item { display: flex; justify-content: space-between; padding: 0.35rem 0; }
    .meta-key { color: #64748b; }
    .meta-val { color: #60a5fa; font-weight: 600; }
    .btn-group { display: flex; gap: 0.75rem; justify-content: center; flex-wrap: wrap; }
    .btn {
      padding: 0.75rem 1.4rem;
      border-radius: 10px;
      font-weight: 600;
      text-decoration: none;
      font-size: 0.9rem;
      transition: all 0.2s;
    }
    .btn-primary { background: #2563eb; color: #fff; }
    .btn-primary:hover { background: #1d4ed8; }
    .btn-secondary { background: rgba(255,255,255,0.08); color: #fff; border: 1px solid rgba(255,255,255,0.1); }
    .btn-secondary:hover { background: rgba(255,255,255,0.15); }
  </style>
</head>
<body>
  <div class="card">
    <div class="status-pill">
      <div class="dot"></div>
      <span>WEBHOOK OPERATIONAL</span>
    </div>
    <h1>Scribd Bot Webhook</h1>
    <p>This endpoint receives real-time event updates from the Telegram Bot API and processes document requests.</p>
    
    <div class="meta-box">
      <div class="meta-item">
        <span class="meta-key">Bot Handler:</span>
        <span class="meta-val">@scribdnxprobot</span>
      </div>
      <div class="meta-item">
        <span class="meta-key">Owner:</span>
        <span class="meta-val">@nxproo</span>
      </div>
      <div class="meta-item">
        <span class="meta-key">Protocol:</span>
        <span class="meta-val">HTTP/2 POST</span>
      </div>
      <div class="meta-item">
        <span class="meta-key">Server Time:</span>
        <span class="meta-val">${new Date().toUTCString()}</span>
      </div>
    </div>

    <div class="btn-group">
      <a href="https://t.me/scribdnxprobot" target="_blank" class="btn btn-primary">Open Bot on Telegram</a>
      <a href="/" class="btn btn-secondary">Homepage</a>
      <a href="/set-webhook" class="btn btn-secondary">Set Webhook</a>
    </div>
  </div>
</body>
</html>
    `;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(html);
  }

  // 2. POST Request: Handle Telegram Updates
  if (req.method === 'POST') {
    try {
      const { bot, connectToDatabase } = getBotModule();
      try {
        await connectToDatabase();
      } catch (dbErr) {
        console.error('Database connection notice (webhook continuing):', dbErr.message);
      }

      if (req.body && typeof req.body === 'object') {
        await bot.processUpdate(req.body);
      }
      return res.status(200).send('OK');
    } catch (err) {
      console.error('Webhook processing error:', err.message);
      // Always return 200 OK to Telegram so it doesn't storm retries
      return res.status(200).send('OK');
    }
  }

  return res.status(405).send('Method Not Allowed');
};
