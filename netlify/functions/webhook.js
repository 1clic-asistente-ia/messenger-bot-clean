// netlify/functions/webhook.js - CORRECCIÓN ESPECÍFICA PARA TU ESTRUCTURA
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
8. CRÍTICO: Cuando necesites buscar inventario, usa EXACTAMENTE este formato: [buscarInventarioCliente({"medida":"###/##R##"})]
   Ejemplo: [buscarInventarioCliente({"medida":"245/40R19"})]

JERARQUÍA DE RESPUESTA
1. Si la consulta es inválida, aclara tus límites.
2. Si detectas una medida válida o deducible: llama a [buscarInventarioCliente({"medida":"medida_aqui"})]
3. Si no hay stock local: busca medidas compatibles automáticamente.
4. Si tampoco existen compatibles: se consulta red_favoritos (por ahora desactivado).

RESPUESTAS
Habla como humano. No inventes llantas. Sé útil y directo.
`;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// FUNCIÓN PARA LOGS DETALLADOS
function logDetallado(mensaje, data = null) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${mensaje}`);
  if (data) {
    console.log(JSON.stringify(data, null, 2));
  }
}

// FUNCIÓN PARA CREAR/OBTENER CONVERSACIÓN
async function obtenerOCrearConversacion(clienteId, psid) {
  try {
    // Buscar conversación activa existente
    const { data: conversacionExistente } = await supabase
      .from('conversaciones')
      .select('id')
      .eq('cliente_id', clienteId)
      .eq('facebook_user_id', psid)
      .eq('estado', 'activa')
      .maybeSingle();

    if (conversacionExistente) {
      logDetallado('✅ Conversación existente encontrada', { conversacion_id: conversacionExistente.id });
      return conversacionExistente.id;
    }

    // Crear nueva conversación
    const { data: nuevaConversacion, error } = await supabase
      .from('conversaciones')
      .insert({
        cliente_id: clienteId,
        facebook_user_id: psid,
        estado: 'activa',
        resumen_contexto: 'Nueva conversación iniciada'
      })
      .select('id')
      .single();

    if (error) {
      logDetallado('❌ Error creando conversación:', error);
      return null;
    }

    logDetallado('✅ Nueva conversación creada', { conversacion_id: nuevaConversacion.id });
    return nuevaConversacion.id;
    
  } catch (error) {
    logDetallado('❌ Error en obtenerOCrearConversacion:', error);
    return null;
  }
}

/* ----------  FUNCIÓN AUXILIAR: MEMORIA DE CONVERSACIÓN  ---------- */
async function obtenerContextoConversacion(conversacionId, limite = 6) {
  try {
    const { data: mensajes, error } = await supabase
      .from('mensajes')
      .select('mensaje, quien_hablo')
      .eq('conversacion_id', conversacionId)
      .order('created_at', { ascending: true })
      .limit(limite);

    if (error) {
      logDetallado('❌ Error obteniendo contexto:', error);
      return [{ role: 'system', content: promptBase }];
    }

    const contexto = [{ role: 'system', content: promptBase }];
    (mensajes || []).forEach(m => {
      contexto.push({
        role: m.quien_hablo === 'cliente' ? 'user' : 'assistant',
        content: m.mensaje,
      });
    });

    logDetallado('✅ Contexto obtenido', { mensajes_count: mensajes?.length || 0 });
    return contexto;
    
  } catch (error) {
    logDetallado('❌ Error en obtenerContextoConversacion:', error);
    return [{ role: 'system', content: promptBase }];
  }
}

