import axios from 'axios';

export const handler = async (event) => {
  if (event.httpMethod === 'GET') {
    const VERIFY_TOKEN = process.env.FACEBOOK_VERIFY_TOKEN;
    const mode = event.queryStringParameters['hub.mode'];
    const token = event.queryStringParameters['hub.verify_token'];
    const challenge = event.queryStringParameters['hub.challenge'];
    if (mode && token === VERIFY_TOKEN) {
      return { statusCode: 200, body: challenge };
    }
    return { statusCode: 403, body: 'Token inválido' };
  }

  if (event.httpMethod === 'POST') {
    try {
      const body = JSON.parse(event.body);
      console.log('[DEBUG] Webhook recibió:', JSON.stringify(body, null, 2));

      const messagingEvent = body.entry?.[0]?.messaging?.[0];
      const psid = messagingEvent?.sender?.id;

      if (!psid || messagingEvent?.message?.is_echo) {
        console.log('[IGNORADO] Sin psid o mensaje echo');
        return { statusCode: 200, body: 'Ignorado' };
      }

      await axios.post(
        `https://graph.facebook.com/v17.0/me/messages?access_token=${process.env.FACEBOOK_PAGE_ACCESS_TOKEN}`,
        {
          recipient: { id: psid },
          message: { text: 'Gracias por tu mensaje.' },
        }
      );

      return { statusCode: 200, body: 'Mensaje enviado' };
    } catch (err) {
      console.error('[ERROR EN WEBHOOK]:', err.message);
      return { statusCode: 500, body: 'Error interno' };
    }
  }

  return { statusCode: 405, body: 'Método no permitido' };
};
