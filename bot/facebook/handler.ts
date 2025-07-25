import { buscarLlantasAnon } from './supabase';
import { consultarOpenAI } from './openai';
import { extractMedida } from '../utils/extractMedida';
import { FB_PAGE_TOKEN } from '../config';

export async function handleMessage(senderId: string, text: string) {
  const medida = extractMedida(text);
  let reply = "";

  if (medida) {
    const llantas = await buscarLlantasAnon(medida);
    if (llantas.length === 0) {
      reply = `No encontré llantas con medida ${medida}.`;
    } else {
      reply = `Llantas disponibles para ${medida}:

`;
      for (const llanta of llantas.slice(0, 5)) {
        reply += `• ${llanta.marca || 'Marca?'} - $${llanta.precio} - ${llanta.ubicacion || 'Ubicación?'}\n`;
      }
      if (llantas.length > 5) reply += `\nY más disponibles...`;
    }
  } else {
    reply = await consultarOpenAI(`Responde brevemente a esta pregunta de un cliente de llantas:

"${text}"`);
  }

  return sendMessage(senderId, reply);
}

async function sendMessage(recipientId: string, message: string) {
  await fetch(`https://graph.facebook.com/v18.0/me/messages?access_token=${FB_PAGE_TOKEN}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      recipient: { id: recipientId },
      message: { text: message },
    }),
  });
}