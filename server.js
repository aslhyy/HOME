/**
 * Home – Finanzas en pareja
 * Backend basado en Firebase Admin SDK + Firestore.
 * La API HTTP mantiene el contrato esperado por el frontend.
 *
 * Variables de entorno requeridas (ver .env.example):
 *   FIREBASE_SERVICE_ACCOUNT  JSON completo de la cuenta de servicio (recomendado)
 *   — o bien —
 *   GOOGLE_APPLICATION_CREDENTIALS  Ruta al archivo JSON de la cuenta de servicio
 *
 * Variables opcionales:
 *   PORT          Puerto HTTP (por defecto 4173)
 *   NODE_ENV      "production" para ocultar el código de recuperación en pantalla
 */

"use strict";

const http    = require("node:http");
const fs      = require("node:fs");
const path    = require("node:path");
const os      = require("node:os");
const crypto  = require("node:crypto");
const admin   = require("firebase-admin");
const ROOT    = __dirname;

loadEnvFile(path.join(ROOT, ".env"));

// ─── Firebase ─────────────────────────────────────────────────────────────────

(function initFirebase() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    let serviceAccount;
    try {
      serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    } catch {
      throw new Error("FIREBASE_SERVICE_ACCOUNT no contiene un JSON valido.");
    }

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
  } else {
    // Usa GOOGLE_APPLICATION_CREDENTIALS si está configurada
    admin.initializeApp();
  }
})();

const db         = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

// ─── Constantes ───────────────────────────────────────────────────────────────

const PORT                    = Number(process.env.PORT || 4173);
const SESSION_DAYS            = 30;
const RESET_CODE_MINUTES      = 15;
const MAX_AVATAR_DATA_URL_LEN = 450_000;
const ACCOUNT_COLORS          = ["Lavanda", "Lila", "Rosa", "Durazno", "Menta", "Cielo"];
const MIME_TYPES = {
  ".css":         "text/css; charset=utf-8",
  ".html":        "text/html; charset=utf-8",
  ".js":          "text/javascript; charset=utf-8",
  ".json":        "application/json; charset=utf-8",
  ".svg":         "image/svg+xml; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8"
};

// ─── Servidor HTTP ─────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    console.error("[error]", err);
    respondJson(res, err.status || 500, {
      error: err.status ? err.message : "Error interno del servidor."
    });
  });
});

server.listen(PORT, "0.0.0.0", () => {
  const urls = [`http://localhost:${PORT}`, ...getNetworkUrls(PORT)];
  console.log("Home listo en:");
  urls.forEach((u) => console.log(`  ${u}`));
});

// ─── Routing ──────────────────────────────────────────────────────────────────

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith("/api/")) {
    await handleApi(req, res, url);
  } else {
    serveStatic(res, url.pathname);
  }
}

async function handleApi(req, res, url) {
  try {
    const route = `${req.method} ${url.pathname}`;

    if (route === "POST /api/auth/register") {
      await registerUser(req, res); return;
    }
    if (route === "POST /api/auth/login") {
      await loginUser(req, res); return;
    }
    if (route === "POST /api/auth/request-reset") {
      await requestPasswordReset(req, res); return;
    }
    if (route === "POST /api/auth/reset-password") {
      await resetPassword(req, res); return;
    }
    if (route === "POST /api/auth/logout") {
      await logoutUser(req, res); return;
    }
    if (route === "GET /api/bootstrap") {
      const auth     = await requireAuth(req);
      const monthKey = parseMonthKey(url.searchParams.get("month") || currentMonthKey());
      await ensurePlanItemsForMonth(auth.household.id, monthKey);
      respondJson(res, 200, await buildBootstrap(auth, monthKey));
      return;
    }
    if (route === "POST /api/accounts") {
      const auth = await requireAuth(req);
      await createAccount(req, res, auth); return;
    }
    if (route === "POST /api/accounts/clear") {
      const auth = await requireAuth(req);
      await clearAccounts(req, res, auth); return;
    }
    if (route === "POST /api/plan-items") {
      const auth = await requireAuth(req);
      await createPlanItem(req, res, auth); return;
    }
    if (route === "POST /api/transactions") {
      const auth = await requireAuth(req);
      await createTransaction(req, res, auth); return;
    }
    if (route === "POST /api/transactions/update") {
      const auth = await requireAuth(req);
      await updateTransaction(req, res, auth); return;
    }
    if (route === "POST /api/transactions/delete") {
      const auth = await requireAuth(req);
      await deleteTransaction(req, res, auth); return;
    }
    if (route === "POST /api/settings") {
      const auth = await requireAuth(req);
      await saveSettings(req, res, auth); return;
    }

    respondJson(res, 404, { error: "Ruta no encontrada." });
  } catch (err) {
    respondJson(res, err.status || 500, { error: err.message || "Error interno." });
  }
}

// ─── Auth: Registro ───────────────────────────────────────────────────────────

