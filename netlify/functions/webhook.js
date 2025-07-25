const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

exports.handler = async function (event, context) {
  if (event.httpMethod === 'GET') {
    const params = new URLSearchParams(event.queryStringParameters);
    const mode = params.get('hub.mode');
    const token = params.get('hub.verify_token');
    const challenge = params.get('hub.challenge');

    if (mode === 'subscribe' && token === process.env.FACEBOOK_VERIFY_TOKEN) {
      return { statusCode: 200, body: challenge };
    } else {
      return { statusCode: 403 };
    }
  }

  if (event.httpMethod === 'POST') {
    try {
      const body = JSON.parse(event.body);

      if (body.object === 'page') {
        for (const entry of body.entry) {
          for (const messagingEvent of entry.messaging) {
            const senderId = messagingEvent.sender.id;

            if (messagingEvent.message && messagingEvent.message.text) {
              const mensajeCliente = messagingEvent.message.text;
              console.log('📨 Mensaje recibido:', mensajeCliente);

              const promptPath = path.join(__dirname, 'prompt.txt');
              const promptBase = fs.readFileSync(promptPath, 'utf-8');

              const completion = await openai.chat.completions.create({
                model: 'gpt-3.5-turbo',
                messages: [
                  { role: 'system', content: promptBase },
                  { role: 'user', content: mensajeCliente }
                ]
              });

              const respuestaGPT = completion.choices[0].message.content;
              console.log('🤖 Respuesta GPT:', respuestaGPT);

              await fetch(`https://graph.facebook.com/v18.0/me/messages?access_token=${process.env.FACEBOOK_PAGE_ACCESS_TOKEN}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  recipient: { id: senderId },
                  message: { text: respuestaGPT }
                })
              });
            }
          }
        }

        return { statusCode: 200, body: 'EVENT_RECEIVED' };
      }

      return { statusCode: 404 };
    } catch (err) {
      console.error('❌ Error en webhook POST:', err);
      return { statusCode: 500, body: 'Internal Server Error' };
    }
  }

  return { statusCode: 405 };
};
