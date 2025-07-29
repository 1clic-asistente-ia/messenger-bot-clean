// netlify/functions/webhook.js
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
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
1. Múltiples Mensajes Cortos: Habla como en WhatsApp. Divide tus respuestas en burbujas de chat concisas.
2. Sin Presentaciones Innecesarias: NO digas quién eres. Solo responde con amabilidad y claridad.
3. Foco Absoluto en Llantas Automotrices: Si piden llantas de moto, bici o tractor, responde: "Una disculpa, solo manejamos llantas para auto y camioneta."
4. Economía de Palabras: Sé breve.
5. Detector de Trolls: Si hay insultos o bromas, responde exactamente: [END_CONVERSATION]
6. Detecta medidas aunque estén mal escritas: Interpreta cosas como "250 -40 rin 18" y conviértelas a ###/##R##
7. Siempre menciona que los precios están en pesos mexicanos.
8. Cuando invoques buscarInventarioCliente, devuelve EXACTAMENTE el formato JSON: {"medida":"###/##R##"}

JERARQUÍA DE RESPUESTA
1. Si la consulta es inválida, aclara tus límites.
2. Si detectas una medida válida o deducible: llama a buscarInventarioCliente({ medida })
3. Si no hay stock local: busca medidas compatibles automáticamente.
4. Si tampoco existen compatibles: se consulta red_favoritos (por ahora desactivado).

