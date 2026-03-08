import express from "express";
import fetch from "node-fetch";
import fs from "fs";
import crypto from "crypto";

const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const BOT_USERNAME = (process.env.BOT_USERNAME || "").replace("@", "").trim();

// ✅ NUEVO: URL de su página con publicidad (Hostinger)
const AD_LANDING_URL = String(process.env.AD_LANDING_URL || "").trim();

// precios / texto
const VIP_PRICE_STARS = String(process.env.VIP_PRICE_STARS || "500"); // 500 Stars = 30 días
const VIP_STARS_AMOUNT = Math.floor(Number(process.env.VIP_PRICE_STARS || "500")); // número fijo para comparaciones
const VIP_PRICE_USDT = String(process.env.VIP_PRICE_USDT || "5");
const VIP_PAY_USDT_TEXT = String(
  process.env.VIP_PAY_USDT_TEXT ||
    "Metodo: USDT\nRed: TRC20\nDireccion: TU_DIRECCION\n\nLuego toque Ya pague"
);

const ADMIN_ID = Number(process.env.ADMIN_ID);
const VIP_CHAT_ID = Number(process.env.VIP_CHAT_ID);
const TEMP_CHAT_ID = Number(process.env.TEMP_CHAT_ID);
const HUB_CHAT_ID = process.env.HUB_CHAT_ID ? Number(process.env.HUB_CHAT_ID) : null;

const WEBHOOK_URL = process.env.WEBHOOK_URL;
const PORT = process.env.PORT || 3000;

// Admin Telegram username y link
const ADMIN_USERNAME = "@Adm_archivo2";
const ADMIN_LINK = "https://t.me/Adm_archivo2";

// Estado en memoria: usuarios esperando enviar comprobante
// { userId: { method: "usdt"|"transfer", timestamp: Date.now() } }
const pendingProof = {};

if (!BOT_TOKEN || !ADMIN_ID || !VIP_CHAT_ID || !TEMP_CHAT_ID) {
  console.error("FALTAN VARIABLES DE ENTORNO: BOT_TOKEN, ADMIN_ID, VIP_CHAT_ID, TEMP_CHAT_ID");
  process.exit(1);
}

const API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const DB_FILE = "./db.json";

/**
 * ✅ loadDB cura db.json incompleto
 * ✅ EXTRA: hubPinnedMessageId para editar post fijo
 * ✅ NUEVO: gateCodes para obligar pasar por publicidad antes del link temporal
 */
function loadDB() {
  let db = {};
  let changed = false;

  try {
    db = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
    if (!db || typeof db !== "object") {
      db = {};
      changed = true;
    }
  } catch {
    db = {};
    changed = true;
  }

  if (!db.vipMembers || typeof db.vipMembers !== "object") {
    db.vipMembers = {};
    changed = true;
  }

  if (!db.temp || typeof db.temp !== "object") {
    db.temp = { openUntil: 0, inviteLink: "", postedMessageIds: [] };
    changed = true;
  }
  if (typeof db.temp.openUntil !== "number") {
    db.temp.openUntil = 0;
    changed = true;
  }
  if (typeof db.temp.inviteLink !== "string") {
    db.temp.inviteLink = "";
    changed = true;
  }
  if (!Array.isArray(db.temp.postedMessageIds)) {
    db.temp.postedMessageIds = [];
    changed = true;
  }

  if (!db.paidStars || typeof db.paidStars !== "object") {
    db.paidStars = {};
    changed = true;
  }

  if (!db.lastVipLink || typeof db.lastVipLink !== "object") {
    db.lastVipLink = {};
    changed = true;
  }

  if (typeof db.hubPinnedMessageId !== "number") {
    db.hubPinnedMessageId = 0;
    changed = true;
  }

  // ✅ NUEVO: códigos para acceso temporal (uno solo uso)
  if (!db.gateCodes || typeof db.gateCodes !== "object") {
    db.gateCodes = {};
    changed = true;
  }

  // ✅ NUEVO: registro de avisos de renovación ya enviados
  if (!db.renewalNotified || typeof db.renewalNotified !== "object") {
    db.renewalNotified = {};
    changed = true;
  }

  if (changed) {
    try {
      fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
    } catch {}
  }

  return db;
}

function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

async function tg(method, body) {
  const res = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`${method} ERROR: ${JSON.stringify(data)}`);
  return data.result;
}

function isAdmin(userId) {
  return Number(userId) === ADMIN_ID;
}

async function send(chatId, text, extra = {}) {
  return tg("sendMessage", { chat_id: chatId, text, ...extra });
}

async function notifyAdmin(text) {
  try {
    await send(ADMIN_ID, text);
  } catch {}
}

