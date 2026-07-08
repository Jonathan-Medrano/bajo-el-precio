export function parseInstallments(text) {
  if (!text) return null;
  const m = text.match(/(\d+)\s*cuotas?\s*de\s*\$?\s*([\d.]+)/i);
  if (!m) return null;
  const count = parseInt(m[1], 10);
  const amount = parseInt(m[2].replace(/[^\d]/g, ""), 10);
  if (!count || !amount) return null;
  const sinInteres = /mismo precio|sin inter[eé]s/i.test(text);
  return { count, amount, total: count * amount, sinInteres };
}

export function pickByView(matches, view) {
  if (!matches?.length) return null;
  const conCuotas = matches.filter((m) => m.cuotas);
  switch (view) {
    case "sinInteres": {
      const si = matches.filter((m) => m.cuotas?.sinInteres).sort((a, b) => a.price - b.price);
      return si[0] ?? null;
    }
    case "menorCuota":
      return [...conCuotas].sort((a, b) => a.cuotas.amount - b.cuotas.amount)[0] ?? null;
    case "menorTotal":
      return [...conCuotas].sort((a, b) => a.cuotas.total - b.cuotas.total)[0] ?? null;
    default:
      return matches[0];
  }
}