async function registerUser(req, res) {
  const body          = await readJsonBody(req);
  const name          = requireText(body.name, 2, 48, "Nombre invalido.");
  const email         = normalizeEmail(body.email);
  const password      = requirePassword(body.password);
  const inviteCode    = optionalText(body.inviteCode, 0, 12).toUpperCase();
  const avatarDataUrl = sanitizeAvatarDataUrl(body.avatarDataUrl);

  // Verificar que el email no exista ya
  const existingSnap = await db.collection("users").where("email", "==", email).limit(1).get();
  if (!existingSnap.empty) {
    throw createHttpError(409, "Ese email ya esta registrado.");
  }

  let householdId;
  let householdPayload;

  if (inviteCode) {
    const hSnap = await db.collection("households").where("inviteCode", "==", inviteCode).limit(1).get();
    if (hSnap.empty) throw createHttpError(400, "Ese codigo de invitacion no existe.");

    const hDoc = hSnap.docs[0];
    householdId = hDoc.id;
    householdPayload = null; // ya existe, no se crea

    const membersSnap = await db.collection("memberships").where("householdId", "==", householdId).get();
    if (membersSnap.size >= 2) {
      throw createHttpError(400, "Ese entorno compartido ya tiene dos personas.");
    }
  } else {
    householdId = crypto.randomUUID();
    householdPayload = {
      name:       "Home",
      currency:   "COP",
      inviteCode: await createInviteCodeUnique(),
      createdAt:  nowIso()
    };
  }

  const userId          = crypto.randomUUID();
  const createdAt       = nowIso();
  const passwordRecord  = createPasswordRecord(password);
  const batch           = db.batch();

  if (householdPayload) {
    batch.set(db.collection("households").doc(householdId), householdPayload);
  }

  batch.set(db.collection("users").doc(userId), {
    name,
    email,
    passwordSalt:   passwordRecord.salt,
    passwordHash:   passwordRecord.hash,
    avatarDataUrl,
    createdAt
  });

  batch.set(db.collection("memberships").doc(crypto.randomUUID()), {
    householdId,
    userId,
    role:     inviteCode ? "partner" : "owner",
    joinedAt: createdAt
  });

  await batch.commit();
  await createSession(res, userId);
  respondJson(res, 201, { ok: true });
}

// ─── Auth: Login ──────────────────────────────────────────────────────────────

async function loginUser(req, res) {
  const body     = await readJsonBody(req);
  const email    = normalizeEmail(body.email);
  const password = requirePassword(body.password, true);

  const snap = await db.collection("users").where("email", "==", email).limit(1).get();
  if (snap.empty) throw createHttpError(401, "Email o contrasena incorrectos.");

  const userDoc  = snap.docs[0];
  const userData = userDoc.data();

  if (!verifyPassword(password, userData.passwordSalt, userData.passwordHash)) {
    throw createHttpError(401, "Email o contrasena incorrectos.");
  }

  await createSession(res, userDoc.id);
  respondJson(res, 200, { ok: true });
}

// ─── Auth: Solicitar reset ────────────────────────────────────────────────────

async function requestPasswordReset(req, res) {
  const body  = await readJsonBody(req);
  const email = normalizeEmail(body.email);

  const payload = {
    ok:             true,
    message:        "Si el email existe, se genero un codigo temporal.",
    expiresMinutes: RESET_CODE_MINUTES
  };

  const snap = await db.collection("users").where("email", "==", email).limit(1).get();

  if (!snap.empty) {
    const userId    = snap.docs[0].id;
    const code      = randomResetCode();
    const createdAt = nowIso();
    const expiresAt = new Date(Date.now() + RESET_CODE_MINUTES * 60 * 1000).toISOString();

    // Invalidar resets anteriores
    const oldResets = await db.collection("passwordResets")
      .where("userId",  "==", userId)
      .where("usedAt",  "==", null)
      .get();

    const batch = db.batch();
    oldResets.docs.forEach((doc) => batch.update(doc.ref, { usedAt: createdAt }));
    batch.set(db.collection("passwordResets").doc(crypto.randomUUID()), {
      userId,
      codeHash:  hashCode(code),
      expiresAt,
      usedAt:    null,
      createdAt
    });
    await batch.commit();

    if (process.env.NODE_ENV !== "production") {
      payload.previewCode = code;
    }
  }

  respondJson(res, 200, payload);
}

// ─── Auth: Reset de contraseña ────────────────────────────────────────────────

async function resetPassword(req, res) {
  const body        = await readJsonBody(req);
  const email       = normalizeEmail(body.email);
  const code        = requireText(body.code, 4, 12, "Codigo invalido.");
  const newPassword = requirePassword(body.newPassword);

  const userSnap = await db.collection("users").where("email", "==", email).limit(1).get();
  if (userSnap.empty) throw createHttpError(400, "No se pudo validar la recuperacion.");

  const userDoc = userSnap.docs[0];
  const userId  = userDoc.id;

  const resetSnap = await db.collection("passwordResets")
    .where("userId", "==", userId)
    .where("usedAt", "==", null)
    .orderBy("createdAt", "desc")
    .limit(1)
    .get();

  if (resetSnap.empty) throw createHttpError(400, "Codigo vencido o incorrecto.");

  const resetDoc  = resetSnap.docs[0];
  const resetData = resetDoc.data();

  if (resetData.expiresAt <= nowIso() || resetData.codeHash !== hashCode(code)) {
    throw createHttpError(400, "Codigo vencido o incorrecto.");
  }

  const pr     = createPasswordRecord(newPassword);
  const usedAt = nowIso();

  // Eliminar todas las sesiones activas del usuario
  const sessionsSnap = await db.collection("sessions").where("userId", "==", userId).get();

  const batch = db.batch();
  batch.update(userDoc.ref, { passwordSalt: pr.salt, passwordHash: pr.hash });
  batch.update(resetDoc.ref, { usedAt });
  sessionsSnap.docs.forEach((doc) => batch.delete(doc.ref));
  await batch.commit();

  await createSession(res, userId);
  respondJson(res, 200, { ok: true });
}

// ─── Auth: Logout ─────────────────────────────────────────────────────────────

async function logoutUser(req, res) {
  const cookies = parseCookies(req.headers.cookie || "");
  if (cookies.sid) {
    await db.collection("sessions").doc(cookies.sid).delete();
  }
  respondJson(res, 200, { ok: true }, { "Set-Cookie": expiredCookie() });
}

// ─── Cuentas ──────────────────────────────────────────────────────────────────

