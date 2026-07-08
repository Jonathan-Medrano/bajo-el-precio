// Envuelve una URL de producto de ML con los parámetros de afiliado (monetización).
function cleanProductUrl(link) {
  return String(link ?? "").split("#")[0].split("?")[0];
}

export function affiliateUrl(link) {
  const word = process.env.ML_AFFILIATE_WORD;
  const tool = process.env.ML_AFFILIATE_TOOL;
  const clean = cleanProductUrl(link);
  if (!word || !tool || !clean) return link ?? null;
  return `${clean}?matt_word=${encodeURIComponent(word)}&matt_tool=${encodeURIComponent(tool)}`;
}