function vipMenuMarkup(includeBack = false) {
  const rows = [
    [{ text: `⭐ Pagar con Stars (${VIP_PRICE_STARS})`, callback_data: "vip_stars" }],
    [{ text: `💵 Pagar con USDT ($${VIP_PRICE_USDT})`, callback_data: "vip_usdt" }],
    [{ text: "🇪🇨 Transferencia Bancaria (solo Ecuador)", callback_data: "vip_transfer_ec" }],
    [{ text: "✅ Ya pague", callback_data: "vip_yapague" }]
  ];
  if (includeBack) rows.push([{ text: "Volver", callback_data: "back_home" }]);
  return { reply_markup: { inline_keyboard: rows } };
}

/** STARS: manda invoice (XTR) */
async function sendStarsInvoice(chatId, userId) {
  const amountStars = VIP_STARS_AMOUNT; // siempre 500, definido al arrancar

  const payload = `vip30_${userId}_${Date.now()}`;

  await notifyAdmin(
    `Invoice Stars enviado ✅\nUser: ${userId}\nChat: ${chatId}\nMonto: ${amountStars} XTR\nPayload:\n${payload}`
  );

  return tg("sendInvoice", {
    chat_id: chatId,
    title: "VIP 30 dias",
    description: "Acceso VIP por 30 dias (renovable).",
    payload,
    currency: "XTR",
    prices: [{ label: "VIP 30 dias", amount: amountStars }]
  });
}

async function createInviteLink(chatId, seconds, memberLimit = null) {
  const expireDate = Math.floor(Date.now() / 1000) + seconds;
  const payload = { chat_id: chatId, expire_date: expireDate };
  if (memberLimit !== null) payload.member_limit = memberLimit;
  return tg("createChatInviteLink", payload);
}

async function revokeInvite(chatId, inviteLink) {
  return tg("revokeChatInviteLink", { chat_id: chatId, invite_link: inviteLink });
}

// ban + unban
async function kickUser(chatId, userId) {
  await tg("banChatMember", { chat_id: chatId, user_id: userId });
  await tg("unbanChatMember", { chat_id: chatId, user_id: userId });
}

/**
 * ✅ NUEVO: generar codigo de acceso temporal (expira rápido y 1 uso)
 */
function createGateCode() {
  return crypto.randomBytes(8).toString("hex"); // 16 chars
}

function addGateCode(ttlSeconds = 10 * 60) {
  const db = loadDB();
  const code = createGateCode();
  db.gateCodes[code] = { expiresAt: Date.now() + ttlSeconds * 1000, used: false };
  saveDB(db);
  return code;
}

function consumeGateCode(code) {
  const db = loadDB();
  const item = db.gateCodes[code];
  if (!item) return { ok: false, reason: "code_no_existe" };
  if (item.used) return { ok: false, reason: "code_usado" };
  if (item.expiresAt <= Date.now()) return { ok: false, reason: "code_expirado" };

  item.used = true;
  db.gateCodes[code] = item;
  saveDB(db);
  return { ok: true };
}

// limpia códigos viejos
function cleanupGateCodes() {
  const db = loadDB();
  const now = Date.now();
  let changed = false;

  for (const [code, v] of Object.entries(db.gateCodes || {})) {
    if (!v || typeof v !== "object") {
      delete db.gateCodes[code];
      changed = true;
      continue;
    }
    if (v.expiresAt <= now || v.used === true) {
      // borro usados y expirados para no crecer db
      delete db.gateCodes[code];
      changed = true;
    }
  }

  if (changed) saveDB(db);
}

/**
 * TEMPORAL: el bot publica y luego borra
 */
async function openTemporal(hours) {
  const db = loadDB();
  const seconds = Math.max(1, Math.floor(hours * 3600));

  const linkObj = await createInviteLink(TEMP_CHAT_ID, seconds);
  const openUntil = Date.now() + seconds * 1000;

  db.temp.openUntil = openUntil;
  db.temp.inviteLink = linkObj.invite_link;
  db.temp.postedMessageIds = [];
  saveDB(db);

  const m1 = await tg("sendMessage", { chat_id: TEMP_CHAT_ID, text: "Canal TEMPORAL abierto por tiempo limitado" });
  const m2 = await tg("sendMessage", { chat_id: TEMP_CHAT_ID, text: "Muestra 1 (aqui luego pondremos su contenido)" });
  const m3 = await tg("sendMessage", { chat_id: TEMP_CHAT_ID, text: "Para VIP escriba al bot: /vip" });

  db.temp.postedMessageIds = [m1.message_id, m2.message_id, m3.message_id];
  saveDB(db);

  return { inviteLink: linkObj.invite_link, openUntil };
}

async function closeTemporal() {
  const db = loadDB();

  if (db.temp.inviteLink) {
    try { await revokeInvite(TEMP_CHAT_ID, db.temp.inviteLink); } catch {}
  }

  for (const mid of db.temp.postedMessageIds || []) {
    try { await tg("deleteMessage", { chat_id: TEMP_CHAT_ID, message_id: mid }); } catch {}
  }

  db.temp = { openUntil: 0, inviteLink: "", postedMessageIds: [] };
  saveDB(db);

  return true;
}