async function createAccount(req, res, auth) {
  const body           = await readJsonBody(req);
  const name           = requireText(body.name, 2, 40, "Nombre de cuenta invalido.");
  const type           = requireOneOf(body.type, ["bank", "cash"], "Tipo de cuenta invalido.");
  const scope          = requireOneOf(body.scope, ["personal", "shared"], "Espacio invalido.");
  const openingBalance = requireMoney(body.openingBalance, "Saldo inicial invalido.");

  await db.collection("accounts").doc(crypto.randomUUID()).set({
    householdId:    auth.household.id,
    ownerUserId:    scope === "shared" ? null : auth.user.id,
    name,
    type,
    openingBalance,
    currentBalance: openingBalance,   // saldo actualizado con cada transacción
    colorName:      pickColorName(name),
    createdAt:      nowIso()
  });

  respondJson(res, 201, { ok: true });
}

async function clearAccounts(req, res, auth) {
  const [accountsSnap, transactionsSnap, planItemsSnap] = await Promise.all([
    db.collection("accounts").where("householdId", "==", auth.household.id).get(),
    db.collection("transactions").where("householdId", "==", auth.household.id).get(),
    db.collection("planItems").where("householdId", "==", auth.household.id).get()
  ]);

  const accountIds = new Set(accountsSnap.docs.map((doc) => doc.id));
  const transactionDocs = transactionsSnap.docs.filter((doc) => accountIds.has(doc.data().accountId));
  const transactionIds = new Set(transactionDocs.map((doc) => doc.id));
  const planDocsToReset = planItemsSnap.docs.filter((doc) => {
    const completedTransactionId = doc.data().completedTransactionId;
    return completedTransactionId && transactionIds.has(completedTransactionId);
  });

  await commitBatchOperations([
    ...planDocsToReset.map((doc) => ({
      type: "update",
      ref: doc.ref,
      data: {
        completedTransactionId: null,
        completedAt: null
      }
    })),
    ...transactionDocs.map((doc) => ({
      type: "delete",
      ref: doc.ref
    })),
    ...accountsSnap.docs.map((doc) => ({
      type: "delete",
      ref: doc.ref
    }))
  ]);

  respondJson(res, 200, {
    ok: true,
    deletedAccounts: accountsSnap.size,
    deletedTransactions: transactionDocs.length
  });
}

// ─── Ítems del Plan ───────────────────────────────────────────────────────────

async function createPlanItem(req, res, auth) {
  const body          = await readJsonBody(req);
  const monthKey      = parseMonthKey(body.monthKey || currentMonthKey());
  const kind          = requireOneOf(body.kind, ["income", "expense"], "Tipo invalido.");
  const title         = requireText(body.title, 2, 48, "Nombre invalido.");
  const category      = requireText(body.category, 2, 40, "Categoria invalida.");
  const amount        = requireMoney(body.amount, "Valor invalido.");
  const dueDay        = requireDay(body.dueDay);
  const scope         = requireOneOf(body.scope, ["personal", "shared"], "Espacio invalido.");
  const repeatMonthly = Boolean(body.repeatMonthly);

  const ownerUserId = scope === "shared" ? null : auth.user.id;
  const createdAt   = nowIso();
  const batch       = db.batch();

  let templateId = null;
  if (repeatMonthly) {
    templateId = crypto.randomUUID();
    batch.set(db.collection("planTemplates").doc(templateId), {
      householdId: auth.household.id,
      ownerUserId,
      kind, title, category, amount, dueDay,
      active: true,
      createdAt
    });
  }

  batch.set(db.collection("planItems").doc(crypto.randomUUID()), {
    householdId:             auth.household.id,
    ownerUserId,
    templateId,
    kind, title, category, amount, dueDay, monthKey,
    completedTransactionId:  null,
    completedAt:             null,
    createdAt
  });

  await batch.commit();
  respondJson(res, 201, { ok: true });
}

// ─── Transacciones ────────────────────────────────────────────────────────────

async function createTransaction(req, res, auth) {
  const body       = await readJsonBody(req);
  const kind       = requireOneOf(body.kind, ["income", "expense"], "Tipo invalido.");
  const accountId  = requireText(body.accountId, 1, 64, "Cuenta invalida.");
  const category   = requireText(body.category, 2, 40, "Categoria invalida.");
  const amount     = requireMoney(body.amount, "Valor invalido.");
  const occurredOn = requireDate(body.occurredOn, "Fecha invalida.");
  const note       = optionalText(body.note, 0, 140);
  const planItemId = optionalText(body.planItemId, 0, 64);
  const monthKey   = occurredOn.slice(0, 7);

  await db.runTransaction(async (txn) => {
    // Validar cuenta
    const accountDoc = await txn.get(db.collection("accounts").doc(accountId));
    if (!accountDoc.exists) throw createHttpError(404, "No puedes usar esa cuenta.");
    const acct = accountDoc.data();
    if (acct.householdId !== auth.household.id)                                throw createHttpError(404, "No puedes usar esa cuenta.");
    if (acct.ownerUserId !== null && acct.ownerUserId !== auth.user.id)        throw createHttpError(404, "No puedes usar esa cuenta.");

    // Validar ítem del plan (opcional)
    let planDoc = null;
    if (planItemId) {
      planDoc = await txn.get(db.collection("planItems").doc(planItemId));
      if (!planDoc.exists) throw createHttpError(404, "Ese item del plan no existe.");
      const item = planDoc.data();
      if (item.householdId !== auth.household.id)                              throw createHttpError(404, "Ese item del plan no existe.");
      if (item.ownerUserId !== null && item.ownerUserId !== auth.user.id)      throw createHttpError(404, "Ese item del plan no existe.");
      if (item.kind !== kind)                                                  throw createHttpError(400, "El item del plan no coincide con el tipo de movimiento.");
      if (item.completedTransactionId)                                         throw createHttpError(400, "Ese item del plan ya fue marcado.");
      if (item.monthKey !== monthKey)                                          throw createHttpError(400, "La fecha debe pertenecer al mismo mes del item.");
      const planShared = item.ownerUserId === null;
      const acctShared = acct.ownerUserId  === null;
      if (planShared !== acctShared)                                           throw createHttpError(400, "El item del plan y la cuenta deben estar en el mismo espacio.");
    }

    const transactionId = crypto.randomUUID();
    const createdAt     = nowIso();

    // Escribir transacción
    txn.set(db.collection("transactions").doc(transactionId), {
      householdId:  auth.household.id,
      accountId,
      actorUserId:  auth.user.id,
      planItemId:   planItemId || null,
      kind, category, amount, note, occurredOn, monthKey,
      createdAt
    });

    // Actualizar saldo de la cuenta atómicamente
    const delta = kind === "income" ? amount : -amount;
    txn.update(accountDoc.ref, { currentBalance: FieldValue.increment(delta) });

    // Marcar ítem del plan como completado
    if (planItemId && planDoc) {
      txn.update(planDoc.ref, {
        completedTransactionId: transactionId,
        completedAt:            occurredOn
      });
    }
  });

  respondJson(res, 201, { ok: true });
}

