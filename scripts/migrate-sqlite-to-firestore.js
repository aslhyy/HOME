"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const admin = require("firebase-admin");

const ROOT = path.resolve(__dirname, "..");
loadEnvFile(path.join(ROOT, ".env"));

const args = parseArgs(process.argv.slice(2));
const sqlitePath = path.resolve(ROOT, args.sqlitePath || "data/home.sqlite");

if (!fs.existsSync(sqlitePath)) {
  throw new Error(`No se encontro la base SQLite en ${sqlitePath}`);
}

const sqlite = new DatabaseSync(sqlitePath);
const snapshot = buildSnapshot(sqlite);
const summary = summarizeSnapshot(snapshot);

if (args.dryRun) {
  console.log("Migracion en modo simulacion.");
  printSummary(summary);
  process.exit(0);
}

initFirebase(args.serviceAccountPath);

run().catch((error) => {
  console.error("[migration:error]", error.message);
  process.exitCode = 1;
});

async function run() {
  const db = admin.firestore();

  if (args.wipe) {
    await wipeCollections(db, Object.keys(snapshot));
  }

  for (const [collectionName, docs] of Object.entries(snapshot)) {
    await writeCollection(db, collectionName, docs);
  }

  printSummary(summary);
  console.log("Migracion completada a Firestore.");
}

function buildSnapshot(db) {
  const users = db.prepare("SELECT * FROM users").all().map((row) => ({
    id: row.id,
    data: {
      name: row.name,
      email: row.email,
      passwordSalt: row.password_salt,
      passwordHash: row.password_hash,
      avatarDataUrl: row.avatar_data_url || "",
      createdAt: row.created_at
    }
  }));

  const households = db.prepare("SELECT * FROM households").all().map((row) => ({
    id: row.id,
    data: {
      name: row.name,
      currency: row.currency,
      inviteCode: row.invite_code,
      createdAt: row.created_at
    }
  }));

  const memberships = db.prepare("SELECT * FROM memberships").all().map((row) => ({
    id: row.id,
    data: {
      householdId: row.household_id,
      userId: row.user_id,
      role: row.role,
      joinedAt: row.joined_at
    }
  }));

  const transactions = db.prepare("SELECT * FROM transactions").all().map((row) => ({
    id: row.id,
    data: {
      householdId: row.household_id,
      accountId: row.account_id,
      actorUserId: row.actor_user_id,
      planItemId: row.plan_item_id || null,
      kind: row.kind,
      category: row.category,
      amount: row.amount,
      note: row.note || "",
      occurredOn: row.occurred_on,
      monthKey: `${row.occurred_on}`.slice(0, 7),
      createdAt: row.created_at
    }
  }));

  const balanceDeltas = new Map();
  transactions.forEach((transaction) => {
    const current = balanceDeltas.get(transaction.data.accountId) || 0;
    const next = current + (transaction.data.kind === "income" ? transaction.data.amount : -transaction.data.amount);
    balanceDeltas.set(transaction.data.accountId, next);
  });

  const accounts = db.prepare("SELECT * FROM accounts").all().map((row) => ({
    id: row.id,
    data: {
      householdId: row.household_id,
      ownerUserId: row.owner_user_id || null,
      name: row.name,
      type: row.type,
      openingBalance: row.opening_balance,
      currentBalance: row.opening_balance + (balanceDeltas.get(row.id) || 0),
      colorName: row.color_name,
      createdAt: row.created_at
    }
  }));

  const planTemplates = db.prepare("SELECT * FROM plan_templates").all().map((row) => ({
    id: row.id,
    data: {
      householdId: row.household_id,
      ownerUserId: row.owner_user_id || null,
      kind: row.kind,
      title: row.title,
      category: row.category,
      amount: row.amount,
      dueDay: row.due_day,
      active: Boolean(row.active),
      createdAt: row.created_at
    }
  }));

  const planItems = db.prepare("SELECT * FROM plan_items").all().map((row) => ({
    id: row.id,
    data: {
      householdId: row.household_id,
      ownerUserId: row.owner_user_id || null,
      templateId: row.template_id || null,
      kind: row.kind,
      title: row.title,
      category: row.category,
      amount: row.amount,
      dueDay: row.due_day,
      monthKey: row.month_key,
      completedTransactionId: row.completed_transaction_id || null,
      completedAt: row.completed_at || null,
      createdAt: row.created_at
    }
  }));

  const sessions = db.prepare("SELECT * FROM sessions").all().map((row) => ({
    id: row.id,
    data: {
      userId: row.user_id,
      expiresAt: row.expires_at,
      createdAt: row.created_at
    }
  }));

  const passwordResets = db.prepare("SELECT * FROM password_resets").all().map((row) => ({
    id: row.id,
    data: {
      userId: row.user_id,
      codeHash: row.code_hash,
      expiresAt: row.expires_at,
      usedAt: row.used_at || null,
      createdAt: row.created_at
    }
  }));

  return {
    users,
    households,
    memberships,
    accounts,
    planTemplates,
    planItems,
    transactions,
    sessions,
    passwordResets
  };
}

function summarizeSnapshot(snapshot) {
  const summary = {};
  for (const [collectionName, docs] of Object.entries(snapshot)) {
    summary[collectionName] = docs.length;
  }
  summary.userEmails = snapshot.users.map((entry) => entry.data.email);
  return summary;
}

function printSummary(summary) {
  console.log("Resumen de migracion:");
  Object.entries(summary).forEach(([key, value]) => {
    if (key === "userEmails") {
      return;
    }
    console.log(`- ${key}: ${value}`);
  });
  console.log(`- users.email: ${summary.userEmails.join(", ")}`);
}

async function wipeCollections(db, collectionNames) {
  for (const collectionName of collectionNames) {
    const refs = await db.collection(collectionName).listDocuments();
    if (!refs.length) {
      continue;
    }

    for (let index = 0; index < refs.length; index += 400) {
      const batch = db.batch();
      refs.slice(index, index + 400).forEach((ref) => batch.delete(ref));
      await batch.commit();
    }
  }
}

async function writeCollection(db, collectionName, docs) {
  for (let index = 0; index < docs.length; index += 400) {
    const batch = db.batch();
    docs.slice(index, index + 400).forEach((entry) => {
      batch.set(db.collection(collectionName).doc(entry.id), entry.data);
    });
    await batch.commit();
  }
}

function initFirebase(serviceAccountPath) {
  if (serviceAccountPath) {
    const resolvedPath = path.resolve(ROOT, serviceAccountPath);
    process.env.GOOGLE_APPLICATION_CREDENTIALS = resolvedPath;
  }

  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    admin.initializeApp({
      credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
    });
    return;
  }

  admin.initializeApp();
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
      ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  });
}

function parseArgs(rawArgs) {
  const parsed = {
    dryRun: false,
    wipe: false,
    sqlitePath: "",
    serviceAccountPath: ""
  };

  rawArgs.forEach((arg) => {
    if (arg === "--dry-run") parsed.dryRun = true;
    if (arg === "--wipe") parsed.wipe = true;
    if (arg.startsWith("--sqlite=")) parsed.sqlitePath = arg.slice("--sqlite=".length);
    if (arg.startsWith("--service-account=")) parsed.serviceAccountPath = arg.slice("--service-account=".length);
  });

  return parsed;
}
