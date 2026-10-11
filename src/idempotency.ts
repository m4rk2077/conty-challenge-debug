export function normalizeKey(key: string): string {
  // U+200B aparece nas bordas no incidente; caracteres internos continuam parte da chave.
  return key.replace(/^[\s\u200B]+|[\s\u200B]+$/g, "").toLowerCase();
}