async function updateTransaction(req, res, auth) {
  const body          = await readJsonBody(req);
  const transactionId = requireText(body.transactionId, 1, 64, "Movimiento invalido.");
  const kind          = requireOneOf(body.kind, ["income", "expense"], "Tipo invalido.");
  const accountId     = requireText(body.accountId, 1, 64, "Cuenta invalida.");
  const category      = requireText(body.category, 2, 40, "Categoria invalida.");
  const amount        = requireMoney(body.amount, "Valor invalido.");
  const occurredOn    = requireDate(body.occurredOn, "Fecha invalida.");
  const note          = optionalText(body.note, 0, 140);
  const planItemId    = optionalText(body.planItemId, 0, 64);
  const monthKey      = occurredOn.slice(0, 7);

  await db.runTransaction(async (txn) => {
    const currentContext = await getTransactionEditContext(txn, auth, transactionId);
    const currentDelta = movementDelta(currentContext.transaction.kind, currentContext.transaction.amount);
    const nextDelta = movementDelta(kind, amount);

    const nextAccountContext = accountId === currentContext.transaction.accountId
      ? currentContext.accountContext
      : await getVisibleAccountContext(txn, auth, accountId);

    let nextPlanContext = null;
    if (planItemId) {
      nextPlanContext = await getVisiblePlanItemContext(txn, auth, planItemId);
      validatePlanItemForTransaction(
        nextPlanContext.data,
        auth,
        kind,
        monthKey,
        getAccountScope(nextAccountContext.data),
        transactionId
      );
    }

    if (currentContext.transaction.accountId === accountId) {
      const adjustment = nextDelta - currentDelta;
      if (adjustment !== 0) {
        txn.update(currentContext.accountContext.doc.ref, {
          currentBalance: FieldValue.increment(adjustment)
        });
      }
    } else {
      txn.update(currentContext.accountContext.doc.ref, {
        currentBalance: FieldValue.increment(-currentDelta)
      });
      txn.update(nextAccountContext.doc.ref, {
        currentBalance: FieldValue.increment(nextDelta)
      });
    }

    if (
      currentContext.planItemContext &&
      currentContext.transaction.planItemId !== planItemId &&
      currentContext.planItemContext.data.completedTransactionId === transactionId
    ) {
      txn.update(currentContext.planItemContext.doc.ref, {
        completedTransactionId: null,
        completedAt: null
      });
    }

    if (nextPlanContext) {
      txn.update(nextPlanContext.doc.ref, {
        completedTransactionId: transactionId,
        completedAt: occurredOn
      });
    }

    txn.update(currentContext.transactionDoc.ref, {
      accountId,
      planItemId: planItemId || null,
      kind,
      category,
      amount,
      note,
      occurredOn,
      monthKey,
      updatedAt: nowIso(),
      updatedByUserId: auth.user.id
    });
  });

  respondJson(res, 200, { ok: true });
}

async function deleteTransaction(req, res, auth) {
  const body = await readJsonBody(req);
  const transactionId = requireText(body.transactionId, 1, 64, "Movimiento invalido.");

  await db.runTransaction(async (txn) => {
    const currentContext = await getTransactionEditContext(txn, auth, transactionId);
    const currentDelta = movementDelta(currentContext.transaction.kind, currentContext.transaction.amount);

    txn.update(currentContext.accountContext.doc.ref, {
      currentBalance: FieldValue.increment(-currentDelta)
    });

    if (
      currentContext.planItemContext &&
      currentContext.planItemContext.data.completedTransactionId === transactionId
    ) {
      txn.update(currentContext.planItemContext.doc.ref, {
        completedTransactionId: null,
        completedAt: null
      });
    }

    txn.delete(currentContext.transactionDoc.ref);
  });

  respondJson(res, 200, { ok: true });
}

// ─── Ajustes ──────────────────────────────────────────────────────────────────

