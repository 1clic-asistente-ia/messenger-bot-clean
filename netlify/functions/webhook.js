const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const OpenAI = require('openai');

// Instancia Supabase y OpenAI
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Prompt base del asistente
const promptBase = `
Eres un asistente virtual profesional que ayuda a clientes a encontrar llantas. Siempre respondes con cortesía, precisión y un enfoque humano. Nunca pides datos personales. Puedes buscar medidas compatibles si no hay disponibilidad exacta. Si hay problemas técnicos, informa sin inventar respuestas.
`;

exports.handler = async (event, context) => {
  if (event.httpMethod === 'GET') {
    // Verificación del Webhook de Facebook
    const VERIFY_TOKEN = process.env.FACEBOOK_VERIFY_TOKEN;
    const mode = event.queryStringParameters['hub.mode'];
    const token = event.queryStringParameters['hub.verify_token'];
    const challenge = event.queryStringParameters['hub.challenge'];

    if (mode && token === VERIFY_TOKEN) {
      return { statusCode: 200, body: challenge };
    } else {
      return { statusCode: 403, body: 'Token inválido' };
    }
  }

  if (event.httpMethod === 'POST') {
    const body = JSON.parse(event.body);

    if (!body.entry || !body.entry[0].messaging) {
      return { statusCode: 200, body: 'Sin mensajes relevantes' };
    }

    const messagingEvent = body.entry[0].messaging[0];
    const psid = messagingEvent.sender.id;
    const pageId = messagingEvent.recipient.id;
    const mensajeTexto = messagingEvent.message?.text;

    if (!mensajeTexto) {
      return { statusCode: 200, body: 'Sin texto que procesar' };
    }

    try {
      // Obtener cliente, usuario y conversación
      const { cliente_id, conversacion_id, messenger_user_id } =
        await obtenerUsuarioYConversacion(psid, pageId);

      // Generar respuesta con OpenAI usando historial
      const respuestaIA = await generarRespuestaIA(conversacion_id, mensajeTexto);

      // Enviar respuesta al usuario
      await enviarMensajeMessenger(psid, respuestaIA);

      // Guardar ambos mensajes en Supabase con cliente_id
      await guardarMensajes(conversacion_id, cliente_id, mensajeTexto, respuestaIA);

      return { statusCode: 200, body: 'Mensaje procesado' };
    } catch (err) {
      console.error('Error en webhook:', err.message);
      return { statusCode: 500, body: 'Error interno del servidor' };
    }
  }

  return { statusCode: 405, body: 'Método no permitido' };
};

// Buscar o crear messenger_user y conversación activa
async function obtenerUsuarioYConversacion(psid, pageId) {
  const { data: cliente, error: errorCliente } = await supabase
    .from('clientes')
    .select('cliente_id')
    .eq('facebook_page_id', pageId)
    .single();

  if (errorCliente || !cliente) {
    throw new Error('No se pudo identificar al cliente por pageId');
  }

  const cliente_id = cliente.cliente_id;

  const { data: usuario } = await supabase
    .from('messenger_users')
    .select('id')
    .eq('psid', psid)
    .eq('cliente_id', cliente_id)
    .single();

  let messenger_user_id = usuario?.id;

  if (!messenger_user_id) {
    const { data: nuevo } = await supabase
      .from('messenger_users')
      .insert([{ psid, cliente_id }])
      .select('id')
      .single();
    messenger_user_id = nuevo.id;
  }

  const { data: conversacion } = await supabase
    .from('conversaciones')
    .select('id')
    .eq('facebook_user_id', psid)
    .eq('cliente_id', cliente_id)
    .eq('estado', 'activa')
    .single();

  let conversacion_id = conversacion?.id;

  if (!conversacion_id) {
    const { data: nueva } = await supabase
      .from('conversaciones')
      .insert([
        {
          facebook_user_id: psid,
          cliente_id,
          estado: 'activa',
          resumen_contexto: '',
        },
      ])
      .select('id')
      .single();
    conversacion_id = nueva.id;
  }

  return { cliente_id, conversacion_id, messenger_user_id };
}

// Leer historial reciente y generar respuesta con OpenAI
async function generarRespuestaIA(conversacion_id, mensajeUsuario) {
  const { data: mensajesAnteriores, error } = await supabase
    .from('mensajes')
    .select('contenido, tipo')
    .eq('conversacion_id', conversacion_id)
    .order('created_at', { ascending: false })
    .limit(6);

  if (error) {
    console.error('Error al obtener historial:', error.message);
    return 'Lo siento, hubo un error técnico. Intenta más tarde.';
  }

  const messages = [
    { role: 'system', content: promptBase },
    ...mensajesAnteriores
      .reverse()
      .map(m => ({
        role: m.tipo === 'usuario' ? 'user' : 'assistant',
        content: m.contenido,
      })),
    { role: 'user', content: mensajeUsuario },
  ];

  const chatResponse = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL || 'gpt-3.5-turbo',
    messages,
    temperature: 0.7,
  });

  const textoRespuesta = chatResponse.choices[0]?.message?.content?.trim();

  return textoRespuesta || 'Disculpa, no pude generar una respuesta en este momento.';
}

// Enviar mensaje por Messenger
async function enviarMensajeMessenger(psid, texto) {
  const PAGE_ACCESS_TOKEN = process.env.FACEBOOK_PAGE_ACCESS_TOKEN;

  await axios.post(
    `https://graph.facebook.com/v17.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
    {
      recipient: { id: psid },
      message: { text: texto },
    }
  );
}

// Guardar mensaje del usuario y respuesta del bot en Supabase con cliente_id
async function guardarMensajes(conversacion_id, cliente_id, mensajeUsuario, mensajeBot) {
  const { error } = await supabase.from('mensajes').insert([
    {
      conversacion_id,
      cliente_id,
      contenido: mensajeUsuario,
      tipo: 'usuario',
    },
    {
      conversacion_id,
      cliente_id,
      contenido: mensajeBot,
      tipo: 'asistente',
    },
  ]);

  if (error) {
    console.error('Error al guardar mensajes:', error.message);
  }
}