/**
 * VIP: aprobar con días acumulables
 */
async function approveVip(userId, days) {
  const db = loadDB();
  const now = Date.now();
  const addMs = days * 24 * 60 * 60 * 1000;

  const current = db.vipMembers[String(userId)]?.expiresAt || 0;
  const base = current > now ? current : now;
  const expiresAt = base + addMs;

  db.vipMembers[String(userId)] = { expiresAt };
  saveDB(db);

  const linkObj = await createInviteLink(VIP_CHAT_ID, 10 * 60, 1);

  db.lastVipLink[String(userId)] = { inviteLink: linkObj.invite_link, createdAt: Date.now() };
  saveDB(db);

  return { inviteLink: linkObj.invite_link, expiresAt };
}

async function checkVipExpirations() {
  const db = loadDB();
  const now = Date.now();
  const entries = Object.entries(db.vipMembers);

  for (const [userIdStr, info] of entries) {
    if (info.expiresAt && info.expiresAt <= now) {
      const userId = Number(userIdStr);
      try { await kickUser(VIP_CHAT_ID, userId); } catch {}
      delete db.vipMembers[userIdStr];
    }
  }
  saveDB(db);
}

function fmtMs(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  return `${h}h ${m}m`;
}

/** CALLBACKS */
async function handleCallbackQuery(cb) {
  const chatId = cb.message?.chat?.id;
  const userId = cb.from?.id;
  const data = cb.data || "";

  try { await tg("answerCallbackQuery", { callback_query_id: cb.id }); } catch {}
  if (!chatId || !userId) return;

  if (data === "vip_stars") {
    await send(chatId, "⭐ Pago con Stars\n\nSe abrira el pago aqui mismo, complete el pago y se activara automaticamente.");
    return sendStarsInvoice(chatId, userId);
  }

  if (data === "vip_usdt") {
    pendingProof[userId] = { method: "usdt", timestamp: Date.now() };
    return send(
      chatId,
      `💵 Pago con USDT\n\nPrecio: ${VIP_PRICE_USDT} USDT\n\n${VIP_PAY_USDT_TEXT}\n\n` +
      `━━━━━━━━━━━━━━━\n` +
      `📸 Una vez pagado:\n` +
      `Tome una captura de pantalla del comprobante y enviela AQUI en este chat\n\n` +
      `👉 Toque el icono 📎 (clip) y seleccione la foto del comprobante\n\n` +
      `Sin foto no podemos activar su VIP.`,
      { reply_markup: { inline_keyboard: [[{ text: "❌ Cancelar", callback_data: "back_home" }]] } }
    );
  }

  if (data === "vip_transfer_ec") {
    pendingProof[userId] = { method: "transfer", timestamp: Date.now() };
    return send(
      chatId,
      `🇪🇨 Transferencia Bancaria — Solo Ecuador\n\n` +
      `El acceso al Canal VIP tiene un costo de $6.00 USD.\n\n` +
      `Para obtener los datos bancarios y realizar el pago, comuniquese con el administrador:\n\n` +
      `👤 ${ADMIN_USERNAME}\n\n` +
      `━━━━━━━━━━━━━━━\n` +
      `📸 Una vez que haya pagado:\n` +
      `Tome una captura de pantalla del comprobante de transferencia y enviela AQUI en este chat\n\n` +
      `👉 Toque el icono 📎 (clip) y seleccione la foto del comprobante\n\n` +
      `Sin foto no activamos el VIP.`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "💬 Contactar Administrador", url: ADMIN_LINK }],
            [{ text: "❌ Cancelar", callback_data: "back_home" }]
          ]
        }
      }
    );
  }

  if (data === "vip_yapague") {
    if (!pendingProof[userId]) {
      return send(
        chatId,
        "Por favor elija primero el metodo de pago (USDT o Transferencia Ecuador) y realize el pago antes de reportar.",
        vipMenuMarkup(true)
      );
    }
    return send(
      chatId,
      `📸 Envie aqui la foto del comprobante\n\n` +
      `👉 Toque el icono 📎 (clip) abajo\n` +
      `👉 Seleccione "Galeria" o "Archivo"\n` +
      `👉 Elija la captura de pantalla del pago\n\n` +
      `En cuanto la recibamos activamos su VIP.`,
      { reply_markup: { inline_keyboard: [[{ text: "❌ Cancelar", callback_data: "back_home" }]] } }
    );
  }

  if (data === "back_home") {
    return send(chatId, "Bienvenido\n\nOpciones:\n/temporal (ver estado)\n/vip (info VIP)\n/mi_vip (reenvia link si ya tiene VIP)\n\nSi ya pago: /ya_pague");
  }
}