RESPUESTAS
Habla como humano. No inventes llantas. Sé útil y directo.
`;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ----------  FUNCIÓN AUXILIAR: MEMORIA DE CONVERSACIÓN  ---------- */
async function obtenerContextoConversacion(clienteId, limite = 6) {
  const { data: mensajes } = await supabase
    .from('mensajes')
    .select('mensaje, quien_hablo')
    .eq('cliente_id', clienteId)
    .order('created_at', { ascending: true })
    .limit(limite);

  const contexto = [];
  contexto.push({ role: 'system', content: promptBase });

  (mensajes || []).forEach(m => {
    contexto.push({
      role: m.quien_hablo === 'cliente' ? 'user' : 'assistant',
      content: m.mensaje,
    });
  });

  return contexto;
}

/* ------------------  HANDLER PRINCIPAL  ------------------ */
exports.handler = async (event, context) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const body = JSON.parse(event.body);
  const entry = body.entry?.[0];
  const messaging = entry?.messaging?.[0];
  const psid = messaging?.sender?.id;
  const pageId = messaging?.recipient?.id;
  const messageText = messaging?.message?.text?.trim();

  if (!psid || !messageText || !pageId) {
    return { statusCode: 400, body: 'Invalid request' };
  }

  /* 1. Buscar / crear cliente_id */
  let clienteId = null;
  const { data: userData } = await supabase
    .from('messenger_users')
    .select('cliente_id')
    .eq('psid', psid)
    .maybeSingle();

  if (userData?.cliente_id) {
    clienteId = userData.cliente_id;
  } else {
    const { data: clienteData } = await supabase
      .from('clientes')
      .select('cliente_id')
      .eq('facebook_page_id', pageId)
      .maybeSingle();

    clienteId = clienteData?.cliente_id || 'C0000';

    await supabase.from('messenger_users').insert([
      {
        psid,
        cliente_id: clienteId,
        created_at: new Date().toISOString(),
      },
    ]);

    console.log(`🆕 Nuevo PSID registrado: ${psid} vinculado a cliente ${clienteId}`);
  }

  console.log(`✅ Cliente detectado: ${clienteId} para PSID: ${psid}`);

  /* 2. Guardar mensaje del cliente */
  const { data: nuevaConversacion } = await supabase
    .from('mensajes')
    .insert({
      cliente_id: clienteId,
      mensaje: messageText,
      quien_hablo: 'cliente',
      sender_id: psid,
    })
    .select('conversacion_id')
    .single();

  /* 3. Obtener contexto + nuevo mensaje y generar respuesta */
  const contexto = await obtenerContextoConversacion(clienteId);
  contexto.push({ role: 'user', content: messageText });

  let respuestaIA = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL || 'gpt-4',
    messages: contexto,
    temperature: 0.7,
  });

  let textoGenerado = respuestaIA.choices?.[0]?.message?.content || '...';

  /* 4. Detectar y procesar la llamada a buscarInventarioCliente */
  const match = textoGenerado.match(/\[buscarInventarioCliente\((.*?)\)\]/);

  if (match) {
    console.log('🧠 Se detectó llamada a buscarInventarioCliente');
    const argTexto = match[1];

    let medidaSolicitada = null;
    try {
      const argObj = JSON.parse(argTexto.replace(/'/g, '"'));
      medidaSolicitada = argObj?.medida;
    } catch (e) {
      console.error('⚠️ No se pudo parsear la medida:', e);
    }

    let textoLlantas = '';
    let alternativaUsada = false;

    if (medidaSolicitada) {
      const { data: stockExacto } = await supabase.rpc('buscar_llantas_anon', {
        medida: medidaSolicitada,
        clienteid: clienteId,
      });

      if (stockExacto?.length > 0) {
        textoLlantas = stockExacto
          .map(
            (llanta) =>
              `• ${llanta.marca} ${llanta.medida} – ${llanta.estado_fisico} – ${llanta.precio} pesos`
          )
          .join('\n\n');
      } else {
        console.log('❌ Sin stock exacto. Buscando compatibles...');

        const { data: alternativas } = await supabase
          .from('medidas_compatibles')
          .select('medida_alternativa')
          .eq('medida_original', medidaSolicitada);

        for (const alt of alternativas || []) {
          const medidaAlt = alt.medida_alternativa;
          const { data: stockAlt } = await supabase.rpc('buscar_llantas_anon', {
            medida: medidaAlt,
            clienteid: clienteId,
          });

          if (stockAlt?.length > 0) {
            alternativaUsada = true;
            textoLlantas = `No tenemos la medida ${medidaSolicitada}, pero esta medida compatible también le queda a tu vehículo:\n\n`;

            textoLlantas += stockAlt
              .map(
                (llanta) =>
                  `• ${llanta.marca} ${llanta.medida} – ${llanta.estado_fisico} – ${llanta.precio} pesos`
              )
              .join('\n\n');

            break;
          }
        }

        if (!alternativaUsada) {
          textoLlantas = `Por ahora no tenemos la medida ${medidaSolicitada}, ni una compatible en este momento.`;
        }
      }

      /* 4-a. Re-generar respuesta incluyendo el resultado de la búsqueda */
      const contexto2 = [
        ...contexto,
        { role: 'assistant', content: textoGenerado },
        { role: 'function', name: 'buscarInventarioCliente', content: textoLlantas },
      ];

      respuestaIA = await openai.chat.completions.create({
        model: process.env.OPENAI_MODEL || 'gpt-4',
        messages: contexto2,
        temperature: 0.7,
      });

      textoGenerado = respuestaIA.choices?.[0]?.message?.content || '...';
    }
  }

  /* 5. Limpiar cualquier resto de la llamada y enviar al usuario */
  const textoFinal = textoGenerado
    .replace(/\[buscarInventarioCliente\({.*?}\)\]/g, '')
    .trim();

  if (!textoFinal || textoFinal.trim() === '') {
    console.warn('⚠️ El textoFinal está vacío. Se omitirá el envío al usuario.');
    return { statusCode: 200, body: 'Mensaje vacío ignorado' };
  }

  /* 6. Mandar “typing...” a Messenger */
  await fetch(
    `https://graph.facebook.com/v17.0/me/messages?access_token=${process.env.FACEBOOK_PAGE_ACCESS_TOKEN}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient: { id: psid }, sender_action: 'typing_on' }),
    }
  );

  const delayMs = Math.min(4000, textoFinal.length * 30);
  await delay(delayMs);

  /* 7. Enviar texto final al usuario */
  await fetch(
    `https://graph.facebook.com/v17.0/me/messages?access_token=${process.env.FACEBOOK_PAGE_ACCESS_TOKEN}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient: { id: psid }, message: { text: textoFinal } }),
    }
  );

  /* 8. Guardar respuesta del bot */
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