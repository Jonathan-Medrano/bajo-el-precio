// Prueba #5: límite de alertas free, bypass premium, API key B2B + cuota.
const API = "http://localhost:3000";
const ADMIN = process.env.ADMIN_TOKEN;
const T5 = "T5_test";
const j = (r) => r.json();
const post = (path, body, headers = {}) =>
  fetch(`${API}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) }).then(j);
const sub = (productId) => post("/api/alerts", { chatId: T5, productId });

console.log("== Límite del plan free (tope 3) ==");
for (const p of ["TESTP1", "TESTP2", "TESTP3"]) console.log(`  ${p}:`, JSON.stringify(await sub(p)).slice(0, 50));
const fourth = await sub("TESTP4");
console.log("  TESTP4 (debe dar limit):", JSON.stringify(fourth));

console.log("\n== Grant premium + reintento ==");
const grant = await post("/api/premium", { chatId: T5 }, { "x-admin-token": ADMIN });
console.log("  grant:", JSON.stringify(grant));
const fourthAgain = await sub("TESTP4");
console.log("  TESTP4 ahora (debe dar ok):", JSON.stringify(fourthAgain).slice(0, 40));
console.log("  plan de T5:", JSON.stringify(await fetch(`${API}/api/plan/${T5}`).then(j)));

console.log("\n== API key B2B ==");
const noAdmin = await post("/api/keys", { name: "x" });
console.log("  crear key sin admin (debe 403):", JSON.stringify(noAdmin));
const keyRes = await post("/api/keys", { name: "Cliente Test", plan: "pro" }, { "x-admin-token": ADMIN });
console.log("  key creada:", JSON.stringify(keyRes));
const key = keyRes.key;

const noKey = await fetch(`${API}/v1/products`);
console.log("  /v1/products sin key (debe 401):", noKey.status);
const withKey = await fetch(`${API}/v1/products`, { headers: { "x-api-key": key } });
const items = await withKey.json();
console.log("  /v1/products con key:", withKey.status, "| items:", Array.isArray(items) ? items.length : items);
console.log("  RateLimit-Limit:", withKey.headers.get("x-ratelimit-limit"), "| Remaining:", withKey.headers.get("x-ratelimit-remaining"));

console.log("\n== Limpieza ==");
import("../src/db.js").then(async ({ prisma }) => {
  await prisma.alert.deleteMany({ where: { chatId: T5 } });
  await prisma.subscriber.deleteMany({ where: { chatId: T5 } });
  await prisma.product.deleteMany({ where: { id: { in: ["TESTP1", "TESTP2", "TESTP3", "TESTP4"] } } });
  await prisma.apiKey.deleteMany({ where: { name: "Cliente Test" } });
  console.log("  ✅ datos de prueba borrados");
  process.exit(0);
});