/** PRE-CHECKOUT (Stars) */
async function handlePreCheckoutQuery(q) {
  const expected = VIP_STARS_AMOUNT; // siempre 500, igual al invoice

  const ok =
    q.currency === "XTR" &&
    Number(q.total_amount) === expected &&
    typeof q.invoice_payload === "string" &&
    q.invoice_payload.startsWith("vip30_");

  // ✅ CRITICO: responder PRIMERO antes de cualquier otra cosa
  // Telegram exige respuesta en menos de 10 segundos o cancela el pago
  const payload = { pre_checkout_query_id: q.id, ok: !!ok };
  if (!ok) payload.error_message = "Pago invalido, intente de nuevo.";

  try {
    await tg("answerPreCheckoutQuery", payload);
  } catch (e) {
    await notifyAdmin(`❌ ERROR answerPreCheckoutQuery: ${e?.message || e}`);
    return;
  }

  // Notificar al admin DESPUÉS de responder (no bloquea el pago)
  await notifyAdmin(
    `${ok ? "PreCheckout Stars OK ✅" : "PreCheckout Stars FAIL ❌"}\nUser: ${q.from?.id}\nMonto: ${q.total_amount} ${q.currency}\nExpected: ${expected}\nPayload:\n${q.invoice_payload}`
  ).catch(() => {});
}

/** SUCCESSFUL PAYMENT (Stars) -> auto aprueba VIP */
async function handleSuccessfulPayment(msg) {
  const userId = msg.from?.id;
  const chatId = msg.chat?.id;
  const sp = msg.successful_payment;
  if (!userId || !chatId || !sp) return;

  const expected = VIP_STARS_AMOUNT; // siempre 500, igual al invoice

  await notifyAdmin(
    `SuccessfulPayment recibido ✅\nUser: ${userId}\nMonto: ${sp.total_amount} ${sp.currency}\nCharge: ${sp.telegram_payment_charge_id}\nPayload:\n${sp.invoice_payload}`
  );

  if (sp.currency !== "XTR" || Number(sp.total_amount) !== expected) {
    await notifyAdmin("⚠️ Ignorado: currency/monto no coincide con VIP_PRICE_STARS");
    return;
  }
  if (!sp.invoice_payload || !String(sp.invoice_payload).startsWith("vip30_")) {
    await notifyAdmin("⚠️ Ignorado: payload no coincide");
    return;
  }

  const db = loadDB();
  const chargeId = sp.telegram_payment_charge_id || "";

  if (chargeId && db.paidStars[chargeId]) {
    await notifyAdmin("⚠️ Ignorado: pago duplicado (charge ya procesado)");
    return;
  }

  if (chargeId) {
    db.paidStars[chargeId] = true;
    saveDB(db);
  }

  try {
    const { inviteLink, expiresAt } = await approveVip(userId, 30);

    await send(
      chatId,
      `Pago recibido ✅\nVIP activado 30 dias\n\nLink personal (10 min): ${inviteLink}\n\nSi se le vence el link, escriba /mi_vip`
    );

    await notifyAdmin(
      `VIP activado ✅\nUser: ${userId}\nVence: ${new Date(expiresAt).toLocaleString()}\nLink:\n${inviteLink}`
    );
  } catch (e) {
    await notifyAdmin(`❌ ERROR activando VIP\nUser: ${userId}\nError: ${e?.message || e}`);
    try {
      await send(chatId, "Pago recibido ✅\nPero hubo un error activando el VIP\nEscriba /mi_vip en 1 minuto\nSi no sale, escriba /ya_pague");
    } catch {}
  }
}

/**
 * botones pro para /start (estetico)
 * ✅ CAMBIO: el botón TEMPORAL ahora manda a su web con ads (AD_LANDING_URL)
 */
function startMenuMarkup() {
  if (!BOT_USERNAME) return {};
  const base = `https://t.me/${BOT_USERNAME}`;
  const temporalUrl = AD_LANDING_URL ? AD_LANDING_URL : `${base}?start=temporal`;

  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "🔥 Ver canal TEMPORAL", url: temporalUrl },
          { text: "🔒 Acceso VIP 30 dias", url: `${base}?start=vip` }
        ],
        [
          { text: "📌 Info VIP", url: `${base}?start=info` },
          { text: "✅ Mi VIP (reenviar link)", url: `${base}?start=mivip` }
        ],
        [{ text: "💬 Ya pague (USDT)", url: `${base}?start=yapague` }]
      ]
    }
  };
}

