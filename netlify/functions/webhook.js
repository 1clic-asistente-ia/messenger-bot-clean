// netlify/functions/webhook.js
const fetch = require('node-fetch');
const OpenAI = require('openai');
const { createClient } = require('@supabase/supabase-js');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const promptBase = `
ROL Y OBJETIVO
Eres un asesor de ventas experto de una llantera. Tu especialidad son las llantas para autos y camionetas. Eres calmado, directo, eficiente y muy resolutivo.

FILOSOFÍA DE CONVERSACIÓN Y REGLAS CRÍTICAS

1. Múltiples Mensajes Cortos: Habla como en WhatsApp. Divide tus respuestas en burbujas de chat concisas. Cada oración principal debe ir separada (doble salto de línea si se desea).

2. Sin Presentaciones Innecesarias: NO digas quién eres. Solo responde con amabilidad y claridad. Si preguntan tu nombre, di "Estoy aquí para ayudarte, ¿qué necesitas?"

3. Foco Absoluto en Llantas Automotrices: Solo vendes llantas para auto y camioneta. Si te piden llantas de moto, bici, tractor, etc., responde: "Una disculpa, solo manejamos llantas para auto y camioneta."

4. Economía de Palabras: Sé breve. No uses introducciones largas. "Una disculpa" o "Lamento el inconveniente" es suficiente.

5. Detector de Trolls y Bromistas: Si alguien se desvía del tema (insultos, bromas, absurdos), responde exactamente: [END_CONVERSATION]

6. Identifica medidas aunque estén mal escritas: Si el cliente dice "205 60 16" o "llanta 250 -40 rin 18", intenta deducir la medida correcta en formato ###/##R##.

7. Siempre menciona que los precios están en pesos mexicanos.

JERARQUÍA DE RESPUESTA

1. Si la consulta es inválida o fuera de tu alcance, termina o aclara tus límites.

2. Si detectas una medida válida o deducible: llama a buscarInventarioCliente({ medida })

3. Si no hay stock local: busca medidas compatibles en la tabla medidas_compatibles.

4. Si tampoco hay compatibles: consulta red_favoritos, pero no menciones que es una red. Solo di que está disponible en bodega si el cliente confirma que va.

RESPUESTAS

Habla como humano. No inventes llantas. Sé útil y directo.
`;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

exports.handler = async (event, context) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const body = JSON.parse(event.body);
  const entry = body.entry?.[0];
  const messaging = entry?.messaging?.[0];
  const psid = messaging?.sender?.id;
  const messageText = messaging?.message?.text?.trim();

  if (!psid || !messageText) {
    return { statusCode: 400, body: 'Invalid request' };
  }

  const { data: userData } = await supabase
    .from('messenger_users')
    .select('cliente_id')
    .eq('sender_id', psid)
    .maybeSingle();

  const clienteId = userData?.cliente_id || 'C0000';
  console.log(`✅ Cliente detectado: ${clienteId} para PSID: ${psid}`);

  const { data: nuevaConversacion } = await supabase
    .from('mensajes')
    .insert({ cliente_id: clienteId, mensaje: messageText, quien_hablo: 'cliente', sender_id: psid })
    .select('conversacion_id')
    .single();

  console.log('➡️ Insertando mensaje de usuario...');

  const contexto = [
    { role: 'system', content: promptBase },
    { role: 'user', content: messageText },
  ];

  const respuestaIA = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL || 'gpt-4',
    messages: contexto,
    temperature: 0.7,
  });

  const textoFinal = respuestaIA.choices?.[0]?.message?.content || '...';
  console.log('💬 Respuesta generada por el bot:', textoFinal);

  await fetch(`https://graph.facebook.com/v17.0/me/messages?access_token=${process.env.FACEBOOK_PAGE_ACCESS_TOKEN}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipient: { id: psid }, sender_action: 'typing_on' }),
  });

  const delayMs = Math.min(4000, textoFinal.length * 30);
  await delay(delayMs);

  await fetch(`https://graph.facebook.com/v17.0/me/messages?access_token=${process.env.FACEBOOK_PAGE_ACCESS_TOKEN}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipient: { id: psid }, message: { text: textoFinal } }),
  });

  const convId = nuevaConversacion?.conversacion_id;
  await supabase.from('mensajes').insert({
    cliente_id: clienteId,
    mensaje: textoFinal,
    quien_hablo: 'asistente',
    conversacion_id: convId,
    sender_id: psid,
  });

  console.log('✅ Respuesta del bot guardada.');
  return { statusCode: 200, body: 'OK' };
};
