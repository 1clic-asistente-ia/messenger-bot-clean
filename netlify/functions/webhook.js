import { createClient } from '@supabase/supabase-js';
import axios from 'axios';
import OpenAI from 'openai';

// Supabase y OpenAI
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Logger estructurado
function logger(level, message, data = {}) {
  const timestamp = new Date().toISOString();
  console.log(JSON.stringify({ timestamp, level, message, ...data }));
}

// Prompt base
const promptBase = `
Eres un asistente virtual profesional que ayuda a clientes a encontrar llantas. Siempre respondes con cortesía, precisión y un enfoque humano. Nunca pides datos personales. Puedes buscar medidas compatibles si no hay disponibilidad exacta. Si hay problemas técnicos, informa sin inventar respuestas.
`;

export const handler = async (event, context) => {
  if (event.httpMethod === 'GET') {
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
    try {
      const body = JSON.parse(event.body);
      const messagingEvent = body.entry?.[0]?.messaging?.[0];

      const { psid, pageId, mensajeTexto } = validarMensajeEntrante(messagingEvent);
      const { cliente_id, conversacion_id } = await obtenerUsuarioYConversacion(psid, pageId);
      const respuestaIA = await generarRespuestaIA(conversacion_id, mensajeTexto);
      await enviarMensajeMessenger(psid, respuestaIA);
      await guardarMensajes(conversacion_id, cliente_id, mensajeTexto, respuestaIA);

      return { statusCode: 200, body: 'Mensaje procesado' };
    } catch (err) {
      logger('error', 'Error en webhook', {
        error: err.message,
        stack: err.stack,
      });
      return { statusCode: 500, body: 'Error interno del servidor' };
    }
  }

  return { statusCode: 405, body: 'Método no permitido' };
};

function validarMensajeEntrante(messagingEvent) {
  if (!messagingEvent?.sender?.id) throw new Error('Falta sender.id');
  if (!messagingEvent?.recipient?.id) throw new Error('Falta recipient.id');

  return {
    psid: messagingEvent.sender.id,
    pageId: messagingEvent.recipient.id,
    mensajeTexto: messagingEvent.message?.text || '',
  };
}

async function obtenerUsuarioYConversacion(psid, pageId) {
  const { data: cliente, error: errorCliente } = await supabase
    .from('clientes')
    .select('cliente_id')
    .eq('facebook_page_id', pageId)
    .single();

  if (errorCliente || !cliente) throw new Error('Cliente no encontrado');

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

async function generarRespuestaIA(conversacion_id, mensajeUsuario) {
  const { data: mensajesAnteriores, error } = await supabase
    .from('mensajes')
    .select('contenido, tipo')
    .eq('conversacion_id', conversacion_id)
    .order('created_at', { ascending: false })
    .limit(6);

  if (error) {
    logger('error', 'Error al obtener historial', { error: error.message });
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

  return chatResponse.choices[0]?.message?.content?.trim() ||
    'Disculpa, no pude generar una respuesta en este momento.';
}

async function enviarMensajeMessenger(psid, texto) {
  const PAGE_ACCESS_TOKEN = process.env.FACEBOOK_PAGE_ACCESS_TOKEN;

  try {
    const response = await axios.post(
      `https://graph.facebook.com/v17.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
      {
        recipient: { id: psid },
        message: { text: texto },
      }
    );

    if (response.status !== 200) {
      throw new Error(`Error al enviar mensaje: ${response.statusText}`);
    }

    return response.data;
  } catch (error) {
    logger('error', 'Error al enviar mensaje a Facebook', {
      error: error.message,
      detalle: error.response?.data,
    });
    throw error;
  }
}

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
    logger('error', 'Error al guardar mensajes', { error: error.message });
  }
}
