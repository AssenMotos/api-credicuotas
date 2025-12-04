require("dotenv").config();
const express = require("express");
const puppeteer = require("puppeteer");

const PORT = process.env.PORT || 3000;
const USER = process.env.CREDICUOTAS_USER;
const PASS = process.env.CREDICUOTAS_PASS;

if (!USER || !PASS) {
  throw new Error("Debe configurar CREDICUOTAS_USER y CREDICUOTAS_PASS en el archivo .env");
}
const HEADLESS_MODE = process.env.HEADLESS === "false" ? false : "new";

const FORM_DEFAULTS = {
  product: process.env.CREDICUOTAS_PRODUCT || "MOTO",
  subproduct: process.env.CREDICUOTAS_SUBPRODUCT || "MOTOS",
  term: process.env.CREDICUOTAS_TERM || "4",
  gender: process.env.CREDICUOTAS_GENDER || "M",
  productIndex: Number(process.env.CREDICUOTAS_PRODUCT_INDEX ?? 2),
  subproductIndex: Number(process.env.CREDICUOTAS_SUBPRODUCT_INDEX ?? 0),
  genderIndex: Number(process.env.CREDICUOTAS_GENDER_INDEX ?? 0),
  pep: process.env.CREDICUOTAS_PEP || "no",
  obligated: process.env.CREDICUOTAS_OBLIGATED || "no"
};