function startWelcomeText() {
  return (
    "📁 Archivo Curioso 2.0\n" +
    "Bienvenido\n\n" +
    "Aqui el contenido esta archivado para el deleite de tus ojos\n" +
    "Todo se maneja por accesos\n\n" +
    "🔥 CANAL TEMPORAL\n" +
    "Se abre por tiempo limitado y de forma aleatoria\n" +
    "Normalmente abre unas 2 horas\n" +
    "Lo que vea ahi es una muestra\n" +
    "Cuando se cumple el tiempo el contenido se borra automaticamente\n\n" +
    "🔒 CANAL VIP\n" +
    "Esta abierto 24/7\n" +
    "El contenido no se borra queda archivado completo\n\n" +
    "Elija una opcion aqui abajo"
  );
}

/**
 * ✅ crea/edita POST FIJO en HUB y lo fija
 * ✅ CAMBIO: en vez de soltar link directo, manda AD_LANDING_URL
 */
async function upsertHubPinnedPost() {
  if (!HUB_CHAT_ID) throw new Error("HUB_CHAT_ID no configurado");
  if (!BOT_USERNAME) throw new Error("BOT_USERNAME no configurado");

  const db = loadDB();
  const botBase = `https://t.me/${BOT_USERNAME}`;
  const temporalUrl = AD_LANDING_URL ? AD_LANDING_URL : `${botBase}?start=temporal`;

  const texto =
    "📁 Archivo Curioso 2.0\n\n" +
    "🔥 Canal TEMPORAL\n" +
    "Se abre por tiempo limitado con muestras\n" +
    "Para entrar pase por el acceso aqui abajo\n\n" +
    "🔒 Canal VIP\n" +
    "Acceso 24/7\n\n" +
    "Elija una opcion abajo";

  const markup = {
    reply_markup: {
      inline_keyboard: [
        [{ text: "🔥 Entrar al TEMPORAL", url: temporalUrl }],
        [{ text: "🔒 Desbloquear VIP 30 dias", url: `${botBase}?start=vip` }],
        [{ text: "✅ Mi VIP (reenviar link)", url: `${botBase}?start=mivip` }]
      ]
    }
  };

  if (db.hubPinnedMessageId && db.hubPinnedMessageId > 0) {
    try {
      await tg("editMessageText", {
        chat_id: HUB_CHAT_ID,
        message_id: db.hubPinnedMessageId,
        text: texto,
        ...markup
      });

      try {
        await tg("pinChatMessage", {
          chat_id: HUB_CHAT_ID,
          message_id: db.hubPinnedMessageId,
          disable_notification: true
        });
      } catch {}

      return { mode: "edited", messageId: db.hubPinnedMessageId };
    } catch {
      db.hubPinnedMessageId = 0;
      saveDB(db);
    }
  }

  const msg = await tg("sendMessage", {
    chat_id: HUB_CHAT_ID,
    text: texto,
    ...markup
  });

  db.hubPinnedMessageId = msg.message_id;
  saveDB(db);

  await tg("pinChatMessage", {
    chat_id: HUB_CHAT_ID,
    message_id: msg.message_id,
    disable_notification: true
  });

  return { mode: "sent", messageId: msg.message_id };
}

/**
 * COMANDOS
 */