// FUNCIÓN PARA BUSCAR LLANTAS MEJORADA
async function buscarLlantasEnInventario(medida, clienteId) {
  try {
    logDetallado('🔍 Buscando llantas', { medida, clienteId });

    // Buscar inventario exacto
    const { data: stockExacto, error: errorExacto } = await supabase
      .rpc('buscar_llantas_anon', {
        medida: medida,
        clienteid: clienteId,
      });

    if (errorExacto) {
      logDetallado('❌ Error en búsqueda exacta:', errorExacto);
      return `Error al buscar la medida ${medida}`;
    }

    if (stockExacto?.length > 0) {
      const textoLlantas = stockExacto
        .map(llanta => `• ${llanta.marca} ${llanta.medida} – ${llanta.estado_fisico} – $${llanta.precio} pesos`)
        .join('\n\n');
      
      logDetallado('✅ Stock exacto encontrado', { cantidad: stockExacto.length });
      return textoLlantas;
    }

    // Buscar alternativas compatibles
    logDetallado('🔄 Buscando medidas compatibles para:', medida);
    
    const { data: alternativas, error: errorAlternativas } = await supabase
      .from('medidas_compatibles')
      .select('medida_alternativa')
      .eq('medida_original', medida);

    if (errorAlternativas) {
      logDetallado('❌ Error buscando alternativas:', errorAlternativas);
      return `No tenemos la medida ${medida} disponible en este momento.`;
    }

    for (const alt of alternativas || []) {
      const medidaAlt = alt.medida_alternativa;
      logDetallado('🔍 Probando alternativa:', medidaAlt);
      
      const { data: stockAlt } = await supabase.rpc('buscar_llantas_anon', {
        medida: medidaAlt,
        clienteid: clienteId,
      });

      if (stockAlt?.length > 0) {
        const textoAlternativas = stockAlt
          .map(llanta => `• ${llanta.marca} ${llanta.medida} – ${llanta.estado_fisico} – $${llanta.precio} pesos`)
          .join('\n\n');

        const resultado = `No tengo la medida ${medida} exacta, pero esta medida compatible también sirve para tu vehículo:\n\n${textoAlternativas}`;
        
        logDetallado('✅ Alternativa encontrada', { medida_alternativa: medidaAlt, cantidad: stockAlt.length });
        return resultado;
      }
    }

    logDetallado('❌ Sin stock ni alternativas');
    return `No tenemos la medida ${medida} ni alternativas compatibles disponibles en este momento.`;
    
  } catch (error) {
    logDetallado('❌ Error en buscarLlantasEnInventario:', error);
    return `Error al procesar tu búsqueda de ${medida}`;
  }
}

