import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

const AIRTABLE_BASE = process.env.AIRTABLE_BASE;
const AIRTABLE_TABLE = process.env.AIRTABLE_TABLE;
const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;

// 1️⃣ BUSCAR REGISTROS PENDIENTES
async function getPendientes() {
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${AIRTABLE_TABLE}?filterByFormula={RESULTADO}='Pendiente'`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${AIRTABLE_TOKEN}`,
    },
  });

  const data = await res.json();
  return data.records || [];
}

// 2️⃣ PROCESAR CADA REGISTRO
async function procesarRegistro(record) {
  const dni = record.fields.DNI;
  const monto = record.fields.MONTOAFINANCIAR;

  console.log("🔎 Procesando registro:", record.id, dni, monto);

  // LLAMAR A TU API
  const apiUrl = `https://assen-api-credicuotas.jrmdlw.easypanel.host/api/credicuotas/dni/${dni}/monto/${monto}`;

  let data;
  try {
    const res = await fetch(apiUrl);
    data = await res.json();
  } catch (err) {
    console.error("❌ Error API:", err);
    return;
  }

  console.log("📩 Respuesta API:", data);

  // 3️⃣ ACTUALIZAR RESULTADO EN AIRTABLE (GUARDAR JSON COMPLETO)
  const updateUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${AIRTABLE_TABLE}/${record.id}`;

  await fetch(updateUrl, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${AIRTABLE_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      fields: {
        RESULTADO: JSON.stringify(data),   // ← GUARDA EL JSON COMPLETO EN RESULTADO
      },
    }),
  });

  console.log("✔ Registro actualizado:", record.id);
}

// 3️⃣ LOOP
async function loop() {
  console.log("⏳ Buscando RESULTADO = Pendiente...");

  const pendientes = await getPendientes();

  if (pendientes.length === 0) {
    console.log("No hay pendientes.");
  }

  for (let record of pendientes) {
    await procesarRegistro(record);
  }

  console.log("🔁 Esperando 5s...");
}

// Ejecutar cada 5 segundos
setInterval(loop, 5000);

console.log("🚀 Watcher Airtable financiaciones iniciado...");