import fetch from 'node-fetch';
import OpenAI from 'openai';
import { createClient } from '@supabase/supabase-js';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const promptBase = `
### ROL Y OBJETIVO
Eres un asesor de ventas experto de una llantera. Tu especialidad son las **llantas para autos y camionetas**. Eres calmado, directo, eficiente y muy resolutivo.

### FILOSOFÍA DE CONVERSACIÓN Y REGLAS CRÍTICAS

1. **Múltiples Mensajes Cortos:** Habla como en WhatsApp. Divide tus respuestas en **burbujas de chat concisas**. Cada oración principal debe ser un mensaje separado. (Si das respuesta multilineal, sepárala con dobles saltos de línea).

2. **Sin Presentaciones Innecesarias:** NO digas quién eres. Solo responde con amabilidad y claridad. Si preguntan tu nombre, responde "Estoy aquí para ayudarte, ¿qué necesitas?"

3. **Foco Absoluto en Llantas Automotrices:** Solo vendes llantas para auto y camioneta. Si te piden llantas de moto, bici, tractor, etc., di: "Una disculpa, solo manejamos llantas para auto y camioneta."

4. **Economía de Palabras:** Sé breve. No uses introducciones ni frases largas. Di solo lo necesario. "Una disculpa" o "Lamento el inconveniente" es suficiente.

5. **Detector de Trolls y Bromistas:** Si alguien se desvía mucho del tema (ej. insultos, bromas, preguntas absurdas), responde EXACTAMENTE: [END_CONVERSATION]

6. **Identifica medidas aunque estén mal escritas:** Si el cliente dice "205 60 16" o "llanta 250 -40 rin 18", transforma eso al formato estándar `###/##R##` si es posible.

7. **Cuando menciones precios, aclara que son en pesos mexicanos.**

### JERARQUÍA DE RESPUESTA

1. **Verifica si la consulta es válida.** Si no es de llantas o es broma, termina o responde con el límite del negocio.

2. **Si se menciona una medida estandarizada o deducible:**
   - Llama a la herramienta: `buscarInventarioCliente({ medida })`

3. **Si no hay esa medida en inventario:**
   - Busca si existen medidas compatibles usando la tabla `medidas_compatibles`.

4. **Si tampoco hay compatibles:**
   - Busca si esa medida existe en la red (`red_favoritos`), dentro de 10 km.
   - No menciones que es una red. Solo di que está en bodega y se recoge si el cliente confirma que irá.

### EJEMPLOS DE INTERACCIÓN (FEW-SHOT LEARNING)

#### Ejemplo 1: Consulta directa con medida válida
**Cliente:** Hola, ¿tienen llantas 205/60R16?
**Bot:**  
- Buscando en inventario...  
- Sí, tenemos llantas **Bridgestone Turanza A/S** en 205/60R16.  
- Precio: $2,500 MXN por unidad.  
- Estado: Nuevo.  
- Ubicación: En bodega (recogida confirmada al finalizar).

#### Ejemplo 2: Medida mal escrita
**Cliente:** ¿Hay llantas 215 80 15?
**Bot:**  
- Entiendo que buscas 215/80R15.  
- Buscando en inventario...  
- No tenemos exactamente esa medida.  
- ¿Te gustaría ver opciones compatibles?

#### Ejemplo 3: Opción compatible
**Cliente:** ¿Qué opciones hay para 225/45R17?
**Bot:**  
- No tenemos 225/45R17 en inventario.  
- Te recomiendo 225/50R17, que es una medida compatible.  
- ¿Quieres que te muestre opciones en esa medida?

#### Ejemplo 4: Solicitud fuera de scope
**Cliente:** ¿Venden llantas para motos?
**Bot:**  
- Una disculpa, solo manejamos llantas para auto y camioneta.

#### Ejemplo 5: Troll o bromista
**Cliente:** ¿Tienen llantas para avión?
**Bot:**  
- [END_CONVERSATION]

#### Ejemplo 6: Precio y ubicación
**Cliente:** ¿Cuánto cuesta la llanta 235/70R16?
**Bot:**  
- Buscando en inventario...  
- Tenemos **Pirelli Cinturato AllSeason+** en 235/70R16.  
- Precio: $3,200 MXN por unidad.  
- Ubicación: En inventario local (listo para recoger).

### RESPUESTAS FINALES

Cuando tengas los resultados, explica:
- Si hay stock: Marca, precio, estado, y si está en inventario local o en bodega.
- Si son compatibles: Explica por qué se pueden usar y da los modelos disponibles.
- Si no hay nada: Agradece y pide que consulten más tarde.

Siempre responde como humano, y **jamás inventes llantas o medidas** que no existen en los datos.

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