/* ------------------  HANDLER PRINCIPAL  ------------------ */
exports.handler = async (event, context) => {
  logDetallado('🚀 INICIO DE WEBHOOK');
  
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  let body;
  try {
    body = JSON.parse(event.body);
    logDetallado('📥 Body recibido:', body);
  } catch (error) {
    logDetallado('❌ Error parseando body:', error);
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  const entry = body.entry?.[0];
  const messaging = entry?.messaging?.[0];
  const psid = messaging?.sender?.id;
  const pageId = messaging?.recipient?.id;
  const messageText = messaging?.message?.text?.trim();

  logDetallado('📊 Datos extraídos:', { psid, pageId, messageText });

  if (!psid || !messageText || !pageId) {
    logDetallado('❌ Datos incompletos');
    return { statusCode: 400, body: 'Invalid request data' };
  }

  try {
    /* 1. Buscar / crear cliente_id */
    let clienteId = null;
    const { data: userData, error: userError } = await supabase
      .from('messenger_users')
      .select('cliente_id')
      .eq('psid', psid)
      .maybeSingle();

    if (userError) {
      logDetallado('❌ Error consultando messenger_users:', userError);
    }

    if (userData?.cliente_id) {
      clienteId = userData.cliente_id;
      logDetallado('✅ Cliente existente encontrado:', clienteId);
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

      logDetallado('✅ Nuevo PSID registrado:', { psid, clienteId });
    }

    /* 2. Crear/obtener conversación */
    const conversacionId = await obtenerOCrearConversacion(clienteId, psid);
    if (!conversacionId) {
      // Si no se puede crear conversación, usar el ID del cliente como fallback
      logDetallado('⚠️ Usando cliente_id como conversacion_id fallback');
      conversacionId = clienteId;
    }

    /* 3. Guardar mensaje del cliente */
    const { error: insertErrorCliente } = await supabase
      .from('mensajes')
      .insert({
        conversacion_id: conversacionId,
        mensaje: messageText,
        quien_hablo: 'cliente',
        cliente_id: clienteId
      });

    if (insertErrorCliente) {
      logDetallado('❌ Error insertando mensaje cliente:', insertErrorCliente);
    } else {
      logDetallado('✅ Mensaje cliente guardado');
    }

    /* 4. Obtener contexto + nuevo mensaje y generar respuesta */
    const contexto = await obtenerContextoConversacion(conversacionId);
    contexto.push({ role: 'user', content: messageText });

    logDetallado('🧠 Generando respuesta con OpenAI...');

    let respuestaIA = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4',
      messages: contexto,
      temperature: 0.7,
    });

    let textoGenerado = respuestaIA.choices?.[0]?.message?.content || 'Lo siento, no pude procesar tu mensaje.';
    
    logDetallado('💬 Respuesta inicial de IA:', textoGenerado);

    /* 5. DETECTAR Y PROCESAR LA LLAMADA - PATRÓN CORREGIDO CON CORCHETES */
    const match = textoGenerado.match(/\[buscarInventarioCliente\((.*?)\)\]/);

    if (match) {
      logDetallado('🧠 Se detectó llamada a buscarInventarioCliente');
      const argTexto = match[1];

      let medidaSolicitada = null;
      try {
        const argObj = JSON.parse(argTexto.replace(/'/g, '"'));
        medidaSolicitada = argObj?.medida;
        logDetallado('🔍 Medida extraída:', medidaSolicitada);
      } catch (e) {
        logDetallado('⚠️ No se pudo parsear la medida:', e);
      }

      if (medidaSolicitada) {
        const textoLlantas = await buscarLlantasEnInventario(medidaSolicitada, clienteId);

        /* 5-a. Re-generar respuesta incluyendo el resultado de la búsqueda */
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

        textoGenerado = respuestaIA.choices?.[0]?.message?.content || textoLlantas;
        logDetallado('💬 Respuesta final con inventario:', textoGenerado);
      }
    }

    /* 6. Limpiar cualquier resto de la llamada y enviar al usuario */
    const textoFinal = textoGenerado
      .replace(/\[buscarInventarioCliente\({.*?}\)\]/g, '')
      .trim();

    if (!textoFinal || textoFinal.trim() === '') {
      logDetallado('⚠️ El textoFinal está vacío. Se omitirá el envío al usuario.');
      return { statusCode: 200, body: 'Mensaje vacío ignorado' };
    }

    /* 7. Mandar "typing..." a Messenger */
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

    /* 8. Enviar texto final al usuario */
    const responseMessenger = await fetch(
      `https://graph.facebook.com/v17.0/me/messages?access_token=${process.env.FACEBOOK_PAGE_ACCESS_TOKEN}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipient: { id: psid }, message: { text: textoFinal } }),
      }
    );

    if (!responseMessenger.ok) {
      const errorText = await responseMessenger.text();
      logDetallado('❌ Error enviando mensaje a Facebook:', errorText);
    } else {
      logDetallado('✅ Mensaje enviado a usuario exitosamente');
    }

    /* 9. Guardar respuesta del bot */
    const { error: insertErrorBot } = await supabase
      .from('mensajes')
      .insert({
        conversacion_id: conversacionId,
        mensaje: textoFinal,
        quien_hablo: 'asistente',
        cliente_id: clienteId
      });

    if (insertErrorBot) {
      logDetallado('❌ Error insertando mensaje bot:', insertErrorBot);
    } else {
      logDetallado('✅ Mensaje bot guardado');
    }

    /* 10. Actualizar conversación */
    if (conversacionId !== clienteId) { // Solo si es una conversación real, no el fallback
      await supabase
        .from('conversaciones')
        .update({ ultima_actividad: new Date().toISOString() })
        .eq('id', conversacionId);
    }

    logDetallado('✅ PROCESO COMPLETADO EXITOSAMENTE');
    return { statusCode: 200, body: 'OK' };

  } catch (error) {
    logDetallado('❌ ERROR CRÍTICO EN HANDLER:', error);
    
    // Enviar mensaje de error al usuario si es posible
    try {
      await fetch(
        `https://graph.facebook.com/v17.0/me/messages?access_token=${process.env.FACEBOOK_PAGE_ACCESS_TOKEN}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            recipient: { id: psid }, 
            message: { text: 'Disculpa, estoy teniendo problemas técnicos. Inténtalo de nuevo en un momento.' } 
          }),
        }
      );
    } catch (sendError) {
      logDetallado('❌ Error enviando mensaje de error:', sendError);
    }
    
    return { statusCode: 500, body: 'Internal server error' };
  }
};