async function saveSettings(req, res, auth) {
  const body         = await readJsonBody(req);
  const name         = requireText(body.name, 2, 48, "Nombre invalido.");
  const currency     = requireOneOf(body.currency, ["COP", "USD", "EUR", "MXN"], "Moneda invalida.");
  const avatarDataUrl = body.avatarDataUrl === undefined
    ? undefined
    : sanitizeAvatarDataUrl(body.avatarDataUrl);

  const userUpdate = { name };
  if (avatarDataUrl !== undefined) userUpdate.avatarDataUrl = avatarDataUrl;

  const batch = db.batch();
  batch.update(db.collection("users").doc(auth.user.id), userUpdate);
  batch.update(db.collection("households").doc(auth.household.id), { currency });
  await batch.commit();

  respondJson(res, 200, { ok: true });
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

async function buildBootstrap(auth, monthKey) {
  // Cuentas: compartidas + personales del usuario (dos queries por limitación de Firestore)
  const [sharedAccSnap, personalAccSnap] = await Promise.all([
    db.collection("accounts").where("householdId", "==", auth.household.id).where("ownerUserId", "==", null).get(),
    db.collection("accounts").where("householdId", "==", auth.household.id).where("ownerUserId", "==", auth.user.id).get()
  ]);

  const accounts = [
    ...sharedAccSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
    ...personalAccSnap.docs.map((d) => ({ id: d.id, ...d.data() }))
  ]
    .sort((a, b) => {
      // Compartidas primero, luego por tipo, luego por fecha de creación
      const sharedDiff = (a.ownerUserId === null ? 0 : 1) - (b.ownerUserId === null ? 0 : 1);
      if (sharedDiff !== 0) return sharedDiff;
      if (a.type !== b.type) return a.type.localeCompare(b.type);
      return a.createdAt.localeCompare(b.createdAt);
    })
    .map((acc) => ({
      id:             acc.id,
      name:           acc.name,
      type:           acc.type,
      scope:          acc.ownerUserId ? "personal" : "shared",
      scopeLabel:     acc.ownerUserId ? "Mi espacio" : "Compartido",
      openingBalance: acc.openingBalance,
      balance:        acc.currentBalance,
      colorName:      acc.colorName
    }));

  const visibleAccountIds = new Set(accounts.map((a) => a.id));

  // Transacciones del mes (filtramos en memoria por cuentas visibles)
  const txSnap = await db.collection("transactions")
    .where("householdId", "==", auth.household.id)
    .where("monthKey",    "==", monthKey)
    .orderBy("occurredOn", "desc")
    .orderBy("createdAt",  "desc")
    .limit(120)
    .get();

  const accountMap = new Map(accounts.map((a) => [a.id, a]));
  const transactions = txSnap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((t) => visibleAccountIds.has(t.accountId))
    .map((t) => {
      const acc = accountMap.get(t.accountId);
      return {
        id:          t.id,
        accountId:   t.accountId,
        planItemId:  t.planItemId || "",
        kind:        t.kind,
        category:    t.category,
        amount:      t.amount,
        note:        t.note,
        occurredOn:  t.occurredOn,
        accountName: acc?.name      || "",
        accountType: acc?.type      || "bank",
        scope:       acc?.scope     || "shared",
        scopeLabel:  acc?.scopeLabel || "Compartido",
        planLinked:  Boolean(t.planItemId)
      };
    });

  // Ítems del plan: compartidos + personales del usuario
  const [sharedPlanSnap, personalPlanSnap] = await Promise.all([
    db.collection("planItems")
      .where("householdId", "==", auth.household.id)
      .where("monthKey",    "==", monthKey)
      .where("ownerUserId", "==", null)
      .get(),
    db.collection("planItems")
      .where("householdId", "==", auth.household.id)
      .where("monthKey",    "==", monthKey)
      .where("ownerUserId", "==", auth.user.id)
      .get()
  ]);

  const planItems = [
    ...sharedPlanSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
    ...personalPlanSnap.docs.map((d) => ({ id: d.id, ...d.data() }))
  ]
    .sort((a, b) => {
      if (a.kind !== b.kind)       return a.kind.localeCompare(b.kind);
      if (a.dueDay !== b.dueDay)   return a.dueDay - b.dueDay;
      return a.title.localeCompare(b.title, "es");
    })
    .map((item) => ({
      id:          item.id,
      kind:        item.kind,
      title:       item.title,
      category:    item.category,
      amount:      item.amount,
      dueDay:      item.dueDay,
      monthKey:    item.monthKey,
      completed:   Boolean(item.completedTransactionId),
      completedAt: item.completedAt,
      scope:       item.ownerUserId ? "personal" : "shared",
      scopeLabel:  item.ownerUserId ? "Mi espacio" : "Compartido",
      isFixed:     Boolean(item.templateId)
    }));

  // Miembros del hogar
  const membershipsSnap = await db.collection("memberships")
    .where("householdId", "==", auth.household.id)
    .orderBy("joinedAt")
    .get();

  const members = await Promise.all(
    membershipsSnap.docs.map((m) => db.collection("users").doc(m.data().userId).get())
  ).then((docs) =>
    docs
      .filter((d) => d.exists)
      .map((d) => ({
        id:           d.id,
        name:         d.data().name,
        email:        d.data().email,
        avatarDataUrl: d.data().avatarDataUrl
      }))
  );

  // Tendencia (últimos 6 meses)
  const trend    = await buildTrend(auth, monthKey, visibleAccountIds);
  const summary  = summarize(accounts, transactions, planItems, trend);
  const analytics = buildAnalytics(accounts, transactions, planItems, monthKey);

  return {
    user: auth.user,
    household: {
      id:         auth.household.id,
      name:       auth.household.name,
      currency:   auth.household.currency,
      inviteCode: auth.household.inviteCode,
      members
    },
    monthKey,
    accounts,
    transactions,
    planItems,
    summary,
    analytics,
    meta: { resetPreviewMode: process.env.NODE_ENV !== "production" }
  };
}

// ─── Tendencia ────────────────────────────────────────────────────────────────

async function buildTrend(auth, monthKey, visibleAccountIds) {
  const monthKeys = [];
  const anchor    = new Date(`${monthKey}-01T00:00:00`);
  for (let i = 5; i >= 0; i--) {
    const d = new Date(anchor);
    d.setMonth(anchor.getMonth() - i);
    monthKeys.push(d.toISOString().slice(0, 7));
  }

  const firstMonth = monthKeys[0];

  // Traemos transacciones en el rango y filtramos en memoria por cuentas visibles
  const snap = await db.collection("transactions")
    .where("householdId", "==", auth.household.id)
    .where("monthKey",    ">=", firstMonth)
    .where("monthKey",    "<=", monthKey)
    .get();

  const map = new Map(monthKeys.map((k) => [k, { income: 0, expense: 0 }]));

  snap.docs.forEach((doc) => {
    const t   = doc.data();
    const row = map.get(t.monthKey);
    if (!row || !visibleAccountIds.has(t.accountId)) return;
    if (t.kind === "income") row.income += t.amount;
    else                     row.expense += t.amount;
  });

  return monthKeys.map((key) => {
    const row   = map.get(key);
    const label = new Intl.DateTimeFormat("es-CO", { month: "short" })
      .format(new Date(`${key}-01T00:00:00`))
      .replace(".", "");
    return { monthKey: key, label, income: row.income, expense: row.expense, net: row.income - row.expense };
  });
}

// ─── Auto-expansión de plantillas mensuales ───────────────────────────────────

async function ensurePlanItemsForMonth(householdId, monthKey) {
  const [templatesSnap, existingSnap] = await Promise.all([
    db.collection("planTemplates")
      .where("householdId", "==", householdId)
      .where("active",      "==", true)
      .get(),
    db.collection("planItems")
      .where("householdId", "==", householdId)
      .where("monthKey",    "==", monthKey)
      .get()
  ]);

  if (templatesSnap.empty) return;

  const existingTemplateIds = new Set(
    existingSnap.docs.map((d) => d.data().templateId).filter(Boolean)
  );

  const toCreate = templatesSnap.docs.filter((d) => !existingTemplateIds.has(d.id));
  if (!toCreate.length) return;

  const batch     = db.batch();
  const createdAt = nowIso();

  toCreate.forEach((templateDoc) => {
    const t = templateDoc.data();
    batch.set(db.collection("planItems").doc(crypto.randomUUID()), {
      householdId,
      ownerUserId:             t.ownerUserId,
      templateId:              templateDoc.id,
      kind:                    t.kind,
      title:                   t.title,
      category:                t.category,
      amount:                  t.amount,
      dueDay:                  t.dueDay,
      monthKey,
      completedTransactionId:  null,
      completedAt:             null,
      createdAt
    });
  });

  await batch.commit();
}

// ─── Resumen ──────────────────────────────────────────────────────────────────

function summarize(accounts, transactions, planItems, trend) {
  const availableTotal  = accounts.reduce((s, a) => s + a.balance, 0);
  const bankTotal       = accounts.filter((a) => a.type === "bank").reduce((s, a) => s + a.balance, 0);
  const cashTotal       = accounts.filter((a) => a.type === "cash").reduce((s, a) => s + a.balance, 0);
  const actualIncome    = transactions.filter((t) => t.kind === "income").reduce((s, t) => s + t.amount, 0);
  const actualExpense   = transactions.filter((t) => t.kind === "expense").reduce((s, t) => s + t.amount, 0);
  const plannedIncome   = planItems.filter((i) => i.kind === "income").reduce((s, i) => s + i.amount, 0);
  const plannedExpense  = planItems.filter((i) => i.kind === "expense").reduce((s, i) => s + i.amount, 0);
  const completedIncome  = planItems.filter((i) => i.kind === "income"  && i.completed).length;
  const completedExpense = planItems.filter((i) => i.kind === "expense" && i.completed).length;

  return {
    availableTotal,
    bankTotal,
    cashTotal,
    personalAvailable: accounts.filter((a) => a.scope === "personal").reduce((s, a) => s + a.balance, 0),
    sharedAvailable:   accounts.filter((a) => a.scope === "shared").reduce((s, a) => s + a.balance, 0),
    actualIncome,
    actualExpense,
    plannedIncome,
    plannedExpense,
    idealBudget:    plannedIncome  - plannedExpense,
    realizedBudget: actualIncome   - actualExpense,
    pendingItems:   planItems.filter((i) => !i.completed).length,
    completedIncome,
    completedExpense,
    trend
  };
}

// ─── Analítica ────────────────────────────────────────────────────────────────

function buildAnalytics(accounts, transactions, planItems, monthKey) {
  const scopes = ["personal", "shared"].map((scope) => {
    const tx  = transactions.filter((t) => t.scope === scope);
    const pl  = planItems.filter((i) => i.scope === scope);
    const acc = accounts.filter((a) => a.scope === scope);
    return {
      scope,
      label:          scope === "personal" ? "Mi espacio" : "Compartido",
      income:         tx.filter((t) => t.kind === "income").reduce((s, t) => s + t.amount, 0),
      expense:        tx.filter((t) => t.kind === "expense").reduce((s, t) => s + t.amount, 0),
      plannedIncome:  pl.filter((i) => i.kind === "income").reduce((s, i) => s + i.amount, 0),
      plannedExpense: pl.filter((i) => i.kind === "expense").reduce((s, i) => s + i.amount, 0),
      available:      acc.reduce((s, a) => s + a.balance, 0),
      completedItems: pl.filter((i) => i.completed).length,
      totalItems:     pl.length
    };
  });

  return {
    scopes,
    categoryBreakdowns: {
      personal: buildCategoryBreakdown(transactions, "personal"),
      shared:   buildCategoryBreakdown(transactions, "shared"),
      all:      buildCategoryBreakdown(transactions, "all")
    },
    weeklyExpenses: buildWeeklyExpenses(transactions, monthKey),
    holdingsByType: buildHoldingsByType(accounts)
  };
}

function buildCategoryBreakdown(transactions, scope) {
  const filtered = transactions.filter(
    (t) => t.kind === "expense" && (scope === "all" || t.scope === scope)
  );
  const grouped = new Map();
  filtered.forEach((t) => grouped.set(t.category, (grouped.get(t.category) || 0) + t.amount));
  const rows = [...grouped.entries()]
    .map(([category, total]) => ({ category, total }))
    .sort((a, b) => b.total - a.total);
  if (rows.length <= 5) return rows;
  const main = rows.slice(0, 4);
  const rest = rows.slice(4).reduce((s, r) => s + r.total, 0);
  return [...main, { category: "Otros", total: rest }];
}

function buildWeeklyExpenses(transactions, monthKey) {
  const date        = new Date(`${monthKey}-01T00:00:00`);
  const daysInMonth = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  const weeks       = Math.ceil(daysInMonth / 7);
  const rows        = Array.from({ length: weeks }, (_, i) => ({ label: `S${i + 1}`, personal: 0, shared: 0 }));

  transactions.forEach((t) => {
    if (t.kind !== "expense") return;
    const day       = Number(t.occurredOn.slice(8, 10));
    const weekIndex = Math.min(Math.floor((day - 1) / 7), weeks - 1);
    rows[weekIndex][t.scope] += t.amount;
  });
  return rows;
}

function buildHoldingsByType(accounts) {
  return [
    {
      label:    "Banco",
      personal: accounts.filter((a) => a.scope === "personal" && a.type === "bank").reduce((s, a) => s + a.balance, 0),
      shared:   accounts.filter((a) => a.scope === "shared"   && a.type === "bank").reduce((s, a) => s + a.balance, 0)
    },
    {
      label:    "Efectivo",
      personal: accounts.filter((a) => a.scope === "personal" && a.type === "cash").reduce((s, a) => s + a.balance, 0),
      shared:   accounts.filter((a) => a.scope === "shared"   && a.type === "cash").reduce((s, a) => s + a.balance, 0)
    }
  ];
}

// ─── requireAuth ──────────────────────────────────────────────────────────────

async function requireAuth(req) {
  const cookies = parseCookies(req.headers.cookie || "");
  if (!cookies.sid) throw createHttpError(401, "Sesion requerida.");

  const sessionDoc = await db.collection("sessions").doc(cookies.sid).get();
  if (!sessionDoc.exists) throw createHttpError(401, "Sesion expirada.");

  const session = sessionDoc.data();
  if (session.expiresAt <= nowIso()) {
    await sessionDoc.ref.delete();
    throw createHttpError(401, "Sesion expirada.");
  }

  // Leer usuario y membresía en paralelo
  const [userDoc, membershipSnap] = await Promise.all([
    db.collection("users").doc(session.userId).get(),
    db.collection("memberships").where("userId", "==", session.userId).limit(1).get()
  ]);

  if (!userDoc.exists)      throw createHttpError(401, "Usuario no encontrado.");
  if (membershipSnap.empty) throw createHttpError(401, "Sin hogar asociado.");

  const householdDoc = await db.collection("households")
    .doc(membershipSnap.docs[0].data().householdId)
    .get();
  if (!householdDoc.exists) throw createHttpError(401, "Hogar no encontrado.");

  const u = userDoc.data();
  const h = householdDoc.data();

  return {
    user: {
      id:           userDoc.id,
      name:         u.name,
      email:        u.email,
      avatarDataUrl: u.avatarDataUrl
    },
    household: {
      id:         householdDoc.id,
      name:       h.name,
      currency:   h.currency,
      inviteCode: h.inviteCode
    }
  };
}

// ─── Sesión ───────────────────────────────────────────────────────────────────

async function createSession(res, userId) {
  const sessionId = crypto.randomBytes(32).toString("hex");
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();

  await db.collection("sessions").doc(sessionId).set({ userId, expiresAt, createdAt });
  res.setHeader("Set-Cookie", buildSessionCookie(sessionId));
}

// ─── Archivos estáticos ───────────────────────────────────────────────────────

function serveStatic(res, pathname) {
  const safePath     = pathname === "/" ? "/index.html" : pathname;
  const resolvedPath = path.resolve(ROOT, `.${safePath}`);
  if (resolvedPath !== ROOT && !resolvedPath.startsWith(`${ROOT}${path.sep}`)) {
    respondText(res, 403, "Acceso denegado.");
    return;
  }

  fs.readFile(resolvedPath, (err, content) => {
    if (err) { respondText(res, 404, "No encontrado."); return; }
    res.writeHead(200, { "Content-Type": MIME_TYPES[path.extname(resolvedPath)] || "application/octet-stream" });
    res.end(content);
  });
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

function respondJson(res, status, payload, extraHeaders = {}) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...extraHeaders });
  res.end(JSON.stringify(payload));
}

