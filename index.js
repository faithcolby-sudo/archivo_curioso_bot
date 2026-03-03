import express from "express";
import fetch from "node-fetch";
import fs from "fs";

const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const BOT_USERNAME = (process.env.BOT_USERNAME || "").replace("@", "").trim();

// precios / texto
const VIP_PRICE_STARS = String(process.env.VIP_PRICE_STARS || "275"); // 275 Stars = 30 días
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

if (!BOT_TOKEN || !ADMIN_ID || !VIP_CHAT_ID || !TEMP_CHAT_ID) {
  console.error("FALTAN VARIABLES DE ENTORNO: BOT_TOKEN, ADMIN_ID, VIP_CHAT_ID, TEMP_CHAT_ID");
  process.exit(1);
}

const API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const DB_FILE = "./db.json";

/**
 * ✅ ARREGLO CLAVE:
 * su db.json viejo tenia solo vipMembers/temp y NO tenia paidStars/lastVipLink
 * entonces al pagar Stars el codigo se caia y no mandaba link
 * este loadDB "cura" el db aunque venga incompleto y lo guarda ya arreglado
 *
 * ✅ EXTRA:
 * guardamos hubPinnedMessageId para poder EDITAR el post fijo en vez de spamear mensajes
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

  // ✅ nuevo: id del post fijo en HUB
  if (typeof db.hubPinnedMessageId !== "number") {
    db.hubPinnedMessageId = 0;
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
    [{ text: `Pagar con Stars (${VIP_PRICE_STARS})`, callback_data: "vip_stars" }],
    [{ text: `Pagar con USDT (${VIP_PRICE_USDT})`, callback_data: "vip_usdt" }],
    [{ text: "Ya pague", callback_data: "vip_yapague" }]
  ];
  if (includeBack) rows.push([{ text: "Volver", callback_data: "back_home" }]);
  return { reply_markup: { inline_keyboard: rows } };
}

/** STARS: manda invoice (XTR) */
async function sendStarsInvoice(chatId, userId) {
  let amountStars = Number(VIP_PRICE_STARS);
  if (!Number.isFinite(amountStars) || amountStars <= 0) amountStars = 275;
  amountStars = Math.floor(amountStars);
  if (amountStars < 1) amountStars = 1;

  const payload = `vip30_${userId}_${Date.now()}`;

  await notifyAdmin(
    `Invoice Stars enviado ✅\nUser: ${userId}\nChat: ${chatId}\nMonto: ${amountStars} XTR\nPayload:\n${payload}`
  );

  // Stars: NO provider_token
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

// “Expulsar” del VIP (kick): ban + unban
async function kickUser(chatId, userId) {
  await tg("banChatMember", { chat_id: chatId, user_id: userId });
  await tg("unbanChatMember", { chat_id: chatId, user_id: userId });
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

/** CALLBACKS (botones) */
async function handleCallbackQuery(cb) {
  const chatId = cb.message?.chat?.id;
  const userId = cb.from?.id;
  const data = cb.data || "";

  try { await tg("answerCallbackQuery", { callback_query_id: cb.id }); } catch {}
  if (!chatId || !userId) return;

  if (data === "vip_stars") {
    await send(chatId, "Pago con Stars\n\nSe abrira el pago aqui mismo, complete el pago y se activara automaticamente.");
    return sendStarsInvoice(chatId, userId);
  }

  if (data === "vip_usdt") {
    return send(
      chatId,
      `Pago con USDT\n\nPrecio: ${VIP_PRICE_USDT} USDT\n\n${VIP_PAY_USDT_TEXT}\n\nLuego toque "Ya pague" o escriba /ya_pague`,
      vipMenuMarkup(true)
    );
  }

  if (data === "vip_yapague") {
    await send(ADMIN_ID, `Pago reportado\nUser: ${userId}\nChat: ${chatId}\nUse: /aprobar ${userId} 30`);
    return send(chatId, "Listo ya avise al administrador\napenas apruebe le llegara su link VIP");
  }

  if (data === "back_home") {
    return send(chatId, "Bienvenido\n\nOpciones:\n/temporal (ver estado)\n/vip (info VIP)\n/mi_vip (reenvia link si ya tiene VIP)\n\nSi ya pago: /ya_pague");
  }
}

/** PRE-CHECKOUT (Stars) */
async function handlePreCheckoutQuery(q) {
  const expected = Math.floor(Number(VIP_PRICE_STARS) || 275);

  const ok =
    q.currency === "XTR" &&
    Number(q.total_amount) === expected &&
    typeof q.invoice_payload === "string" &&
    q.invoice_payload.startsWith("vip30_");

  await notifyAdmin(
    `${ok ? "PreCheckout Stars OK ✅" : "PreCheckout Stars FAIL ❌"}\nUser: ${q.from?.id}\nMonto: ${q.total_amount} ${q.currency}\nExpected: ${expected}\nPayload:\n${q.invoice_payload}`
  );

  const payload = { pre_checkout_query_id: q.id, ok: !!ok };
  if (!ok) payload.error_message = "Pago invalido, intente de nuevo.";

  return tg("answerPreCheckoutQuery", payload);
}

/** SUCCESSFUL PAYMENT (Stars) -> auto aprueba VIP */
async function handleSuccessfulPayment(msg) {
  const userId = msg.from?.id;
  const chatId = msg.chat?.id;
  const sp = msg.successful_payment;
  if (!userId || !chatId || !sp) return;

  const expected = Math.floor(Number(VIP_PRICE_STARS) || 275);

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
 * ✅ botones pro para /start (solo estetico, sin romper nada)
 * usa botones URL para que funcionen siempre
 */
function startMenuMarkup() {
  if (!BOT_USERNAME) return {};
  const base = `https://t.me/${BOT_USERNAME}`;
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "🔥 Ver canal TEMPORAL", url: `${base}?start=temporal` },
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
    "Hay pocos archivos 2 o 3 al dia y calidad media\n" +
    "Cuando se cumple el tiempo el contenido se borra automaticamente\n" +
    "Si usted entra puede quedarse o salir pero el link luego cambia\n\n" +
    "🔒 CANAL VIP\n" +
    "Esta abierto 24/7\n" +
    "El contenido no se borra queda archivado completo\n" +
    "Se suben aprox 10 videos diarios o mas\n" +
    "Cuando active VIP el bot le manda su link personal\n\n" +
    "Elija una opcion aqui abajo"
  );
}

/**
 * ✅ NUEVO: crea/edita el POST FIJO en HUB y lo fija
 */
async function upsertHubPinnedPost() {
  if (!HUB_CHAT_ID) throw new Error("HUB_CHAT_ID no configurado");
  if (!BOT_USERNAME) throw new Error("BOT_USERNAME no configurado");

  const db = loadDB();
  const botBase = `https://t.me/${BOT_USERNAME}`;

  const texto =
    "📁 Archivo Curioso 2.0\n\n" +
    "Aqui el contenido esta archivado para el deleite de tus ojos\n\n" +
    "🔥 Canal TEMPORAL\n" +
    "Se abre por tiempo limitado con muestras exclusivas\n" +
    "El contenido se borra al cerrar\n\n" +
    "🔒 Canal VIP\n" +
    "Acceso 24/7 sin borrados\n" +
    "Se agregan aprox 10 videos diarios o mas\n\n" +
    "Elija una opcion abajo";

  const markup = {
    reply_markup: {
      inline_keyboard: [
        [{ text: "🔥 Ver canal TEMPORAL", url: `${botBase}?start=temporal` }],
        [{ text: "🔒 Desbloquear VIP 30 dias", url: `${botBase}?start=vip` }],
        [{ text: "✅ Mi VIP (reenviar link)", url: `${botBase}?start=mivip` }]
      ]
    }
  };

  // si ya hay message_id guardado -> EDITA
  if (db.hubPinnedMessageId && db.hubPinnedMessageId > 0) {
    try {
      await tg("editMessageText", {
        chat_id: HUB_CHAT_ID,
        message_id: db.hubPinnedMessageId,
        text: texto,
        ...markup
      });

      // re-pin por si alguien cambió el fijado
      try {
        await tg("pinChatMessage", {
          chat_id: HUB_CHAT_ID,
          message_id: db.hubPinnedMessageId,
          disable_notification: true
        });
      } catch {}

      return { mode: "edited", messageId: db.hubPinnedMessageId };
    } catch {
      // si no se puede editar (borrado / id invalido), mandamos nuevo
      db.hubPinnedMessageId = 0;
      saveDB(db);
    }
  }

  // manda nuevo y fija
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

  // Stars payment cae como message.successful_payment
  if (msg.successful_payment) {
    return handleSuccessfulPayment(msg).catch(async (e) => {
      await notifyAdmin(`❌ ERROR handleSuccessfulPayment: ${e?.message || e}`);
    });
  }

  // /start con parametro (ESTETICO + BOTONES)
  if (text.startsWith("/start")) {
    const parts = text.split(/\s+/);
    const arg = (parts[1] || "").toLowerCase();

    if (arg === "vip") {
      return send(chatId, "🔒 VIP 30 dias\n\nElija un metodo de pago:", vipMenuMarkup(false));
    }

    if (arg === "temporal") {
      const db = loadDB();
      if (db.temp.openUntil && db.temp.openUntil > Date.now()) {
        return send(
          chatId,
          "🔥 TEMPORAL ABIERTO\n\nEntre aqui:\n" +
            db.temp.inviteLink +
            "\n\nCierra en: " +
            fmtMs(db.temp.openUntil - Date.now()),
          startMenuMarkup()
        );
      }
      return send(
        chatId,
        "🔥 TEMPORAL CERRADO\n\nSe abre por ratos y por tiempo limitado\nVuelva mas tarde",
        startMenuMarkup()
      );
    }

    if (arg === "info") {
      return send(
        chatId,
        "📌 INFO VIP\n\n" +
          "VIP esta abierto 24/7\n" +
          "Contenido completo sin borrarse\n" +
          "Aprox 10 videos diarios o mas\n\n" +
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

  if (text === "/temporal") {
    const db = loadDB();
    if (db.temp.openUntil && db.temp.openUntil > Date.now()) {
      return send(chatId, `Temporal ABIERTO\nLink: ${db.temp.inviteLink}\nCierra en: ${fmtMs(db.temp.openUntil - Date.now())}`);
    }
    return send(chatId, "Temporal CERRADO\nEspere que el admin lo abra");
  }

  // ✅ NUEVO: comando para crear/editar y fijar el post del canal HUB
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

    const { inviteLink } = await openTemporal(hours);

    if (HUB_CHAT_ID) {
      const botUrl = BOT_USERNAME ? `https://t.me/${BOT_USERNAME}?start=vip` : null;

      if (botUrl) {
        await send(
          HUB_CHAT_ID,
          "TEMPORAL ABIERTO por " + hours + "h\n\nEntra aqui:\n" + inviteLink + "\n\nVIP 24/7: toca el boton",
          { reply_markup: { inline_keyboard: [[{ text: "Desbloquear acceso VIP 🔒", url: botUrl }]] } }
        );
      } else {
        await send(
          HUB_CHAT_ID,
          "TEMPORAL ABIERTO por " + hours + "h\n\nEntra aqui:\n" + inviteLink + "\n\nVIP 24/7: escriba /vip al bot"
        );
      }
    }

    return send(chatId, "Temporal ABIERTO\nLink para entrar:\n" + inviteLink + "\nDuracion: " + hours + "h");
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
}

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

  setInterval(async () => {
    const db = loadDB();
    if (db.temp.openUntil && db.temp.openUntil <= Date.now()) {
      await closeTemporal().catch(console.error);
    }
  }, 60 * 1000);

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
