export function extractMedida(text: string): string | null {
  const match = text.match(/\d{3}\/\d{2}R\d{2}/i);
  return match ? match[0].toUpperCase() : null;
}