function respondText(res, status, message) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(message);
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const raw = fs.readFileSync(filePath, "utf-8");
  raw.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      return;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex <= 0) {
      return;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    if (!key || process.env[key] !== undefined) {
      return;
    }

    let value = trimmed.slice(separatorIndex + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  });
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf-8")); }
  catch { throw createHttpError(400, "JSON invalido."); }
}

// ─── Cookies ──────────────────────────────────────────────────────────────────

function parseCookies(header) {
  return header.split(";").map((p) => p.trim()).filter(Boolean).reduce((acc, part) => {
    const i = part.indexOf("=");
    acc[i >= 0 ? part.slice(0, i) : part] = i >= 0 ? decodeURIComponent(part.slice(i + 1)) : "";
    return acc;
  }, {});
}

function buildSessionCookie(sessionId) {
  const parts = [`sid=${sessionId}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${SESSION_DAYS * 24 * 3600}`];
  if (process.env.NODE_ENV === "production") parts.push("Secure");
  return parts.join("; ");
}

function expiredCookie() {
  const parts = ["sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"];
  if (process.env.NODE_ENV === "production") parts.push("Secure");
  return parts.join("; ");
}

// ─── Contraseñas ──────────────────────────────────────────────────────────────

function createPasswordRecord(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return { salt, hash };
}

