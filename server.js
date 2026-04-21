const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

const PORT = Number(process.env.PORT || 4173);
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const DB_PATH = process.env.HOME_DB_PATH || path.join(DATA_DIR, "home.sqlite");
const SESSION_DAYS = 30;
const RESET_CODE_MINUTES = 15;
const MAX_AVATAR_DATA_URL_LENGTH = 450_000;
const ACCOUNT_COLORS = ["Lavanda", "Lila", "Rosa", "Durazno", "Menta", "Cielo"];
const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8"
};

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);
initializeDatabase();
cleanupExpiredSessions();

const server = http.createServer((request, response) => {
  handleRequest(request, response).catch((error) => {
    console.error(error);
    respondJson(response, error.status || 500, {
      error: error.status ? error.message : "Error interno del servidor."
    });
  });
});

server.listen(PORT, "0.0.0.0", () => {
  const urls = [`http://localhost:${PORT}`, ...getNetworkUrls(PORT)];
  console.log("Home listo en:");
  urls.forEach((url) => console.log(`- ${url}`));
});

async function handleRequest(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);

  if (url.pathname.startsWith("/api/")) {
    await handleApi(request, response, url);
    return;
  }

  serveStatic(response, url.pathname);
}

async function handleApi(request, response, url) {
  try {
    const route = `${request.method} ${url.pathname}`;

    if (route === "POST /api/auth/register") {
      await registerUser(request, response);
      return;
    }

    if (route === "POST /api/auth/login") {
      await loginUser(request, response);
      return;
    }

    if (route === "POST /api/auth/request-reset") {
      await requestPasswordReset(request, response);
      return;
    }

    if (route === "POST /api/auth/reset-password") {
      await resetPassword(request, response);
      return;
    }

    if (route === "POST /api/auth/logout") {
      logoutUser(request, response);
      return;
    }

    if (route === "GET /api/bootstrap") {
      const auth = requireAuth(request);
      const monthKey = parseMonthKey(url.searchParams.get("month") || currentMonthKey());
      ensurePlanItemsForMonth(auth.household.id, monthKey);
      respondJson(response, 200, buildBootstrap(auth, monthKey));
      return;
    }

    if (route === "POST /api/accounts") {
      const auth = requireAuth(request);
      await createAccount(request, response, auth);
      return;
    }

    if (route === "POST /api/plan-items") {
      const auth = requireAuth(request);
      await createPlanItem(request, response, auth);
      return;
    }

    if (route === "POST /api/transactions") {
      const auth = requireAuth(request);
      await createTransaction(request, response, auth);
      return;
    }

    if (route === "POST /api/settings") {
      const auth = requireAuth(request);
      await saveSettings(request, response, auth);
      return;
    }

    respondJson(response, 404, { error: "Ruta no encontrada." });
  } catch (error) {
    respondJson(response, error.status || 500, {
      error: error.message || "Error interno."
    });
  }
}

