import 'dotenv/config';
import express from 'express';
import fetch from 'node-fetch';
import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import OpenAI from 'openai';

const app = express();
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const promptBase = fs.readFileSync(process.env.PROMPT_PATH, 'utf-8');

// Verificación del Webhook
app.get('/webhook', (req, res) => {
  const VERIFY_TOKEN = process.env.FACEBOOK_VERIFY_TOKEN;
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token && mode === 'subscribe' && token === VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// Recepción de mensajes
app.post('/webhook', async (req, res) => {
  const body = req.body;

  if (body.object === 'page') {
    for (const entry of body.entry) {
      for (const event of entry.messaging) {
        const senderId = event.sender.id;

        if (event.message && event.message.text) {
          const mensajeCliente = event.message.text;

          // 1. Obtener datos del cliente desde Supabase
          const { data: cliente } = await supabase
            .from('clientes')
            .select('nombre, direccion, horarios, servicios')
            .eq('pagina_facebook_id', entry.id)  // esto asume que guardas el page_id
            .single();

          // 2. Construir el mensaje a GPT
          const mensajeGPT = `
${promptBase}

Información de la llantera:
- Nombre: ${cliente?.nombre || 'No disponible'}
- Dirección: ${cliente?.direccion || 'No disponible'}
- Horarios: ${cliente?.horarios || 'No disponible'}
- Servicios: ${cliente?.servicios?.join(', ') || 'No disponible'}

Cliente pregunta:
"${mensajeCliente}"
          `;

          // 3. Consultar OpenAI
          const respuesta = await openai.chat.completions.create({
            model: 'gpt-3.5-turbo',
            messages: [
              { role: 'system', content: promptBase },
              { role: 'user', content: mensajeGPT }
            ]
          });

          const textoRespuesta = respuesta.choices[0].message.content;

          // 4. Enviar respuesta a Messenger
          await fetch(`https://graph.facebook.com/v18.0/me/messages?access_token=${process.env.FACEBOOK_PAGE_ACCESS_TOKEN}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              recipient: { id: senderId },
              message: { text: textoRespuesta }
            })
          });
        }
      }
    }

    res.sendStatus(200);
  } else {
    res.sendStatus(404);
  }
});

// Iniciar server local (para pruebas)
if (process.env.NODE_ENV !== 'production') {
  app.listen(3000, () => console.log('Bot escuchando en http://localhost:3000'));
}