function verifyPassword(password, salt, hash) {
  const attempt  = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, "hex");
  return attempt.length === expected.length && crypto.timingSafeEqual(attempt, expected);
}

// ─── Validaciones ─────────────────────────────────────────────────────────────

function sanitizeAvatarDataUrl(value) {
  const text = `${value ?? ""}`.trim();
  if (!text) return "";
  if (!/^data:image\/[a-zA-Z0-9.+-]+;base64,/.test(text) || text.length > MAX_AVATAR_DATA_URL_LEN) {
    throw createHttpError(400, "La foto de perfil no es valida.");
  }
  return text;
}

function requireText(value, min, max, message) {
  const text = `${value ?? ""}`.trim();
  if (text.length < min || text.length > max) throw createHttpError(400, message);
  return text;
}

function optionalText(value, min, max) {
  const text = `${value ?? ""}`.trim();
  if (!text) return "";
  if (text.length < min || text.length > max) throw createHttpError(400, "Texto invalido.");
  return text;
}

function normalizeEmail(value) {
  const email = `${value ?? ""}`.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw createHttpError(400, "Email invalido.");
  return email;
}

function requirePassword(value, silentAuthFailure = false) {
  const password = `${value ?? ""}`;
  if (password.length < 8) throw createHttpError(silentAuthFailure ? 401 : 400, "La contrasena debe tener al menos 8 caracteres.");
  return password;
}

