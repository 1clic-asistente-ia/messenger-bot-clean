import fetch from 'node-fetch';
import OpenAI from 'openai';
import { createClient } from '@supabase/supabase-js';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const promptBase = `
Eres un asistente de ventas para una llantera. Tu tarea es ayudar al cliente con preguntas sobre disponibilidad de llantas, precios, medidas compatibles, servicios y ubicación. Siempre responde en un tono amable, claro y profesional. No inventes datos si no los sabes.

Si el cliente pregunta algo que no entiendes, pídele que reformule o diga la medida de su llanta.
`;

export const handler = async (event) => {
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
    const body = JSON.parse(event.body);

    if (body.object === 'page') {
      for (const entry of body.entry) {
        for (const messagingEvent of entry.messaging) {
          const senderId = messagingEvent.sender.id;

          if (messagingEvent.message?.text) {
            const mensajeCliente = messagingEvent.message.text;

            const { data, error } = await supabase
              .from('messenger_users')
              .select('cliente_id')
              .eq('psid', senderId);

            if (!data || data.length === 0 || !data[0]?.cliente_id) {
              console.warn(`❌ PSID no encontrado: ${senderId}`);
              return { statusCode: 200, body: 'PSID desconocido' };
            }

            const cliente_id = data[0].cliente_id;
            console.log(`✅ Cliente detectado: ${cliente_id} para PSID: ${senderId}`);

            try {
              console.log("➡️ Insertando mensaje de usuario...");
              await supabase.from('mensajes').insert({
                contenido: mensajeCliente,
                tipo: 'usuario',
                cliente_id,
                metadata: { canal: 'facebook', sender_id: senderId }
              });
              console.log("✅ Mensaje de usuario guardado.");
            } catch (err) {
              console.error("❌ Error al insertar mensaje usuario:", err);
            }

            const completion = await openai.chat.completions.create({
              model: process.env.OPENAI_MODEL || 'gpt-3.5-turbo',
              messages: [
                { role: 'system', content: promptBase },
                { role: 'user', content: mensajeCliente }
              ]
            });

            const respuesta = completion.choices[0].message.content;

            try {
              console.log("➡️ Insertando respuesta del bot...");
              await supabase.from('mensajes').insert({
                contenido: respuesta,
                tipo: 'asistente',
                cliente_id,
                metadata: { canal: 'facebook', sender_id: senderId }
              });
              console.log("✅ Respuesta del bot guardada.");
            } catch (err) {
              console.error("❌ Error al insertar respuesta del bot:", err);
            }

            await fetch(`https://graph.facebook.com/v18.0/me/messages?access_token=${process.env.FACEBOOK_PAGE_ACCESS_TOKEN}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                recipient: { id: senderId },
                message: { text: respuesta }
              })
            });
          }
        }
      }

      return { statusCode: 200, body: 'EVENT_RECEIVED' };
    }

    return { statusCode: 404 };
  }

  return { statusCode: 405 };
};
