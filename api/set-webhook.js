const axios = require('axios');
const API_KEY = process.env.TELEGRAM_API_KEY;

module.exports = async (req, res) => {
  if (!API_KEY) {
    return res.status(500).json({ error: 'TELEGRAM_API_KEY is not set in environment variables' });
  }

  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const webhookUrl = `${proto}://${host}/api/webhook`;

  try {
    const response = await axios.post(`https://api.telegram.org/bot${API_KEY}/setWebhook`, {
      url: webhookUrl,
      drop_pending_updates: true
    });

    const isJsonRequested = req.headers.accept && req.headers.accept.includes('application/json');
    if (isJsonRequested) {
      return res.status(200).json({
        success: true,
        message: 'Webhook configured successfully',
        webhookUrl,
        telegramResponse: response.data
      });
    }

    const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Webhook Configured — Scribd Downloader Bot</title>
  <style>
    body { background: #090d16; color: #f1f5f9; font-family: -apple-system, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .card { background: rgba(22, 27, 46, 0.85); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 16px; padding: 2.5rem; max-width: 500px; text-align: center; }
    h1 { color: #34d399; font-size: 1.6rem; margin-bottom: 0.75rem; }
    p { color: #94a3b8; font-size: 0.95rem; line-height: 1.6; margin-bottom: 1.5rem; }
    code { background: rgba(0,0,0,0.4); color: #60a5fa; padding: 0.2rem 0.5rem; border-radius: 6px; font-size: 0.85rem; word-break: break-all; }
    a { display: inline-block; background: #2563eb; color: #fff; padding: 0.75rem 1.5rem; border-radius: 10px; text-decoration: none; font-weight: 600; margin-top: 1rem; }
  </style>
</head>
<body>
  <div class="card">
    <h1>✅ Webhook Configured!</h1>
    <p>Telegram will now route all updates to:</p>
    <p><code>${webhookUrl}</code></p>
    <p>Status: <b>Active & Ready</b></p>
    <a href="https://t.me/scribdnxprobot" target="_blank">Test Bot on Telegram</a>
  </div>
</body>
</html>
    `;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(html);
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Failed to set webhook',
      error: error.response?.data || error.message
    });
  }
};
