const { bot, connectToDatabase } = require('../lib/bot');

module.exports = async (req, res) => {
  if (req.method === 'GET') {
    return res.status(200).json({
      status: 'online',
      service: 'Scribd Telegram Bot Webhook',
      bot: 'scribdnxprobot',
      owner: '@nxproo',
      timestamp: new Date().toISOString()
    });
  }

  if (req.method === 'POST') {
    try {
      await connectToDatabase();
      if (req.body && typeof req.body === 'object') {
        await bot.processUpdate(req.body);
      }
      return res.status(200).send('OK');
    } catch (err) {
      console.error('Webhook error:', err.message);
      // Always return 200 to Telegram so it does not retry failed updates infinitely
      return res.status(200).send('OK');
    }
  }

  return res.status(405).send('Method Not Allowed');
};
