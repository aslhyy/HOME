"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const sqlitePath = path.join(ROOT, "data", "home.sqlite");

if (!process.argv.includes("--confirm")) {
  console.error("Usa --confirm para borrar data/home.sqlite.");
  process.exit(1);
}

if (!fs.existsSync(sqlitePath)) {
  console.log("No existe data/home.sqlite. No hay nada que borrar.");
  process.exit(0);
}

fs.rmSync(sqlitePath, { force: true });

const dataDir = path.dirname(sqlitePath);
if (fs.existsSync(dataDir) && fs.readdirSync(dataDir).length === 0) {
  fs.rmdirSync(dataDir);
}

console.log("SQLite eliminado del proyecto.");