async function pause(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function selectMuiByLabel(page, labelText, targetText) {
  if (!labelText || !targetText) {
    return false;
  }

  const point = await page.evaluate(({ labelText }) => {
    const normalize = str => (str || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .trim();

    const label = [...document.querySelectorAll("label")]
      .find(el => normalize(el.textContent).includes(normalize(labelText)));
    if (!label) return null;

    const root = label.closest(".MuiFormControl-root");
    if (!root) return null;

    const trigger = root.querySelector(".MuiSelect-select");
    if (!trigger) return null;

    trigger.scrollIntoView({ block: "center", behavior: "instant" });
    const rect = trigger.getBoundingClientRect();
    return {
      x: rect.x + rect.width / 2,
      y: rect.y + rect.height / 2
    };
  }, { labelText });

  if (!point) {
    console.warn(`[Credicuotas] No se encontró el select con label ${labelText}`);
    return false;
  }

  await page.mouse.move(point.x, point.y);
  await page.mouse.click(point.x, point.y, { delay: 50 });
  await pause(200);

  try {
    await page.waitForSelector('ul[role="listbox"] li', { visible: true, timeout: 5000 });
  } catch (error) {
    console.warn(`[Credicuotas] No se abrió el menú para ${labelText}`, error);
    return false;
  }

  const clicked = await page.evaluate(({ targetText }) => {
    const normalize = str => (str || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .trim();

    const items = [...document.querySelectorAll('ul[role="listbox"] li')]
      .filter(li => !li.getAttribute("aria-disabled"));
    const match = items.find(li => normalize(li.innerText).includes(normalize(targetText)));
    if (!match) return false;

    match.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    return true;
  }, { targetText }).catch(() => false);

  await page.keyboard.press("Escape").catch(() => {});
  await pause(150);
  return clicked;
}

function normalizeForMatch(text) {
  return (text || "")
    .toString()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function resolveGenderValue(value) {
  const normalized = normalizeForMatch(value);
  if (!normalized) return null;
  if (normalized === "m" || normalized.startsWith("masc")) return "M";
  if (normalized === "f" || normalized.startsWith("fem")) return "F";
  if (normalized.startsWith("otr")) return "O";
  return value;
}

function preferenceToRadioValue(pref, defaultValue = false) {
  const normalized = normalizeForMatch(pref);
  if (!normalized) {
    return defaultValue ? "true" : "false";
  }

  if (["si", "sí", "s", "true", "1", "yes", "y"].includes(normalized)) {
    return "true";
  }
  if (["no", "false", "0", "n"].includes(normalized)) {
    return "false";
  }

  return defaultValue ? "true" : "false";
}

function sanitizeAmountInput(value) {
  if (value === null || value === undefined) return null;
  const numeric = String(value).replace(/[^\d]/g, "");
  if (!numeric) return null;
  const parsed = parseInt(numeric, 10);
  return Number.isNaN(parsed) || parsed <= 0 ? null : parsed;
}

async function calcularPlanCuotas(page, amountValue) {
  const inputSelector = 'input[name="amount"]';
  const normalized = amountValue.toString();

  try {
    await page.waitForSelector(inputSelector, { visible: true, timeout: 20000 });
    await page.click(inputSelector, { clickCount: 3 }).catch(() => {});
    await page.keyboard.press("Backspace").catch(() => {});
    await page.type(inputSelector, normalized, { delay: 20 });

    const clicked = await page.evaluate(() => {
      const normalize = text => (text || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase();

      const btn = [...document.querySelectorAll("button")]
        .find(b => normalize(b.innerText).includes("calcular"));
      if (btn) {
        btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        return true;
      }
      return false;
    });

    if (!clicked) {
      return {
        exito: false,
        montoSolicitado: amountValue,
        planes: [],
        mensaje: "No se encontró el botón Calcular"
      };
    }

    await pause(2000);
    await page.waitForFunction(() => {
      return document.querySelectorAll("div.MuiCard-root button.MuiCardActionArea-root").length > 0;
    }, { timeout: 20000 }).catch(() => {});

    const simulacion = await page.evaluate(() => {
      const normalize = text => (text || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase();

      const cards = [...document.querySelectorAll("div.MuiCard-root button.MuiCardActionArea-root")];
      const planes = cards.map(card => {
        const textos = [...card.querySelectorAll("p")]
          .map(p => p.textContent.trim())
          .filter(Boolean);
        const cuotaLabel = textos.find(t => /cuotas/i.test(t)) || null;
        const montoCuota = textos.find(t => /^\$/.test(t)) || null;
        const adicionales = textos.filter(t => t !== cuotaLabel && t !== montoCuota);
        return {
          plan: cuotaLabel,
          cuota: montoCuota,
          detalle: adicionales
        };
      });

      const resumenNode = [...document.querySelectorAll("p")]
        .find(p => normalize(p.textContent).includes("plan de cuotas disponible para"));
      const primeraCuota = [...document.querySelectorAll("p")]
        .find(p => normalize(p.textContent).includes("primera cuota vence"));

      return {
        planes,
        resumen: resumenNode ? resumenNode.textContent.trim() : null,
        primeraCuota: primeraCuota ? primeraCuota.textContent.trim() : null
      };
    });

    return {
      exito: Array.isArray(simulacion.planes) && simulacion.planes.length > 0,
      montoSolicitado: amountValue,
      planes: simulacion.planes || [],
      resumen: simulacion.resumen || null,
      primeraCuota: simulacion.primeraCuota || null
    };
  } catch (error) {
    console.warn("[Credicuotas] Error calculando planes:", error);
    return {
      exito: false,
      montoSolicitado: amountValue,
      planes: [],
      mensaje: "No se pudo calcular el plan de cuotas"
    };
  }
}

async function ensureSidebarMenu(page) {
  try {
    return await page.evaluate(() => {
      const normalize = str => (str || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase();

      const hasNuevaSolicitud = () => [...document.querySelectorAll("span, a, button")]
        .some(el => normalize(el.textContent).includes("nueva solicitud"));

      if (hasNuevaSolicitud()) {
        return true;
      }

      const toggles = [
        document.querySelector('button[aria-label*="menu"]'),
        document.querySelector('button[aria-label*="drawer"]'),
        document.querySelector('button[aria-label*="naveg"]'),
        document.querySelector('button[data-testid="MenuIcon"]'),
        document.querySelector('button[title*="Menú"]')
      ].filter(Boolean);

      toggles.forEach(btn => {
        btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      });

      return hasNuevaSolicitud();
    });
  } catch (error) {
    console.warn("[Credicuotas] No se pudo asegurar el menú lateral:", error);
    return false;
  }
}

async function clickNuevaSolicitudSidebar(page) {
  try {
    return await page.evaluate(() => {
      const normalize = str => (str || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase();

      const triggerClick = element => {
        if (!element) return false;
        element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        return true;
      };

      const span = [...document.querySelectorAll("span")]
        .find(el => normalize(el.textContent).includes("nueva solicitud"));
      const btn = span
        ? (span.closest('[role="button"]')
          || span.closest("button")
          || span.closest("li")
          || span)
        : null;
      if (triggerClick(btn)) {
        return true;
      }

      const fallbackButton = [...document.querySelectorAll("button,[role=\"button\"],a,div")]
        .find(el => normalize(el.textContent).includes("nueva solicitud"));
      return triggerClick(fallbackButton);
    });
  } catch (error) {
    console.warn("[Credicuotas] No se pudo clickear la opción del menú lateral:", error);
    return false;
  }
}

async function clickNuevaSolicitudCard(page) {
  try {
    return await page.evaluate(() => {
      const normalized = text => (text || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase();

      const triggerClick = element => {
        if (!element) return false;
        element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        return true;
      };

      const img = document.querySelector('img[alt="nueva solicitud"]');
      if (triggerClick(img)) {
        return true;
      }

      const card = [...document.querySelectorAll("button, [role=\"button\"], a, div")]
        .find(el => normalized(el.innerText).includes("nueva solicitud"));
      return triggerClick(card);
    });
  } catch (error) {
    console.warn("[Credicuotas] No se pudo clickear la tarjeta principal:", error);
    return false;
  }
}

async function dismissInstallAppPrompt(page) {
  const clickLaterButton = async () => {
    return await page.evaluate(() => {
      const normalize = str => (str || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase();

      const candidates = [...document.querySelectorAll("button, a, span")]
        .map(el => el.closest("button") || (el.tagName === "BUTTON" ? el : null))
        .filter(Boolean);

      const target = candidates.find(btn => normalize(btn.textContent).includes("en otro momento"));
      if (target) {
        target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        return true;
      }

      return false;
    });
  };

  let dismissed = false;
  for (let intento = 0; intento < 2; intento++) {
    if (page.url().includes("/instalar-app")) {
      const clicked = await clickLaterButton();
      if (clicked) {
        dismissed = true;
        await pause(1500);
        await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 8000 }).catch(() => {});
      } else {
        break;
      }
    } else if (!dismissed) {
      const clicked = await clickLaterButton();
      if (clicked) {
        dismissed = true;
        await pause(1200);
        await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 5000 }).catch(() => {});
      } else {
        break;
      }
    } else {
      break;
    }
  }

  return dismissed;
}

async function goToNuevaSolicitud(page) {
  const targetUrl = "https://ventas-comercios.credicuotas.com.ar/nueva-solicitud";

  const attemptDirect = async () => {
    try {
      await page.goto(targetUrl, { waitUntil: "networkidle2" });
      await pause(1500);
      await dismissInstallAppPrompt(page);
      return page.url().includes("/nueva-solicitud");
    } catch (error) {
      console.warn("[Credicuotas] Navegación directa a Nueva solicitud falló:", error);
      return false;
    }
  };

  if (await attemptDirect()) {
    return true;
  }

  console.log("[Credicuotas] Intentando navegación mediante UI…");
  const sidebarReady = await ensureSidebarMenu(page);
  if (sidebarReady) {
    const clickedSidebar = await clickNuevaSolicitudSidebar(page);
    if (clickedSidebar) {
      await pause(2500);
      await dismissInstallAppPrompt(page);
      if (page.url().includes("/nueva-solicitud")) {
        return true;
      }
    }
  }

  const clickedCard = await clickNuevaSolicitudCard(page);
  if (clickedCard) {
    await pause(2500);
    await dismissInstallAppPrompt(page);
    if (page.url().includes("/nueva-solicitud")) {
      return true;
    }
  }

  if (await attemptDirect()) {
    return true;
  }

  return false;
}

async function configurarFormularioInicial(page) {
  console.log("[Credicuotas] Configurando formulario inicial…");
  try {
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" })).catch(() => {});

    const selectEntries = [
      { label: "Producto", value: FORM_DEFAULTS.product || "MOTO" },
      { label: "Sub Producto", value: FORM_DEFAULTS.subproduct || "MOTOS" },
      { label: "Plazo de Pago", value: FORM_DEFAULTS.term || "4" },
      { label: "Género", value: resolveGenderValue(FORM_DEFAULTS.gender) || "M" }
    ];

    const results = {};
    for (const entry of selectEntries) {
      if (entry.label === "Sub Producto") {
        await pause(2000);
      }
      const ok = await selectMuiByLabel(page, entry.label, entry.value);
      results[entry.label] = ok;
      console.log(`[Credicuotas] ${entry.label} configurado: ${ok}`);
    }

    const pepValue = preferenceToRadioValue(FORM_DEFAULTS.pep, false);
    const obligatedValue = preferenceToRadioValue(FORM_DEFAULTS.obligated, false);

    await page.evaluate(({ pepValue, obligatedValue }) => {
      const setRadio = (name, value) => {
        const radio = document.querySelector(`input[name="${name}"][value="${value}"]`);
        if (radio && !radio.checked) {
          radio.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        }
      };

      setRadio("pep", pepValue);
      setRadio("so", obligatedValue);
    }, { pepValue, obligatedValue }).catch(() => {});

    for (const [label, ok] of Object.entries(results)) {
      console.log(`[Credicuotas] ${label} seleccionado: ${ok}`);
    }

    if (Object.values(results).some(ok => !ok)) {
      console.warn("[Credicuotas] Algún select no pudo configurarse mediante selección real.");
    }
  } catch (error) {
    console.warn("[Credicuotas] No se pudo configurar el formulario inicial:", error);
  }
}

function parseMontoToNumber(texto) {
  if (!texto) return null;
  const sanitized = texto
    .replace(/\s+/g, "")
    .replace(/[^\d,.\-]/g, "")
    .replace(/\./g, "");

  if (!sanitized || sanitized === "-" || sanitized === "") {
    return null;
  }

  const normalized = sanitized.replace(",", ".");
  const valor = parseFloat(normalized);
  return Number.isNaN(valor) ? null : valor;
}

async function consultarDNI(dni, montoSolicitado = null) {
  if (!dni) {
    throw new Error("Debe enviar un DNI");
  }

  const browser = await puppeteer.launch({
    headless: HEADLESS_MODE,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1680, height: 950, deviceScaleFactor: 1 });
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
  );

  try {
    console.log("[Credicuotas] Abriendo login…");
    await page.goto("https://ventas-comercios.credicuotas.com.ar/login", {
      waitUntil: "networkidle2",
    });

    console.log("[Credicuotas] Completando credenciales…");
    await page.waitForSelector('input[name="user"]');
    await page.type('input[name="user"]', USER, { delay: 70 });
    await page.type('input[name="pass"]', PASS, { delay: 70 });

    console.log("[Credicuotas] Iniciando sesión…");
    await page.evaluate(() => {
      const normalized = text => text
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase();

      const btn = [...document.querySelectorAll("button")]
        .find(b => normalized(b.innerText).includes("iniciar sesi"));
      if (btn) btn.click();
    });

    await pause(3000);

    console.log("[Credicuotas] Preparando acceso a 'Nueva solicitud'…");
    const accesoDirecto = await goToNuevaSolicitud(page);
    if (!accesoDirecto) {
      throw new Error("No se encontró la acción 'Nueva solicitud'");
    }

    await configurarFormularioInicial(page);

    console.log("[Credicuotas] Ingresando DNI…");
    await page.waitForSelector('input[name="customerId"]');
    await page.focus('input[name="customerId"]');
    await page.keyboard.down("Control").catch(() => {});
    await page.keyboard.press("a").catch(() => {});
    await page.keyboard.up("Control").catch(() => {});
    await page.click('input[name="customerId"]', { clickCount: 3 }).catch(() => {});
    await page.type('input[name="customerId"]', dni.toString(), { delay: 50 });
    await page.keyboard.press("Tab");
    await pause(3000);

    console.log("[Credicuotas] Verificando datos…");

    await page.waitForFunction(() => {
      const el = document.querySelector("#customer-select");
      const text = el ? (el.textContent || "").trim() : "";
      if (text && !/seleccion/i.test(text)) {
        return true;
      }
      const options = document.querySelectorAll('ul[role="listbox"] li');
      return options.length > 0;
    }, { timeout: 25000 }).catch(() => {});

    let persona = await page.evaluate(() => {
      const el = document.querySelector("#customer-select");
      return el ? el.textContent.trim() : null;
    });

    if (!persona || /seleccion/i.test(persona)) {
      await page.evaluate(() => {
        const select = document.querySelector("#customer-select");
        if (select) select.scrollIntoView({ block: "center" });
      }).catch(() => {});

      for (let intento = 0; intento < 3; intento++) {
        try {
          await page.click("#customer-select", { delay: 50 });
          await page.waitForSelector('ul[role="listbox"] li', {
            visible: true,
            timeout: 8000
          });
          await page.evaluate(() => {
            const options = document.querySelectorAll('ul[role="listbox"] li');
            if (options.length > 0) {
              options[0].dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
            }
          });
          await pause(1000);
        } catch (error) {
          await pause(500);
        }

        persona = await page.evaluate(() => {
          const el = document.querySelector("#customer-select");
          return el ? el.textContent.trim() : null;
        });

        if (persona && !/seleccion/i.test(persona)) {
          break;
        }
      }
    }

    if (!persona || /seleccion/i.test(persona)) {
      console.log(`[Credicuotas] DNI ${dni} no encontrado`);
      return { existe: false, dni };
    }

    console.log(`[Credicuotas] DNI ${dni} encontrado: ${persona}`);
    const opciones = await page.evaluate(() => {
      const lista = document.querySelectorAll('ul[role="listbox"] li');
      return Array.from(lista).map(li => li.innerText.trim());
    });

    console.log("[Credicuotas] Enviando formulario para obtener oferta…");
    const formularioEnviado = await page.evaluate(() => {
      const normalized = text => (text || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase();

      const btn = [...document.querySelectorAll("button")]
        .find(b => normalized(b.innerText).includes("continuar"));

      if (btn) {
        btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        return true;
      }

      return false;
    });

    if (formularioEnviado) {
      await pause(6000);
    } else {
      console.warn("[Credicuotas] Botón Continuar no disponible o ya fue presionado.");
    }

    console.log("[Credicuotas] Analizando oferta disponible… (puede demorar)");
    let oferta = {
      montoTexto: null,
      montoDisponible: null,
      estado: null,
      motivo: null
    };
    let simulacion = null;

    try {
      await page.waitForFunction(() => {
        const normalize = text => (text || "")
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .toLowerCase();

        const textos = [...document.querySelectorAll("p, div, span")];
        const tieneMonto = textos
          .some(el => normalize(el.textContent).includes("monto total disponible"));
        const alert = document.querySelector('[role="alert"] .MuiAlert-message');
        return tieneMonto || !!alert;
      }, { timeout: 60000 }).catch(() => null);

      const rawOferta = await page.evaluate(() => {
        const normalize = text => (text || "")
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .toLowerCase();

        const amountNode = [...document.querySelectorAll("p")]
          .find(p => normalize(p.textContent).includes("monto total disponible"));
        let montoTexto = null;
        if (amountNode) {
          const span = amountNode.querySelector("span");
          if (span) {
            montoTexto = span.textContent.trim();
          }
        }

        const alertMessage = document.querySelector('[role="alert"] .MuiAlert-message');
        let estado = null;
        let motivo = null;

        if (alertMessage) {
          const childTexts = [...alertMessage.children]
            .map(el => el.textContent.trim())
            .filter(Boolean);

          if (childTexts.length) {
            [estado, ...motivo] = childTexts;
            motivo = motivo.join(" ").trim() || null;
          } else {
            const parts = alertMessage.textContent
              .split("\n")
              .map(str => str.trim())
              .filter(Boolean);
            if (parts.length) {
              estado = parts.shift();
              motivo = parts.join(" ").trim() || null;
            }
          }
        }

        return {
          montoTexto: montoTexto || null,
          estado: estado || null,
          motivo: motivo || null
        };
      });

      if (rawOferta) {
        const montoDisponible = parseMontoToNumber(rawOferta.montoTexto || "");
        const aprobado = typeof montoDisponible === "number" && montoDisponible > 0;
        let estado = rawOferta.estado || null;
        let motivo = rawOferta.motivo || null;

        if (!estado) {
          estado = aprobado ? "Aprobado" : "Sin oferta disponible";
        }
        if (!motivo) {
          motivo = aprobado ? "Oferta disponible" : "El cliente no posee cupo vigente";
        }

        oferta = {
          montoTexto: rawOferta.montoTexto || null,
          montoDisponible,
          estado,
          motivo,
          aprobado
        };
      }
    } catch (error) {
      console.warn("[Credicuotas] No se pudo obtener el detalle de oferta:", error);
    }

    if (montoSolicitado) {
      if (!oferta.aprobado) {
        simulacion = {
          exito: false,
          montoSolicitado,
          planes: [],
          mensaje: "No hay oferta aprobada para simular la financiación"
        };
      } else if (oferta.montoDisponible && montoSolicitado > oferta.montoDisponible) {
        simulacion = {
          exito: false,
          montoSolicitado,
          planes: [],
          mensaje: "El monto solicitado supera el monto disponible"
        };
      } else {
        simulacion = await calcularPlanCuotas(page, montoSolicitado);
      }
    }

    console.log(`[Credicuotas] Análisis finalizado para DNI ${dni}: ${oferta.estado || "Sin estado"}`);

    return {
      existe: true,
      dni,
      persona,
      opciones,
      oferta,
      simulacion
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

async function responderConsulta(res, dni, monto) {
  if (!dni || !/^[0-9]{7,8}$/.test(dni.toString())) {
    return res.status(400).json({ error: "Debe enviar un DNI válido" });
  }

  try {
    const montoSolicitado = sanitizeAmountInput(monto);
    const resultado = await consultarDNI(dni, montoSolicitado);
    return res.json(resultado);
  } catch (error) {
    console.error("[Credicuotas] Error consultando DNI:", error);
    return res.status(500).json({ error: "No se pudo consultar el DNI" });
  }
}

app.post("/api/credicuotas/dni", async (req, res) => {
  const { dni, monto } = req.body || {};
  await responderConsulta(res, dni, monto);
});

app.get("/api/credicuotas/dni/:dni", async (req, res) => {
  const { dni } = req.params;
  await responderConsulta(res, dni, null);
});

app.get("/api/credicuotas/dni/:dni/monto/:monto", async (req, res) => {
  const { dni, monto } = req.params;
  await responderConsulta(res, dni, monto);
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`API Credicuotas escuchando en http://localhost:${PORT}`);
  });
}

module.exports = {
  app,
  consultarDNI
};