async function handleMessage(msg) {
  const chatId = msg.chat?.id;
  const userId = msg.from?.id;
  const text = (msg.text || "").trim();
  if (!chatId || !userId) return;

  if (msg.successful_payment) {
    return handleSuccessfulPayment(msg).catch(async (e) => {
      await notifyAdmin(`❌ ERROR handleSuccessfulPayment: ${e?.message || e}`);
    });
  }

  // ✅ NUEVO: comprobante de pago (foto)
  if (msg.photo && msg.photo.length > 0) {
    const proof = pendingProof[userId];
    if (proof) {
      // limpiar estado pendiente
      delete pendingProof[userId];

      const methodLabel = proof.method === "transfer" ? "Transferencia Ecuador ($6)" : `USDT ($${VIP_PRICE_USDT})`;
      const fileId = msg.photo[msg.photo.length - 1].file_id;

      // reenviar foto al admin con info
      await tg("sendPhoto", {
        chat_id: ADMIN_ID,
        photo: fileId,
        caption:
          `📸 Comprobante de pago recibido\n` +
          `User: ${userId}\nChat: ${chatId}\n` +
          `Metodo: ${methodLabel}\n\n` +
          `Si el pago es valido use:\n/aprobar ${userId} 30`
      });

      return send(
        chatId,
        "✅ Comprobante recibido\n\nEl administrador lo revisara y activara su VIP en breve.\n\nSi tiene alguna duda contacte a " + ADMIN_USERNAME
      );
    }
    // foto sin contexto: ignorar silenciosamente
    return;
  }

  if (text.startsWith("/start")) {
    const parts = text.split(/\s+/);
    const arg = (parts[1] || "").toLowerCase();

    // ✅ NUEVO: si vienen desde /go-temporal con un code
    if (arg.startsWith("gate_")) {
      const code = arg.replace("gate_", "").trim();

      const r = consumeGateCode(code);
      if (!r.ok) {
        return send(chatId, "Acceso invalido o vencido\nVuelva a entrar desde el enlace del canal");
      }

      const db = loadDB();
      if (db.temp.openUntil && db.temp.openUntil > Date.now()) {
        return send(
          chatId,
          "🔥 TEMPORAL ABIERTO\n\nAqui su acceso:\n" +
            db.temp.inviteLink +
            "\n\nCierra en: " +
            fmtMs(db.temp.openUntil - Date.now()),
          startMenuMarkup()
        );
      }

      return send(chatId, "🔥 TEMPORAL CERRADO\nVuelva mas tarde", startMenuMarkup());
    }

    if (arg === "vip") {
      return send(chatId, "🔒 VIP 30 dias\n\nElija un metodo de pago:", vipMenuMarkup(false));
    }

    // ✅ CAMBIO: /start temporal YA NO da link, manda a publicidad
    if (arg === "temporal") {
      if (!AD_LANDING_URL) {
        return send(
          chatId,
          "Temporal disponible solo desde el enlace del canal\n(AD_LANDING_URL no configurado)",
          startMenuMarkup()
        );
      }
      return send(
        chatId,
        "🔥 Para entrar al TEMPORAL primero pase por el acceso aqui:\n" + AD_LANDING_URL + "\n\nLuego toque el boton ENTRAR en esa pagina",
        startMenuMarkup()
      );
    }

    if (arg === "info") {
      return send(
        chatId,
        "📌 INFO VIP\n\n" +
          "VIP esta abierto 24/7\n" +
          "Contenido completo sin borrarse\n\n" +
          "Para comprar toque VIP y pague con Stars o USDT",
        startMenuMarkup()
      );
    }

    if (arg === "mivip") {
      const db = loadDB();
      const info = db.vipMembers[String(userId)];
      if (!info || !info.expiresAt || info.expiresAt <= Date.now()) {
        return send(
          chatId,
          "Usted no tiene VIP activo\nSi ya pago toque Ya pague (USDT) o escriba /ya_pague",
          startMenuMarkup()
        );
      }
      try {
        const linkObj = await createInviteLink(VIP_CHAT_ID, 10 * 60, 1);
        db.lastVipLink[String(userId)] = { inviteLink: linkObj.invite_link, createdAt: Date.now() };
        saveDB(db);
        return send(
          chatId,
          "✅ VIP activo\n\nAqui su link personal (10 min):\n" + linkObj.invite_link,
          startMenuMarkup()
        );
      } catch (e) {
        await notifyAdmin(`❌ ERROR start=mivip creando link\nUser: ${userId}\nError: ${e?.message || e}`);
        return send(
          chatId,
          "✅ VIP activo\nPero no pude crear el link ahora\nEscriba /ya_pague para que el admin le mande el link",
          startMenuMarkup()
        );
      }
    }

    if (arg === "yapague") {
      await send(ADMIN_ID, `Pago reportado\nUser: ${userId}\nChat: ${chatId}\nUse: /aprobar ${userId} 30`);
      return send(chatId, "Listo ya avise al administrador\napenas apruebe le llegara su link VIP", startMenuMarkup());
    }

    if (!BOT_USERNAME) {
      return send(
        chatId,
        startWelcomeText() + "\n\n⚠️ Falta BOT_USERNAME en Render para mostrar botones\nPor ahora use /vip o /temporal",
        {}
      );
    }
    return send(chatId, startWelcomeText(), startMenuMarkup());
      }
  if (!text.startsWith("/")) return;

  if (text === "/vip") {
    return send(chatId, "🔒 VIP 30 dias\n\nElija un metodo de pago:", vipMenuMarkup(true));
  }

  if (text === "/mi_vip") {
    const db = loadDB();
    const info = db.vipMembers[String(userId)];
    if (!info || !info.expiresAt || info.expiresAt <= Date.now()) {
      return send(chatId, "Usted no tiene VIP activo\nSi ya pago, escriba /ya_pague");
    }
    try {
      const linkObj = await createInviteLink(VIP_CHAT_ID, 10 * 60, 1);
      db.lastVipLink[String(userId)] = { inviteLink: linkObj.invite_link, createdAt: Date.now() };
      saveDB(db);
      return send(chatId, `VIP activo ✅\nAqui su link personal (10 min): ${linkObj.invite_link}`);
    } catch (e) {
      await notifyAdmin(`❌ ERROR /mi_vip creando link\nUser: ${userId}\nError: ${e?.message || e}`);
      return send(chatId, "VIP activo ✅\nPero no pude crear el link ahora\nEscriba /ya_pague para que el admin le mande el link");
    }
  }

  if (text === "/ya_pague") {
    await send(ADMIN_ID, `Pago reportado\nUser: ${userId}\nChat: ${chatId}\nUse: /aprobar ${userId} 30`);
    return send(chatId, "Listo ya avise al administrador\napenas apruebe le llegara su link VIP");
  }

  // ✅ CAMBIO: /temporal ahora manda a la web con ads (no suelta el link directo)
  if (text === "/temporal") {
    const db = loadDB();
    if (!db.temp.openUntil || db.temp.openUntil <= Date.now()) {
      return send(chatId, "Temporal CERRADO\nVuelva mas tarde");
    }
    if (!AD_LANDING_URL) {
      return send(chatId, "Temporal ABIERTO\nPero falta AD_LANDING_URL en Render");
    }
    return send(chatId, "Temporal ABIERTO ✅\n\nPara entrar pase por:\n" + AD_LANDING_URL + "\n\ny toque ENTRAR en esa pagina");
  }

  if (text === "/post_fijo") {
    if (!isAdmin(userId)) return send(chatId, "No autorizado");
    if (!HUB_CHAT_ID) return send(chatId, "HUB_CHAT_ID no configurado en Render");
    if (!BOT_USERNAME) return send(chatId, "BOT_USERNAME no configurado en Render");

    try {
      const r = await upsertHubPinnedPost();
      return send(chatId, `Post fijo listo ✅\nModo: ${r.mode}\nMessage ID: ${r.messageId}`);
    } catch (e) {
      return send(
        chatId,
        "Post no se pudo fijar ❌\n" +
          "Revise: bot admin del canal + permiso de fijar\n" +
          "Error: " +
          (e?.message || e)
      );
    }
  }

  if (text.startsWith("/abrir_temporal")) {
    if (!isAdmin(userId)) return send(chatId, "No autorizado");
    const parts = text.split(/\s+/);
    const raw = parts[1] || "2h";
    let hours = 2;

    if (raw.endsWith("h")) hours = Number(raw.replace("h", ""));
    else if (raw.endsWith("m")) hours = Number(raw.replace("m", "")) / 60;
    else hours = Number(raw);

    if (!Number.isFinite(hours) || hours <= 0) hours = 2;

    await openTemporal(hours);

    // ✅ CAMBIO: avisar en HUB con link a publicidad, NO link directo
    if (HUB_CHAT_ID) {
      if (AD_LANDING_URL) {
        await send(
          HUB_CHAT_ID,
          "🔥 TEMPORAL ABIERTO por " + hours + "h\n\nPara entrar toque abajo (pasa por acceso):",
          { reply_markup: { inline_keyboard: [[{ text: "Entrar al TEMPORAL 🔥", url: AD_LANDING_URL }]] } }
        );
      } else {
        // fallback (si no configuro AD_LANDING_URL)
        const botUrl = BOT_USERNAME ? `https://t.me/${BOT_USERNAME}?start=temporal` : null;
        if (botUrl) {
          await send(
            HUB_CHAT_ID,
            "🔥 TEMPORAL ABIERTO por " + hours + "h\n\nToque aqui:",
            { reply_markup: { inline_keyboard: [[{ text: "Ver TEMPORAL", url: botUrl }]] } }
          );
        } else {
          await send(HUB_CHAT_ID, "🔥 TEMPORAL ABIERTO por " + hours + "h\n\nEscriba /temporal al bot");
        }
      }
    }

    return send(chatId, "Temporal ABIERTO ✅\nDuracion: " + hours + "h\n(En el HUB ya se aviso con el acceso)");
  }

  if (text === "/cerrar_temporal") {
    if (!isAdmin(userId)) return send(chatId, "No autorizado");
    await closeTemporal();
    return send(chatId, "Temporal cerrado y contenido borrado");
  }

  if (text.startsWith("/aprobar")) {
    if (!isAdmin(userId)) return send(chatId, "No autorizado");
    const parts = text.split(/\s+/);
    const targetId = Number(parts[1]);
    const days = Number(parts[2] || 30);
    if (!targetId || !Number.isFinite(days) || days <= 0) {
      return send(chatId, "Uso: /aprobar USER_ID 30");
    }

    const { inviteLink, expiresAt } = await approveVip(targetId, days);

    await send(targetId, `VIP aprobado por ${days} dias\nLink personal (10 min): ${inviteLink}\n\nSi se le vence, escriba /mi_vip`);
    return send(chatId, `Aprobado ${targetId}\nVence: ${new Date(expiresAt).toLocaleString()}`);
  }

  if (text.startsWith("/estado_vip")) {
    if (!isAdmin(userId)) return send(chatId, "No autorizado");
    const parts = text.split(/\s+/);
    const targetId = String(parts[1] || "");
    const db = loadDB();
    const info = db.vipMembers[targetId];
    if (!info) return send(chatId, "No esta en VIP");
    const left = info.expiresAt - Date.now();
    return send(chatId, `VIP activo\nFaltan: ${fmtMs(left)}\nVence: ${new Date(info.expiresAt).toLocaleString()}`);
  }

  // ✅ NUEVO: /lista_vip — lista todos los VIP activos
  if (text === "/lista_vip") {
    if (!isAdmin(userId)) return send(chatId, "No autorizado");
    const db = loadDB();
    const now = Date.now();
    const entries = Object.entries(db.vipMembers).filter(([, v]) => v.expiresAt > now);

    if (entries.length === 0) {
      return send(chatId, "No hay miembros VIP activos actualmente.");
    }

    const lines = entries.map(([uid, v]) => {
      const left = fmtMs(v.expiresAt - now);
      return `👤 ${uid} — vence en ${left}\n(${new Date(v.expiresAt).toLocaleString()})`;
    });

    return send(chatId, `📋 VIP activos: ${entries.length}\n\n` + lines.join("\n\n"));
  }
}

