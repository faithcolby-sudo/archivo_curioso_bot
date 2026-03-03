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

function loadDB() {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  } catch {
    return {
      vipMembers: {}, // userId: { expiresAt: ms }
      temp: { openUntil: 0, inviteLink: "", postedMessageIds: [] },
      paidStars: {}, // telegram_payment_charge_id: true (anti duplicado)
      lastVipLink: {} // userId: { inviteLink, createdAt }
    };
  }
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

  const m1 = await tg("sendMessage", {
    chat_id: TEMP_CHAT_ID,
    text: "Canal TEMPORAL abierto por tiempo limitado"
  });
  const m2 = await tg("sendMessage", {
    chat_id: TEMP_CHAT_ID,
    text: "Muestra 1 (aqui luego pondremos su contenido)"
  });
  const m3 = await tg("sendMessage", {
    chat_id: TEMP_CHAT_ID,
    text: "Para VIP escriba al bot: /vip"
  });

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

  // link personal 10 min, 1 uso
  const linkObj = await createInviteLink(VIP_CHAT_ID, 10 * 60, 1);

  // guarda ultimo link (por si quieres)
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
    await send(
      ADMIN_ID,
      `Pago reportado\nUser: ${userId}\nChat: ${chatId}\nUse: /aprobar ${userId} 30`
    );
    return send(chatId, "Listo ya avise al administrador\napenas apruebe le llegara su link VIP");
  }

  if (data === "back_home") {
    return send(
      chatId,
      "Bienvenido\n\nOpciones:\n/temporal (ver estado)\n/vip (info VIP)\n\nSi ya pago: /ya_pague"
    );
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

  // valida Stars + monto + payload nuestro
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

  // activar VIP (30 días)
  try {
    const { inviteLink, expiresAt } = await approveVip(userId, 30);

    await send(chatId, `Pago recibido ✅\nVIP activado 30 dias\n\nLink personal (10 min): ${inviteLink}\n\nSi se le vence el link, escriba /mi_vip`);
    await notifyAdmin(
      `VIP activado ✅\nUser: ${userId}\nVence: ${new Date(expiresAt).toLocaleString()}\nLink:\n${inviteLink}`
    );
  } catch (e) {
    await notifyAdmin(`❌ ERROR activando VIP\nUser: ${userId}\nError: ${e?.message || e}`);

    // al usuario le avisamos para que intente recuperar luego
    try {
      await send(chatId, "Pago recibido ✅\nPero hubo un error activando el VIP\nEscriba /mi_vip en 1 minuto\nSi no sale, escriba /ya_pague");
    } catch {}
  }
}

/**
 * COMANDOS
 */
async function handleMessage(msg) {
  const chatId = msg.chat?.id;
  const userId = msg.from?.id;
  const text = (msg.text || "").trim();

  if (!chatId || !userId) return;

  // si llega successful_payment aquí, procesamos
  if (msg.successful_payment) {
    return handleSuccessfulPayment(msg).catch(async (e) => {
      await notifyAdmin(`❌ ERROR handleSuccessfulPayment: ${e?.message || e}`);
    });
  }

  // /start con parametro (ej: /start vip)
  if (text.startsWith("/start")) {
    const parts = text.split(/\s+/);
    const arg = (parts[1] || "").toLowerCase();

    if (arg === "vip") {
      return send(chatId, "VIP mensual\n\nElija un metodo de pago:", vipMenuMarkup(false));
    }

    return send(
      chatId,
      "Bienvenido\n\nOpciones:\n/temporal (ver estado)\n/vip (info VIP)\n/mi_vip (reenvia link si ya tiene VIP)\n\nSi ya pago: /ya_pague"
    );
  }

  if (!text.startsWith("/")) return;

  // /vip -> menu
  if (text === "/vip") {
    return send(chatId, "VIP mensual\n\nElija un metodo de pago:", vipMenuMarkup(true));
  }

  // /mi_vip -> genera link nuevo si tiene VIP activo
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

  // /ya_pague (manual USDT)
  if (text === "/ya_pague") {
    await send(ADMIN_ID, `Pago reportado\nUser: ${userId}\nChat: ${chatId}\nUse: /aprobar ${userId} 30`);
    return send(chatId, "Listo ya avise al administrador\napenas apruebe le llegara su link VIP");
  }

  // /temporal
  if (text === "/temporal") {
    const db = loadDB();
    if (db.temp.openUntil && db.temp.openUntil > Date.now()) {
      return send(chatId, `Temporal ABIERTO\nLink: ${db.temp.inviteLink}\nCierra en: ${fmtMs(db.temp.openUntil - Date.now())}`);
    }
    return send(chatId, "Temporal CERRADO\nEspere que el admin lo abra");
  }

  // ADMIN: /abrir_temporal 2h
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

    // Publicar en HUB con boton al bot
    if (HUB_CHAT_ID) {
      const botUrl = BOT_USERNAME ? `https://t.me/${BOT_USERNAME}?start=vip` : null;

      if (botUrl) {
        await send(
          HUB_CHAT_ID,
          "TEMPORAL ABIERTO por " +
            hours +
            "h\n\nEntra aqui:\n" +
            inviteLink +
            "\n\nVIP 24/7: toca el boton",
          {
            reply_markup: {
              inline_keyboard: [[{ text: "Desbloquear acceso VIP 🔒", url: botUrl }]]
            }
          }
        );
      } else {
        await send(
          HUB_CHAT_ID,
          "TEMPORAL ABIERTO por " +
            hours +
            "h\n\nEntra aqui:\n" +
            inviteLink +
            "\n\nVIP 24/7: escriba /vip al bot"
        );
      }
    }

    return send(chatId, "Temporal ABIERTO\nLink para entrar:\n" + inviteLink + "\nDuracion: " + hours + "h");
  }

  // ADMIN: /cerrar_temporal
  if (text === "/cerrar_temporal") {
    if (!isAdmin(userId)) return send(chatId, "No autorizado");
    await closeTemporal();
    return send(chatId, "Temporal cerrado y contenido borrado");
  }

  // ADMIN: /aprobar USER_ID DIAS
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

  // ADMIN: /estado_vip USER_ID
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
    if (update.edited_message) await handleMessage(update.edited_message); // NUEVO (por seguridad)

    if (update.callback_query) await handleCallbackQuery(update.callback_query);
    if (update.pre_checkout_query) await handlePreCheckoutQuery(update.pre_checkout_query);

    res.sendStatus(200);
  } catch (e) {
    console.error(e);
    try {
      await notifyAdmin(`❌ ERROR webhook: ${e?.message || e}`);
    } catch {}
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