function requireOneOf(value, allowed, message) {
  if (!allowed.includes(value)) throw createHttpError(400, message);
  return value;
}

function requireMoney(value, message) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) throw createHttpError(400, message);
  return Math.round(amount);
}

function requireDay(value) {
  const day = Number(value);
  if (!Number.isInteger(day) || day < 1 || day > 31) throw createHttpError(400, "Dia invalido.");
  return day;
}

function requireDate(value, message) {
  const date = `${value ?? ""}`.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw createHttpError(400, message);
  return date;
}

function parseMonthKey(value) {
  const monthKey = `${value ?? ""}`.trim();
  if (!/^\d{4}-\d{2}$/.test(monthKey)) throw createHttpError(400, "Mes invalido.");
  return monthKey;
}

// ─── Utilidades ───────────────────────────────────────────────────────────────

async function getVisibleAccountContext(txn, auth, accountId) {
  const doc = await txn.get(db.collection("accounts").doc(accountId));
  if (!doc.exists) throw createHttpError(404, "No puedes usar esa cuenta.");

  const data = doc.data();
  if (data.householdId !== auth.household.id) throw createHttpError(404, "No puedes usar esa cuenta.");
  if (data.ownerUserId !== null && data.ownerUserId !== auth.user.id) {
    throw createHttpError(404, "No puedes usar esa cuenta.");
  }

  return { doc, data };
}

async function getVisiblePlanItemContext(txn, auth, planItemId) {
  const doc = await txn.get(db.collection("planItems").doc(planItemId));
  if (!doc.exists) throw createHttpError(404, "Ese item del plan no existe.");

  const data = doc.data();
  if (data.householdId !== auth.household.id) throw createHttpError(404, "Ese item del plan no existe.");
  if (data.ownerUserId !== null && data.ownerUserId !== auth.user.id) {
    throw createHttpError(404, "Ese item del plan no existe.");
  }

  return { doc, data };
}

async function getTransactionEditContext(txn, auth, transactionId) {
  const transactionDoc = await txn.get(db.collection("transactions").doc(transactionId));
  if (!transactionDoc.exists) throw createHttpError(404, "Ese movimiento no existe.");

  const transaction = transactionDoc.data();
  if (transaction.householdId !== auth.household.id) throw createHttpError(404, "Ese movimiento no existe.");

  const accountContext = await getVisibleAccountContext(txn, auth, transaction.accountId);

  let planItemContext = null;
  if (transaction.planItemId) {
    const doc = await txn.get(db.collection("planItems").doc(transaction.planItemId));
    if (doc.exists) {
      planItemContext = { doc, data: doc.data() };
    }
  }

  return { transactionDoc, transaction, accountContext, planItemContext };
}

function validatePlanItemForTransaction(item, auth, kind, monthKey, accountScope, currentTransactionId = "") {
  if (item.householdId !== auth.household.id) throw createHttpError(404, "Ese item del plan no existe.");
  if (item.ownerUserId !== null && item.ownerUserId !== auth.user.id) {
    throw createHttpError(404, "Ese item del plan no existe.");
  }
  if (item.kind !== kind) {
    throw createHttpError(400, "El item del plan no coincide con el tipo de movimiento.");
  }
  if (item.monthKey !== monthKey) {
    throw createHttpError(400, "La fecha debe pertenecer al mismo mes del item.");
  }
  if (getAccountScope(item) !== accountScope) {
    throw createHttpError(400, "El item del plan y la cuenta deben estar en el mismo espacio.");
  }
  if (item.completedTransactionId && item.completedTransactionId !== currentTransactionId) {
    throw createHttpError(400, "Ese item del plan ya fue marcado.");
  }
}

function getAccountScope(entry) {
  return entry.ownerUserId === null ? "shared" : "personal";
}

function movementDelta(kind, amount) {
  return kind === "income" ? amount : -amount;
}

async function commitBatchOperations(operations) {
  const chunkSize = 400;
  for (let index = 0; index < operations.length; index += chunkSize) {
    const batch = db.batch();
    operations.slice(index, index + chunkSize).forEach((operation) => {
      if (operation.type === "delete") {
        batch.delete(operation.ref);
        return;
      }

      if (operation.type === "update") {
        batch.update(operation.ref, operation.data);
      }
    });
    await batch.commit();
  }
}

async function createInviteCodeUnique() {
  while (true) {
    const code = crypto.randomBytes(4).toString("hex").toUpperCase();
    const snap = await db.collection("households").where("inviteCode", "==", code).limit(1).get();
    if (snap.empty) return code;
  }
}

function randomResetCode() {
  return `${Math.floor(100000 + Math.random() * 900000)}`;
}

function hashCode(code) {
  return crypto.createHash("sha256").update(code).digest("hex");
}

function nowIso() {
  return new Date().toISOString();
}

function currentMonthKey() {
  return new Date().toISOString().slice(0, 7);
}

function pickColorName(seed) {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) % 4096;
  return ACCOUNT_COLORS[hash % ACCOUNT_COLORS.length];
}

function createHttpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function getNetworkUrls(port) {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((e) => e && e.family === "IPv4" && !e.internal)
    .map((e) => `http://${e.address}:${port}`);
}