/**
 * ✅ NUEVO ENDPOINT:
 * Su web con ads pone un botón que llama a: https://SU_WEBHOOK_URL/go-temporal
 * Eso genera código 1-uso y redirige al bot con /start gate_CODE
 */
app.get("/go-temporal", (req, res) => {
  try {
    if (!WEBHOOK_URL) return res.status(500).send("WEBHOOK_URL no configurado");
    if (!BOT_USERNAME) return res.status(500).send("BOT_USERNAME no configurado");

    const code = addGateCode(10 * 60); // 10 min
    const tgUrl = `https://t.me/${BOT_USERNAME}?start=gate_${code}`;
    return res.redirect(302, tgUrl);
  } catch (e) {
    return res.status(500).send("Error: " + (e?.message || e));
  }
});

// WEBHOOK endpoint
app.post(`/webhook/${BOT_TOKEN}`, async (req, res) => {
  try {
    const update = req.body;

    if (update.message) await handleMessage(update.message);
    if (update.edited_message) await handleMessage(update.edited_message);

    if (update.callback_query) await handleCallbackQuery(update.callback_query);
    if (update.pre_checkout_query) await handlePreCheckoutQuery(update.pre_checkout_query);

    res.sendStatus(200);
  } catch (e) {
    console.error(e);
    try { await notifyAdmin(`❌ ERROR webhook: ${e?.message || e}`); } catch {}
    res.sendStatus(200);
  }
});

