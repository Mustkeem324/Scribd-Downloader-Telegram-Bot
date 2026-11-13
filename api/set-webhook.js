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

    return res.status(200).json({
      success: true,
      message: 'Webhook successfully configured for Telegram Bot!',
      webhookUrl,
      telegramResponse: response.data
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Failed to set webhook',
      error: error.response?.data || error.message
    });
  }
};