function initializeDatabase() {
  db.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_salt TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      avatar_data_url TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS households (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      currency TEXT NOT NULL DEFAULT 'COP',
      invite_code TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memberships (
      id TEXT PRIMARY KEY,
      household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      joined_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS password_resets (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      code_hash TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
      owner_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('bank', 'cash')),
      opening_balance INTEGER NOT NULL DEFAULT 0,
      color_name TEXT NOT NULL DEFAULT 'Lavanda',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS plan_templates (
      id TEXT PRIMARY KEY,
      household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
      owner_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('income', 'expense')),
      title TEXT NOT NULL,
      category TEXT NOT NULL,
      amount INTEGER NOT NULL,
      due_day INTEGER NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS plan_items (
      id TEXT PRIMARY KEY,
      household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
      owner_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      template_id TEXT REFERENCES plan_templates(id) ON DELETE SET NULL,
      kind TEXT NOT NULL CHECK (kind IN ('income', 'expense')),
      title TEXT NOT NULL,
      category TEXT NOT NULL,
      amount INTEGER NOT NULL,
      due_day INTEGER NOT NULL,
      month_key TEXT NOT NULL,
      completed_transaction_id TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(template_id, month_key)
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY,
      household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      plan_item_id TEXT,
      kind TEXT NOT NULL CHECK (kind IN ('income', 'expense')),
      category TEXT NOT NULL,
      amount INTEGER NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      occurred_on TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_password_resets_user ON password_resets(user_id, expires_at);
    CREATE INDEX IF NOT EXISTS idx_accounts_household ON accounts(household_id);
    CREATE INDEX IF NOT EXISTS idx_plan_items_month ON plan_items(household_id, month_key);
    CREATE INDEX IF NOT EXISTS idx_transactions_month ON transactions(household_id, occurred_on);
  `);

  ensureColumn("users", "avatar_data_url TEXT NOT NULL DEFAULT ''");
}

async function registerUser(request, response) {
  const body = await readJsonBody(request);
  const name = requireText(body.name, 2, 48, "Nombre invalido.");
  const email = normalizeEmail(body.email);
  const password = requirePassword(body.password);
  const inviteCode = optionalText(body.inviteCode, 0, 12).toUpperCase();
  const avatarDataUrl = sanitizeAvatarDataUrl(body.avatarDataUrl);

  const existingUser = db.prepare(`
    SELECT id
    FROM users
    WHERE email = :email
  `).get({ email });

  if (existingUser) {
    throw createHttpError(409, "Ese email ya esta registrado.");
  }

  const userId = crypto.randomUUID();
  const createdAt = nowIso();
  const passwordRecord = createPasswordRecord(password);
  let household = null;

  runInTransaction(() => {
    if (inviteCode) {
      household = db.prepare(`
        SELECT id, name, currency, invite_code AS inviteCode
        FROM households
        WHERE invite_code = :inviteCode
      `).get({ inviteCode });

      if (!household) {
        throw createHttpError(400, "Ese codigo de invitacion no existe.");
      }

      const memberCount = db.prepare(`
        SELECT COUNT(*) AS total
        FROM memberships
        WHERE household_id = :householdId
      `).get({ householdId: household.id }).total;

      if (memberCount >= 2) {
        throw createHttpError(400, "Ese entorno compartido ya tiene dos personas.");
      }
    } else {
      household = {
        id: crypto.randomUUID(),
        name: "Home",
        currency: "COP",
        inviteCode: createInviteCodeUnique()
      };

      db.prepare(`
        INSERT INTO households (id, name, currency, invite_code, created_at)
        VALUES (:id, :name, :currency, :inviteCode, :createdAt)
      `).run({
        id: household.id,
        name: household.name,
        currency: household.currency,
        inviteCode: household.inviteCode,
        createdAt
      });
    }

    db.prepare(`
      INSERT INTO users (id, name, email, password_salt, password_hash, avatar_data_url, created_at)
      VALUES (:id, :name, :email, :salt, :hash, :avatarDataUrl, :createdAt)
    `).run({
      id: userId,
      name,
      email,
      salt: passwordRecord.salt,
      hash: passwordRecord.hash,
      avatarDataUrl,
      createdAt
    });

    db.prepare(`
      INSERT INTO memberships (id, household_id, user_id, role, joined_at)
      VALUES (:id, :householdId, :userId, :role, :joinedAt)
    `).run({
      id: crypto.randomUUID(),
      householdId: household.id,
      userId,
      role: inviteCode ? "partner" : "owner",
      joinedAt: createdAt
    });
  });

  createSession(response, userId);
  respondJson(response, 201, { ok: true });
}

async function loginUser(request, response) {
  const body = await readJsonBody(request);
  const email = normalizeEmail(body.email);
  const password = requirePassword(body.password, true);

  const user = db.prepare(`
    SELECT id, password_salt AS salt, password_hash AS hash
    FROM users
    WHERE email = :email
  `).get({ email });

  if (!user || !verifyPassword(password, user.salt, user.hash)) {
    throw createHttpError(401, "Email o contrasena incorrectos.");
  }

  createSession(response, user.id);
  respondJson(response, 200, { ok: true });
}

async function requestPasswordReset(request, response) {
  const body = await readJsonBody(request);
  const email = normalizeEmail(body.email);
  const user = db.prepare(`
    SELECT id
    FROM users
    WHERE email = :email
  `).get({ email });

  const payload = {
    ok: true,
    message: "Si el email existe, se genero un codigo temporal.",
    expiresMinutes: RESET_CODE_MINUTES
  };

  if (user) {
    const code = randomResetCode();
    const createdAt = nowIso();
    const expiresAt = new Date(Date.now() + RESET_CODE_MINUTES * 60 * 1000).toISOString();

    runInTransaction(() => {
      db.prepare(`
        UPDATE password_resets
        SET used_at = :usedAt
        WHERE user_id = :userId AND used_at IS NULL
      `).run({
        usedAt: createdAt,
        userId: user.id
      });

      db.prepare(`
        INSERT INTO password_resets (id, user_id, code_hash, expires_at, created_at)
        VALUES (:id, :userId, :codeHash, :expiresAt, :createdAt)
      `).run({
        id: crypto.randomUUID(),
        userId: user.id,
        codeHash: hashCode(code),
        expiresAt,
        createdAt
      });
    });

    if (process.env.NODE_ENV !== "production") {
      payload.previewCode = code;
    }
  }

  respondJson(response, 200, payload);
}

async function resetPassword(request, response) {
  const body = await readJsonBody(request);
  const email = normalizeEmail(body.email);
  const code = requireText(body.code, 4, 12, "Codigo invalido.");
  const newPassword = requirePassword(body.newPassword);

  const user = db.prepare(`
    SELECT id
    FROM users
    WHERE email = :email
  `).get({ email });

  if (!user) {
    throw createHttpError(400, "No se pudo validar la recuperacion.");
  }

  const reset = db.prepare(`
    SELECT id, code_hash AS codeHash, expires_at AS expiresAt
    FROM password_resets
    WHERE user_id = :userId AND used_at IS NULL
    ORDER BY created_at DESC
    LIMIT 1
  `).get({ userId: user.id });

  if (!reset || reset.expiresAt <= nowIso() || reset.codeHash !== hashCode(code)) {
    throw createHttpError(400, "Codigo vencido o incorrecto.");
  }

  const passwordRecord = createPasswordRecord(newPassword);
  const usedAt = nowIso();

  runInTransaction(() => {
    db.prepare(`
      UPDATE users
      SET password_salt = :salt, password_hash = :hash
      WHERE id = :userId
    `).run({
      salt: passwordRecord.salt,
      hash: passwordRecord.hash,
      userId: user.id
    });

    db.prepare(`
      UPDATE password_resets
      SET used_at = :usedAt
      WHERE user_id = :userId AND used_at IS NULL
    `).run({
      usedAt,
      userId: user.id
    });

    db.prepare(`
      DELETE FROM sessions
      WHERE user_id = :userId
    `).run({ userId: user.id });
  });

  createSession(response, user.id);
  respondJson(response, 200, { ok: true });
}

function logoutUser(request, response) {
  const cookies = parseCookies(request.headers.cookie || "");
  if (cookies.sid) {
    db.prepare(`
      DELETE FROM sessions
      WHERE id = :id
    `).run({ id: cookies.sid });
  }

  respondJson(response, 200, { ok: true }, {
    "Set-Cookie": expiredCookie()
  });
}

async function createAccount(request, response, auth) {
  const body = await readJsonBody(request);
  const name = requireText(body.name, 2, 40, "Nombre de cuenta invalido.");
  const type = requireOneOf(body.type, ["bank", "cash"], "Tipo de cuenta invalido.");
  const scope = requireOneOf(body.scope, ["personal", "shared"], "Espacio invalido.");
  const openingBalance = requireMoney(body.openingBalance, "Saldo inicial invalido.");

  db.prepare(`
    INSERT INTO accounts (id, household_id, owner_user_id, name, type, opening_balance, color_name, created_at)
    VALUES (:id, :householdId, :ownerUserId, :name, :type, :openingBalance, :colorName, :createdAt)
  `).run({
    id: crypto.randomUUID(),
    householdId: auth.household.id,
    ownerUserId: scope === "shared" ? null : auth.user.id,
    name,
    type,
    openingBalance,
    colorName: pickColorName(name),
    createdAt: nowIso()
  });

  respondJson(response, 201, { ok: true });
}

async function createPlanItem(request, response, auth) {
  const body = await readJsonBody(request);
  const monthKey = parseMonthKey(body.monthKey || currentMonthKey());
  const kind = requireOneOf(body.kind, ["income", "expense"], "Tipo invalido.");
  const title = requireText(body.title, 2, 48, "Nombre invalido.");
  const category = requireText(body.category, 2, 40, "Categoria invalida.");
  const amount = requireMoney(body.amount, "Valor invalido.");
  const dueDay = requireDay(body.dueDay);
  const scope = requireOneOf(body.scope, ["personal", "shared"], "Espacio invalido.");
  const repeatMonthly = Boolean(body.repeatMonthly);

  runInTransaction(() => {
    let templateId = null;
    const createdAt = nowIso();

    if (repeatMonthly) {
      templateId = crypto.randomUUID();
      db.prepare(`
        INSERT INTO plan_templates (
          id, household_id, owner_user_id, kind, title, category, amount, due_day, active, created_at
        )
        VALUES (
          :id, :householdId, :ownerUserId, :kind, :title, :category, :amount, :dueDay, 1, :createdAt
        )
      `).run({
        id: templateId,
        householdId: auth.household.id,
        ownerUserId: scope === "shared" ? null : auth.user.id,
        kind,
        title,
        category,
        amount,
        dueDay,
        createdAt
      });
    }

    db.prepare(`
      INSERT INTO plan_items (
        id, household_id, owner_user_id, template_id, kind, title, category, amount, due_day, month_key, created_at
      )
      VALUES (
        :id, :householdId, :ownerUserId, :templateId, :kind, :title, :category, :amount, :dueDay, :monthKey, :createdAt
      )
    `).run({
      id: crypto.randomUUID(),
      householdId: auth.household.id,
      ownerUserId: scope === "shared" ? null : auth.user.id,
      templateId,
      kind,
      title,
      category,
      amount,
      dueDay,
      monthKey,
      createdAt
    });
  });

  respondJson(response, 201, { ok: true });
}

async function createTransaction(request, response, auth) {
  const body = await readJsonBody(request);
  const kind = requireOneOf(body.kind, ["income", "expense"], "Tipo invalido.");
  const accountId = requireText(body.accountId, 1, 64, "Cuenta invalida.");
  const category = requireText(body.category, 2, 40, "Categoria invalida.");
  const amount = requireMoney(body.amount, "Valor invalido.");
  const occurredOn = requireDate(body.occurredOn, "Fecha invalida.");
  const note = optionalText(body.note, 0, 140);
  const planItemId = optionalText(body.planItemId, 0, 64);

  const account = getVisibleAccount(auth, accountId);
  if (!account) {
    throw createHttpError(404, "No puedes usar esa cuenta.");
  }

  runInTransaction(() => {
    if (planItemId) {
      const planItem = getVisiblePlanItem(auth, planItemId);
      if (!planItem) {
        throw createHttpError(404, "Ese item del plan no existe.");
      }

      if (planItem.kind !== kind) {
        throw createHttpError(400, "El item del plan no coincide con el tipo de movimiento.");
      }

      if (planItem.completedTransactionId) {
        throw createHttpError(400, "Ese item del plan ya fue marcado.");
      }

      if (planItem.monthKey !== occurredOn.slice(0, 7)) {
        throw createHttpError(400, "La fecha debe pertenecer al mismo mes del item.");
      }

      if ((!planItem.ownerUserId) !== (!account.ownerUserId)) {
        throw createHttpError(400, "El item del plan y la cuenta deben estar en el mismo espacio.");
      }
    }

    const transactionId = crypto.randomUUID();
    const createdAt = nowIso();

    db.prepare(`
      INSERT INTO transactions (
        id, household_id, account_id, actor_user_id, plan_item_id, kind, category, amount, note, occurred_on, created_at
      )
      VALUES (
        :id, :householdId, :accountId, :actorUserId, :planItemId, :kind, :category, :amount, :note, :occurredOn, :createdAt
      )
    `).run({
      id: transactionId,
      householdId: auth.household.id,
      accountId: account.id,
      actorUserId: auth.user.id,
      planItemId: planItemId || null,
      kind,
      category,
      amount,
      note,
      occurredOn,
      createdAt
    });

    if (planItemId) {
      db.prepare(`
        UPDATE plan_items
        SET completed_transaction_id = :transactionId, completed_at = :completedAt
        WHERE id = :planItemId
      `).run({
        transactionId,
        completedAt: occurredOn,
        planItemId
      });
    }
  });

  respondJson(response, 201, { ok: true });
}

async function saveSettings(request, response, auth) {
  const body = await readJsonBody(request);
  const name = requireText(body.name, 2, 48, "Nombre invalido.");
  const currency = requireOneOf(body.currency, ["COP", "USD", "EUR", "MXN"], "Moneda invalida.");
  const avatarDataUrl = body.avatarDataUrl === undefined
    ? undefined
    : sanitizeAvatarDataUrl(body.avatarDataUrl);

  runInTransaction(() => {
    if (avatarDataUrl === undefined) {
      db.prepare(`
        UPDATE users
        SET name = :name
        WHERE id = :userId
      `).run({
        name,
        userId: auth.user.id
      });
    } else {
      db.prepare(`
        UPDATE users
        SET name = :name, avatar_data_url = :avatarDataUrl
        WHERE id = :userId
      `).run({
        name,
        avatarDataUrl,
        userId: auth.user.id
      });
    }

    db.prepare(`
      UPDATE households
      SET currency = :currency
      WHERE id = :householdId
    `).run({
      currency,
      householdId: auth.household.id
    });
  });

  respondJson(response, 200, { ok: true });
}

function buildBootstrap(auth, monthKey) {
  const accounts = db.prepare(`
    SELECT
      a.id,
      a.name,
      a.type,
      a.owner_user_id AS ownerUserId,
      a.opening_balance AS openingBalance,
      a.color_name AS colorName,
      COALESCE(SUM(
        CASE
          WHEN t.kind = 'income' THEN t.amount
          WHEN t.kind = 'expense' THEN -t.amount
          ELSE 0
        END
      ), 0) AS delta
    FROM accounts a
    LEFT JOIN transactions t ON t.account_id = a.id
    WHERE
      a.household_id = :householdId
      AND (a.owner_user_id IS NULL OR a.owner_user_id = :userId)
    GROUP BY a.id
    ORDER BY
      CASE WHEN a.owner_user_id IS NULL THEN 0 ELSE 1 END,
      a.type,
      a.created_at
  `).all({
    householdId: auth.household.id,
    userId: auth.user.id
  }).map((account) => ({
    id: account.id,
    name: account.name,
    type: account.type,
    scope: account.ownerUserId ? "personal" : "shared",
    scopeLabel: account.ownerUserId ? "Mi espacio" : "Compartido",
    openingBalance: account.openingBalance,
    balance: account.openingBalance + account.delta,
    colorName: account.colorName
  }));

  const transactions = db.prepare(`
    SELECT
      t.id,
      t.kind,
      t.category,
      t.amount,
      t.note,
      t.occurred_on AS occurredOn,
      t.plan_item_id AS planItemId,
      a.name AS accountName,
      a.type AS accountType,
      a.owner_user_id AS accountOwnerUserId
    FROM transactions t
    INNER JOIN accounts a ON a.id = t.account_id
    WHERE
      t.household_id = :householdId
      AND (a.owner_user_id IS NULL OR a.owner_user_id = :userId)
      AND substr(t.occurred_on, 1, 7) = :monthKey
    ORDER BY t.occurred_on DESC, t.created_at DESC
    LIMIT 120
  `).all({
    householdId: auth.household.id,
    userId: auth.user.id,
    monthKey
  }).map((transaction) => ({
    id: transaction.id,
    kind: transaction.kind,
    category: transaction.category,
    amount: transaction.amount,
    note: transaction.note,
    occurredOn: transaction.occurredOn,
    accountName: transaction.accountName,
    accountType: transaction.accountType,
    scope: transaction.accountOwnerUserId ? "personal" : "shared",
    scopeLabel: transaction.accountOwnerUserId ? "Mi espacio" : "Compartido",
    planLinked: Boolean(transaction.planItemId)
  }));

  const planItems = db.prepare(`
    SELECT
      id,
      owner_user_id AS ownerUserId,
      template_id AS templateId,
      kind,
      title,
      category,
      amount,
      due_day AS dueDay,
      month_key AS monthKey,
      completed_transaction_id AS completedTransactionId,
      completed_at AS completedAt
    FROM plan_items
    WHERE
      household_id = :householdId
      AND month_key = :monthKey
      AND (owner_user_id IS NULL OR owner_user_id = :userId)
    ORDER BY kind, due_day, title
  `).all({
    householdId: auth.household.id,
    userId: auth.user.id,
    monthKey
  }).map((item) => ({
    id: item.id,
    kind: item.kind,
    title: item.title,
    category: item.category,
    amount: item.amount,
    dueDay: item.dueDay,
    monthKey: item.monthKey,
    completed: Boolean(item.completedTransactionId),
    completedAt: item.completedAt,
    scope: item.ownerUserId ? "personal" : "shared",
    scopeLabel: item.ownerUserId ? "Mi espacio" : "Compartido",
    isFixed: Boolean(item.templateId)
  }));

  const members = db.prepare(`
    SELECT
      users.id,
      users.name,
      users.email,
      users.avatar_data_url AS avatarDataUrl
    FROM memberships
    INNER JOIN users ON users.id = memberships.user_id
    WHERE memberships.household_id = :householdId
    ORDER BY memberships.joined_at
  `).all({ householdId: auth.household.id });

  const summary = summarize(accounts, transactions, planItems, auth, monthKey);
  const analytics = buildAnalytics(accounts, transactions, planItems, monthKey);

  return {
    user: auth.user,
    household: {
      id: auth.household.id,
      name: auth.household.name,
      currency: auth.household.currency,
      inviteCode: auth.household.inviteCode,
      members
    },
    monthKey,
    accounts,
    transactions,
    planItems,
    summary,
    analytics,
    meta: {
      resetPreviewMode: process.env.NODE_ENV !== "production"
    }
  };
}

function summarize(accounts, transactions, planItems, auth, monthKey) {
  const availableTotal = accounts.reduce((sum, account) => sum + account.balance, 0);
  const bankTotal = accounts.filter((account) => account.type === "bank").reduce((sum, account) => sum + account.balance, 0);
  const cashTotal = accounts.filter((account) => account.type === "cash").reduce((sum, account) => sum + account.balance, 0);
  const personalAvailable = accounts.filter((account) => account.scope === "personal").reduce((sum, account) => sum + account.balance, 0);
  const sharedAvailable = accounts.filter((account) => account.scope === "shared").reduce((sum, account) => sum + account.balance, 0);
  const actualIncome = transactions.filter((item) => item.kind === "income").reduce((sum, item) => sum + item.amount, 0);
  const actualExpense = transactions.filter((item) => item.kind === "expense").reduce((sum, item) => sum + item.amount, 0);
  const plannedIncome = planItems.filter((item) => item.kind === "income").reduce((sum, item) => sum + item.amount, 0);
  const plannedExpense = planItems.filter((item) => item.kind === "expense").reduce((sum, item) => sum + item.amount, 0);
  const completedIncome = planItems.filter((item) => item.kind === "income" && item.completed).length;
  const completedExpense = planItems.filter((item) => item.kind === "expense" && item.completed).length;

  return {
    availableTotal,
    bankTotal,
    cashTotal,
    personalAvailable,
    sharedAvailable,
    actualIncome,
    actualExpense,
    plannedIncome,
    plannedExpense,
    idealBudget: plannedIncome - plannedExpense,
    realizedBudget: actualIncome - actualExpense,
    pendingItems: planItems.filter((item) => !item.completed).length,
    completedIncome,
    completedExpense,
    trend: buildTrend(auth, monthKey)
  };
}

function buildAnalytics(accounts, transactions, planItems, monthKey) {
  const scopes = ["personal", "shared"].map((scope) => {
    const scopedTransactions = transactions.filter((transaction) => transaction.scope === scope);
    const scopedPlan = planItems.filter((item) => item.scope === scope);
    const scopedAccounts = accounts.filter((account) => account.scope === scope);

    return {
      scope,
      label: scope === "personal" ? "Mi espacio" : "Compartido",
      income: scopedTransactions.filter((item) => item.kind === "income").reduce((sum, item) => sum + item.amount, 0),
      expense: scopedTransactions.filter((item) => item.kind === "expense").reduce((sum, item) => sum + item.amount, 0),
      plannedIncome: scopedPlan.filter((item) => item.kind === "income").reduce((sum, item) => sum + item.amount, 0),
      plannedExpense: scopedPlan.filter((item) => item.kind === "expense").reduce((sum, item) => sum + item.amount, 0),
      available: scopedAccounts.reduce((sum, account) => sum + account.balance, 0),
      completedItems: scopedPlan.filter((item) => item.completed).length,
      totalItems: scopedPlan.length
    };
  });

  return {
    scopes,
    categoryBreakdowns: {
      personal: buildCategoryBreakdown(transactions, "personal"),
      shared: buildCategoryBreakdown(transactions, "shared"),
      all: buildCategoryBreakdown(transactions, "all")
    },
    weeklyExpenses: buildWeeklyExpenses(transactions, monthKey),
    holdingsByType: buildHoldingsByType(accounts)
  };
}

function buildCategoryBreakdown(transactions, scope) {
  const filtered = transactions.filter((transaction) => {
    return transaction.kind === "expense" && (scope === "all" || transaction.scope === scope);
  });

  const grouped = new Map();
  filtered.forEach((transaction) => {
    grouped.set(transaction.category, (grouped.get(transaction.category) || 0) + transaction.amount);
  });

  const rows = [...grouped.entries()]
    .map(([category, total]) => ({ category, total }))
    .sort((left, right) => right.total - left.total);

  if (rows.length <= 5) {
    return rows;
  }

  const main = rows.slice(0, 4);
  const rest = rows.slice(4).reduce((sum, row) => sum + row.total, 0);
  return [...main, { category: "Otros", total: rest }];
}

function buildWeeklyExpenses(transactions, monthKey) {
  const date = new Date(`${monthKey}-01T00:00:00`);
  const daysInMonth = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  const weeks = Math.ceil(daysInMonth / 7);
  const rows = Array.from({ length: weeks }, (_, index) => ({
    label: `S${index + 1}`,
    personal: 0,
    shared: 0
  }));

  transactions.forEach((transaction) => {
    if (transaction.kind !== "expense") {
      return;
    }

    const day = Number(transaction.occurredOn.slice(8, 10));
    const weekIndex = Math.min(Math.floor((day - 1) / 7), weeks - 1);
    rows[weekIndex][transaction.scope] += transaction.amount;
  });

  return rows;
}

function buildHoldingsByType(accounts) {
  return [
    {
      label: "Banco",
      personal: accounts.filter((account) => account.scope === "personal" && account.type === "bank").reduce((sum, account) => sum + account.balance, 0),
      shared: accounts.filter((account) => account.scope === "shared" && account.type === "bank").reduce((sum, account) => sum + account.balance, 0)
    },
    {
      label: "Efectivo",
      personal: accounts.filter((account) => account.scope === "personal" && account.type === "cash").reduce((sum, account) => sum + account.balance, 0),
      shared: accounts.filter((account) => account.scope === "shared" && account.type === "cash").reduce((sum, account) => sum + account.balance, 0)
    }
  ];
}

function buildTrend(auth, monthKey) {
  const monthKeys = [];
  const anchor = new Date(`${monthKey}-01T00:00:00`);
  for (let index = 5; index >= 0; index -= 1) {
    const current = new Date(anchor);
    current.setMonth(anchor.getMonth() - index);
    monthKeys.push(current.toISOString().slice(0, 7));
  }

  const firstMonth = monthKeys[0];
  const rows = db.prepare(`
    SELECT
      substr(t.occurred_on, 1, 7) AS monthKey,
      SUM(CASE WHEN t.kind = 'income' THEN t.amount ELSE 0 END) AS income,
      SUM(CASE WHEN t.kind = 'expense' THEN t.amount ELSE 0 END) AS expense
    FROM transactions t
    INNER JOIN accounts a ON a.id = t.account_id
    WHERE
      t.household_id = :householdId
      AND (a.owner_user_id IS NULL OR a.owner_user_id = :userId)
      AND substr(t.occurred_on, 1, 7) >= :firstMonth
      AND substr(t.occurred_on, 1, 7) <= :lastMonth
    GROUP BY substr(t.occurred_on, 1, 7)
  `).all({
    householdId: auth.household.id,
    userId: auth.user.id,
    firstMonth,
    lastMonth: monthKey
  });

  const map = new Map(rows.map((row) => [row.monthKey, row]));
  return monthKeys.map((key) => {
    const row = map.get(key) || { income: 0, expense: 0 };
    const label = new Intl.DateTimeFormat("es-CO", { month: "short" })
      .format(new Date(`${key}-01T00:00:00`))
      .replace(".", "");

    return {
      monthKey: key,
      label,
      income: row.income,
      expense: row.expense,
      net: row.income - row.expense
    };
  });
}

function ensurePlanItemsForMonth(householdId, monthKey) {
  const existingTemplateIds = new Set(db.prepare(`
    SELECT template_id AS templateId
    FROM plan_items
    WHERE household_id = :householdId AND month_key = :monthKey AND template_id IS NOT NULL
  `).all({
    householdId,
    monthKey
  }).map((row) => row.templateId));

  const templates = db.prepare(`
    SELECT
      id,
      owner_user_id AS ownerUserId,
      kind,
      title,
      category,
      amount,
      due_day AS dueDay
    FROM plan_templates
    WHERE household_id = :householdId AND active = 1
  `).all({ householdId });

  templates.forEach((template) => {
    if (existingTemplateIds.has(template.id)) {
      return;
    }

    db.prepare(`
      INSERT INTO plan_items (
        id, household_id, owner_user_id, template_id, kind, title, category, amount, due_day, month_key, created_at
      )
      VALUES (
        :id, :householdId, :ownerUserId, :templateId, :kind, :title, :category, :amount, :dueDay, :monthKey, :createdAt
      )
    `).run({
      id: crypto.randomUUID(),
      householdId,
      ownerUserId: template.ownerUserId,
      templateId: template.id,
      kind: template.kind,
      title: template.title,
      category: template.category,
      amount: template.amount,
      dueDay: template.dueDay,
      monthKey,
      createdAt: nowIso()
    });
  });
}

function getVisibleAccount(auth, accountId) {
  return db.prepare(`
    SELECT id, owner_user_id AS ownerUserId
    FROM accounts
    WHERE
      id = :accountId
      AND household_id = :householdId
      AND (owner_user_id IS NULL OR owner_user_id = :userId)
  `).get({
    accountId,
    householdId: auth.household.id,
    userId: auth.user.id
  });
}

function getVisiblePlanItem(auth, planItemId) {
  return db.prepare(`
    SELECT id, owner_user_id AS ownerUserId, kind, month_key AS monthKey, completed_transaction_id AS completedTransactionId
    FROM plan_items
    WHERE
      id = :planItemId
      AND household_id = :householdId
      AND (owner_user_id IS NULL OR owner_user_id = :userId)
  `).get({
    planItemId,
    householdId: auth.household.id,
    userId: auth.user.id
  });
}

function requireAuth(request) {
  cleanupExpiredSessions();
  const cookies = parseCookies(request.headers.cookie || "");

  if (!cookies.sid) {
    throw createHttpError(401, "Sesion requerida.");
  }

  const auth = db.prepare(`
    SELECT
      sessions.id AS sessionId,
      users.id AS userId,
      users.name AS userName,
      users.email AS userEmail,
      users.avatar_data_url AS avatarDataUrl,
      households.id AS householdId,
      households.name AS householdName,
      households.currency AS householdCurrency,
      households.invite_code AS inviteCode
    FROM sessions
    INNER JOIN users ON users.id = sessions.user_id
    INNER JOIN memberships ON memberships.user_id = users.id
    INNER JOIN households ON households.id = memberships.household_id
    WHERE sessions.id = :sid AND sessions.expires_at > :now
  `).get({
    sid: cookies.sid,
    now: nowIso()
  });

  if (!auth) {
    throw createHttpError(401, "Sesion expirada.");
  }

  return {
    user: {
      id: auth.userId,
      name: auth.userName,
      email: auth.userEmail,
      avatarDataUrl: auth.avatarDataUrl
    },
    household: {
      id: auth.householdId,
      name: auth.householdName,
      currency: auth.householdCurrency,
      inviteCode: auth.inviteCode
    }
  };
}

function createSession(response, userId) {
  const sessionId = crypto.randomBytes(32).toString("hex");
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();

  db.prepare(`
    INSERT INTO sessions (id, user_id, expires_at, created_at)
    VALUES (:id, :userId, :expiresAt, :createdAt)
  `).run({
    id: sessionId,
    userId,
    expiresAt,
    createdAt
  });

  response.setHeader("Set-Cookie", buildSessionCookie(sessionId));
}

function serveStatic(response, pathname) {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const resolvedPath = path.normalize(path.join(ROOT, safePath));

  if (!resolvedPath.startsWith(ROOT)) {
    respondText(response, 403, "Acceso denegado.");
    return;
  }

  fs.readFile(resolvedPath, (error, content) => {
    if (error) {
      respondText(response, 404, "No encontrado.");
      return;
    }

    response.writeHead(200, {
      "Content-Type": MIME_TYPES[path.extname(resolvedPath)] || "application/octet-stream"
    });
    response.end(content);
  });
}

function respondJson(response, statusCode, payload, extraHeaders = {}) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    ...extraHeaders
  });
  response.end(JSON.stringify(payload));
}

function respondText(response, statusCode, message) {
  response.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8"
  });
  response.end(message);
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }

  if (!chunks.length) {
    return {};
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
  } catch {
    throw createHttpError(400, "JSON invalido.");
  }
}

function parseCookies(cookieHeader) {
  return cookieHeader
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((accumulator, part) => {
      const index = part.indexOf("=");
      const key = index >= 0 ? part.slice(0, index) : part;
      const value = index >= 0 ? part.slice(index + 1) : "";
      accumulator[key] = decodeURIComponent(value);
      return accumulator;
    }, {});
}

function buildSessionCookie(sessionId) {
  const parts = [
    `sid=${sessionId}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${SESSION_DAYS * 24 * 60 * 60}`
  ];

  if (process.env.NODE_ENV === "production") {
    parts.push("Secure");
  }

  return parts.join("; ");
}

function expiredCookie() {
  const parts = ["sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"];
  if (process.env.NODE_ENV === "production") {
    parts.push("Secure");
  }
  return parts.join("; ");
}

function createPasswordRecord(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return { salt, hash };
}

function verifyPassword(password, salt, hash) {
  const attempt = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, "hex");
  return attempt.length === expected.length && crypto.timingSafeEqual(attempt, expected);
}

function sanitizeAvatarDataUrl(value) {
  const text = `${value ?? ""}`.trim();
  if (!text) {
    return "";
  }

  const isImage = /^data:image\/[a-zA-Z0-9.+-]+;base64,/.test(text);
  if (!isImage || text.length > MAX_AVATAR_DATA_URL_LENGTH) {
    throw createHttpError(400, "La foto de perfil no es valida.");
  }

  return text;
}

function requireText(value, min, max, message) {
  const text = `${value ?? ""}`.trim();
  if (text.length < min || text.length > max) {
    throw createHttpError(400, message);
  }
  return text;
}

function optionalText(value, min, max) {
  const text = `${value ?? ""}`.trim();
  if (!text) {
    return "";
  }
  if (text.length < min || text.length > max) {
    throw createHttpError(400, "Texto invalido.");
  }
  return text;
}

function normalizeEmail(value) {
  const email = `${value ?? ""}`.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw createHttpError(400, "Email invalido.");
  }
  return email;
}

function requirePassword(value, silentAuthFailure = false) {
  const password = `${value ?? ""}`;
  if (password.length < 8) {
    throw createHttpError(silentAuthFailure ? 401 : 400, "La contrasena debe tener al menos 8 caracteres.");
  }
  return password;
}

function requireOneOf(value, allowed, message) {
  if (!allowed.includes(value)) {
    throw createHttpError(400, message);
  }
  return value;
}

function requireMoney(value, message) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) {
    throw createHttpError(400, message);
  }
  return Math.round(amount);
}

function requireDay(value) {
  const day = Number(value);
  if (!Number.isInteger(day) || day < 1 || day > 31) {
    throw createHttpError(400, "Dia invalido.");
  }
  return day;
}

function requireDate(value, message) {
  const date = `${value ?? ""}`.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw createHttpError(400, message);
  }
  return date;
}

function parseMonthKey(value) {
  const monthKey = `${value ?? ""}`.trim();
  if (!/^\d{4}-\d{2}$/.test(monthKey)) {
    throw createHttpError(400, "Mes invalido.");
  }
  return monthKey;
}

function createInviteCodeUnique() {
  while (true) {
    const inviteCode = crypto.randomBytes(4).toString("hex").toUpperCase();
    const exists = db.prepare(`
      SELECT id
      FROM households
      WHERE invite_code = :inviteCode
    `).get({ inviteCode });
    if (!exists) {
      return inviteCode;
    }
  }
}

function randomResetCode() {
  return `${Math.floor(100000 + Math.random() * 900000)}`;
}

function hashCode(code) {
  return crypto.createHash("sha256").update(code).digest("hex");
}

function runInTransaction(work) {
  db.exec("BEGIN");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function cleanupExpiredSessions() {
  db.prepare(`
    DELETE FROM sessions
    WHERE expires_at <= :now
  `).run({ now: nowIso() });

  db.prepare(`
    DELETE FROM password_resets
    WHERE expires_at <= :now OR used_at IS NOT NULL
  `).run({ now: nowIso() });
}

function ensureColumn(table, definition) {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  } catch {
    // Column already exists or cannot be added; safe to ignore here.
  }
}

function nowIso() {
  return new Date().toISOString();
}

function currentMonthKey() {
  return new Date().toISOString().slice(0, 7);
}

function pickColorName(seed) {
  let hash = 0;
  for (const char of seed) {
    hash = (hash * 31 + char.charCodeAt(0)) % 4096;
  }
  return ACCOUNT_COLORS[hash % ACCOUNT_COLORS.length];
}

function createHttpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function getNetworkUrls(port) {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((entry) => entry && entry.family === "IPv4" && !entry.internal)
    .map((entry) => `http://${entry.address}:${port}`);
}
