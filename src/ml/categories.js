// ML Argentina category ID → our category name.
// Subcategories listed first (most specific); parents as fallback.
export const ML_CATEGORIES = {
  // Celulares
  "MLA1051": "Celulares",
  "MLA1055": "Celulares",
  "MLA3502": "Celulares",
  "MLA3813": "Celulares",

  // Relojes inteligentes — fixes smartwatch-in-celulares (MLA417704 is under MLA1051)
  "MLA417704": "Relojes inteligentes",
  "MLA431677": "Relojes inteligentes",
  "MLA3937":   "Relojes inteligentes",

  // Notebooks
  "MLA430687": "Notebooks",

  // Computación
  "MLA1648": "Computación",
  "MLA1649": "Computación",
  "MLA430637": "Computación",
  "MLA1656":   "Computación",
  "MLA430598": "Computación",
  "MLA454379": "Computación",
  "MLA3794":   "Computación",
  "MLA1700":   "Computación",

  // Tablets
  "MLA400950": "Tablets",

  // Televisores
  "MLA1002": "Televisores",

  // Auriculares
  "MLA3697": "Auriculares",

  // Audio
  "MLA409810": "Audio",
  "MLA3690":   "Audio",

  // Streaming
  "MLA352001": "Streaming",

  // Gaming / Consolas
  "MLA1144":   "Gaming",
  "MLA438566": "Gaming",
  "MLA373840": "Gaming",
  "MLA438578": "Gaming",
  "MLA439527": "Gaming",
  "MLA447778": "Gaming",
  "MLA8232":   "Gaming",

  // Cámaras
  "MLA1039":   "Cámaras",
  "MLA352294": "Cámaras",

  // Electrodomésticos
  "MLA5726": "Electrodomésticos",

  // Hogar
  "MLA1574": "Hogar",
  "MLA9304": "Hogar",

  // Zapatillas y calzado (MLA3794/MLA1700 already used for Computación — skip)
  "MLA1430": "Zapatillas",
  "MLA412848": "Zapatillas",
  "MLA412849": "Zapatillas",

  // Indumentaria deportiva
  "MLA3011": "Indumentaria",
  "MLA410269": "Indumentaria",

  // Perfumes y belleza
  "MLA109947": "Perfumes",
  "MLA3025": "Belleza",
  "MLA109946": "Belleza",

  // Suplementos deportivos
  "MLA1294": "Suplementos",

  // Deportes (parent categories)
  "MLA1276": "Deportes",
  "MLA3482": "Deportes",

  // Colchones
  "MLA9366": "Colchones",

  // Muebles
  "MLA9302": "Muebles",

  // Seguridad y vigilancia
  "MLA3067": "Seguridad",
  "MLA430585": "Seguridad",

  // Smart Home
  "MLA454086": "Smart Home",

  // Energía (UPS, generadores, solar)
  "MLA1572": "Energía",

  // Impresoras
  "MLA1684": "Impresoras",
  "MLA430640": "Impresoras",

  // Redes y networking
  "MLA3825": "Redes",

  // Bebés y niños
  "MLA5765": "Bebés",
  "MLA1132": "Bebés",
  "MLA9108": "Bebés",

  // Herramientas
  "MLA1459": "Herramientas",

  // Automotor
  "MLA1747": "Automotor",

  // Electrónica (fallback parent — must stay last to not override specifics above)
  "MLA1000": "Electrónica",
};

/**
 * Map an ML category_id to our local category name.
 * Returns `fallback` when the ID isn't in the map.
 */
export function mapMlCategory(categoryId, fallback = null) {
  if (!categoryId) return fallback;
  return ML_CATEGORIES[categoryId] ?? fallback;
}
