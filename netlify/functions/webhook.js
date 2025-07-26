import fetch from 'node-fetch';
import OpenAI from 'openai';
import { createClient } from '@supabase/supabase-js';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const promptBase = `
Eres un asistente de ventas para una llantera. Ayudas al cliente a encontrar llantas usadas disponibles. Tú principal objetivo es lograr la venta de las llantas en inventario. Eres un vendedor proactivo. No preguntas ¿te gustría que busque llantas de esa medida?, al contrario, te adelantes y dices algo como "permíteme un momento, estoy buscando la llanta que necesitas". No dejas que el usuario guíe la conversación, sino que tú lo haces. Siempre en tono muy amablle y profesional. Hablando de "TU". Tus respuesta son cortas y directas.

Si el cliente menciona una medida, aunque esté mal escrita o separada (ej: "250 -40 rin 18"), intenta deducirla y convertirla al formato estándar ###/##R##.

Cuando reconozcas una medida válida, llama a la función buscarInventarioCliente({ medida }) para consultar el inventario local (de este cliente).

Responde de forma profesional, amable y CONCISA. Cuando menciones precios, siempre especifica que son en pesos.

`;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Buscar en inventario del cliente_id
async function buscarInventarioCliente({ medida, cliente_id }) {
  const { data, error } = await supabase
    .from('inventario')
    .select('id_llanta, medida, marca, precio')
    .eq('cliente_id', cliente_id)
    .eq('medida', medida)
    .eq('disponibilidad', 'Disponible');

  if (error) {
    console.error("❌ Error al consultar inventario local:", error.message);
    return [];
  }

  return data || [];
}

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
            const conversacion_id = senderId;

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

            await supabase.from('mensajes').insert({
              conversacion_id,
              contenido: mensajeCliente,
              tipo: 'usuario',
              cliente_id,
              metadata: { canal: 'facebook', sender_id: senderId }
            });

            let historial = [];
            const { data: anteriores } = await supabase
              .from('mensajes')
              .select('tipo, contenido')
              .eq('conversacion_id', conversacion_id)
              .order('created_at', { ascending: false })
              .limit(6);

            historial = (anteriores || []).reverse().map(m => ({
              role: m.tipo === 'usuario' ? 'user' : 'assistant',
              content: m.contenido
            }));

            const completion = await openai.chat.completions.create({
              model: 'gpt-3.5-turbo-1106',
              tools: [
                {
                  type: 'function',
                  function: {
                    name: 'buscarInventarioCliente',
                    description: 'Consulta el inventario local por medida estandarizada',
                    parameters: {
                      type: 'object',
                      properties: {
                        medida: { type: 'string', description: 'Medida como 205/55R16' },
                        cliente_id: { type: 'string' }
                      },
                      required: ['medida', 'cliente_id']
                    }
                  }
                }
              ],
              messages: [
                { role: 'system', content: promptBase },
                ...historial,
                { role: 'user', content: mensajeCliente }
              ],
              tool_choice: 'auto'
            });

            const respuesta1 = completion.choices[0];
            const toolCall = respuesta1?.message?.tool_calls?.[0];

            let respuestaFinal = '';

            if (toolCall?.function?.name === 'buscarInventarioCliente') {
              const args = JSON.parse(toolCall.function.arguments || '{}');
              args.cliente_id = cliente_id;

              const resultados = await buscarInventarioCliente(args);

              const segundoTurno = await openai.chat.completions.create({
                model: 'gpt-3.5-turbo',
                messages: [
                  { role: 'system', content: promptBase },
                  ...historial,
                  { role: 'user', content: mensajeCliente },
                  {
                    role: 'assistant',
                    tool_calls: [toolCall]
                  },
                  {
                    role: 'tool',
                    tool_call_id: toolCall.id,
                    name: 'buscarInventarioCliente',
                    content: JSON.stringify(resultados)
                  }
                ]
              });

              respuestaFinal = segundoTurno.choices[0].message.content?.trim();
            } else {
              respuestaFinal = respuesta1.message?.content?.trim() || '';
            }

            await supabase.from('mensajes').insert({
              conversacion_id,
              contenido: respuestaFinal,
              tipo: 'asistente',
              cliente_id,
              metadata: { canal: 'facebook', sender_id: senderId }
            });

            const interval = setInterval(() => {
              fetch(`https://graph.facebook.com/v18.0/me/messages?access_token=${process.env.FACEBOOK_PAGE_ACCESS_TOKEN}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  recipient: { id: senderId },
                  sender_action: 'typing_on'
                })
              });
            }, 2000);

            const delayMs = Math.min(respuestaFinal.length * 300, 8000);
            await sleep(delayMs);
            clearInterval(interval);

            await fetch(`https://graph.facebook.com/v18.0/me/messages?access_token=${process.env.FACEBOOK_PAGE_ACCESS_TOKEN}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                recipient: { id: senderId },
                message: { text: respuestaFinal }
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
