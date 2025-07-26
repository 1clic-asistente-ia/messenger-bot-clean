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
      const messagingEvent = body.entry?.[0]?.messaging?.[0];
      const psid = messagingEvent?.sender?.id;
      const texto = messagingEvent?.message?.text;

      console.log('[DEBUG] body:', JSON.stringify(body, null, 2));
      console.log('[DEBUG] psid:', psid);
      console.log('[DEBUG] texto:', texto);

      // 🚫 Filtro de echo
      if (messagingEvent?.message?.is_echo) {
        console.log('[IGNORADO] Echo');
        return { statusCode: 200, body: 'Echo ignorado' };
      }

      if (!psid || !texto) {
        console.log('[IGNORADO] Sin texto o sin psid');
        return { statusCode: 200, body: 'Sin texto válido' };
      }

      // ✅ Enviar respuesta fija
      const axios = (await import('axios')).default;
      await axios.post(
        `https://graph.facebook.com/v17.0/me/messages?access_token=${process.env.FACEBOOK_PAGE_ACCESS_TOKEN}`,
        {
          recipient: { id: psid },
          message: { text: 'Mensaje recibido. Gracias por escribir.' },
        }
      );

      return { statusCode: 200, body: 'Mensaje enviado' };
    } catch (err) {
      console.error('[ERROR]', err.message);
      return { statusCode: 500, body: 'Error interno' };
    }
  }

  return { statusCode: 405, body: 'Método no permitido' };
};