app.get("/", (req, res) => res.send("OK"));

app.listen(PORT, async () => {
  console.log("Server running on", PORT);

  setInterval(() => {
    checkVipExpirations().catch(console.error);
  }, 5 * 60 * 1000);

  // ✅ NUEVO: aviso de renovación 2 días antes
  setInterval(async () => {
    try {
      const db = loadDB();
      const now = Date.now();
      const twoDays = 2 * 24 * 60 * 60 * 1000;

      for (const [userIdStr, info] of Object.entries(db.vipMembers)) {
        if (!info?.expiresAt) continue;
        const timeLeft = info.expiresAt - now;

        // entre 0 y 2 días restantes, y no notificado aún
        if (timeLeft > 0 && timeLeft <= twoDays && !db.renewalNotified[userIdStr]) {
          db.renewalNotified[userIdStr] = true;
          saveDB(db);

          try {
            await send(
              Number(userIdStr),
              `⏰ Tu acceso VIP vence en menos de 2 dias\n\n` +
              `Vence: ${new Date(info.expiresAt).toLocaleString()}\n\n` +
              `Para renovar y no perder el acceso, elija un metodo de pago:`,
              vipMenuMarkup(false)
            );
          } catch {}
        }

        // limpiar notificados cuyo VIP ya venció
        if (timeLeft <= 0 && db.renewalNotified[userIdStr]) {
          delete db.renewalNotified[userIdStr];
        }
      }
      saveDB(db);
    } catch (e) {
      console.error("renewalCheck error:", e);
    }
  }, 30 * 60 * 1000); // revisa cada 30 min

  setInterval(async () => {
    const db = loadDB();
    if (db.temp.openUntil && db.temp.openUntil <= Date.now()) {
      await closeTemporal().catch(console.error);
    }
  }, 60 * 1000);

  // limpia códigos gate cada 2 min
  setInterval(() => {
    cleanupGateCodes();
  }, 2 * 60 * 1000);

  if (WEBHOOK_URL) {
    const url = `${WEBHOOK_URL}/webhook/${BOT_TOKEN}`;
    try {
      await tg("setWebhook", { url });
      console.log("Webhook set:", url);
      await notifyAdmin(`Webhook OK ✅\n${url}`);
    } catch (e) {
      console.error("Failed to setWebhook:", e.message);
      await notifyAdmin(`❌ Failed setWebhook: ${e?.message || e}`);
    }
  } else {
    console.log("WEBHOOK_URL no configurado (luego lo pone en Render)");
    await notifyAdmin("⚠️ WEBHOOK_URL no configurado en Render");
  }
});
