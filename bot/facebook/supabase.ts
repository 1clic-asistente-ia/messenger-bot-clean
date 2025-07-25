import { SUPABASE_URL, SUPABASE_KEY } from '../config';

export async function buscarLlantasAnon(medida: string) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/buscar_llantas_anon`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ medida_buscada: medida }),
  });

  if (!res.ok) throw new Error(`Supabase error: ${res.statusText}`);
  return res.json();
}