import { FB_VERIFY_TOKEN } from '@/bot/config';
import { handleMessage } from '@/bot/facebook/handler';

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const mode = searchParams.get('hub.mode');
  const token = searchParams.get('hub.verify_token');
  const challenge = searchParams.get('hub.challenge');

  if (mode === 'subscribe' && token === FB_VERIFY_TOKEN) {
    return new Response(challenge, { status: 200 });
  }
  return new Response('Verificación fallida', { status: 403 });
}

export async function POST(req: Request) {
  const body = await req.json();
  const entry = body.entry?.[0];
  const messaging = entry?.messaging?.[0];
  const senderId = messaging?.sender?.id;
  const messageText = messaging?.message?.text;

  if (senderId && messageText) {
    await handleMessage(senderId, messageText);
  }

  return new Response('OK', { status: 200 });
}