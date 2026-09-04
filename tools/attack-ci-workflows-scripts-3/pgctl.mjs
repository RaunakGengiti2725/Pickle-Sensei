#!/usr/bin/env node
// Tiny psql stand-in for the harnesses (no psql binary on the runners):
//   pgctl.mjs create-db <admin-url> <dbname>   — fresh, EMPTY database (no migrations)
//   pgctl.mjs drop-db   <admin-url> <dbname>
//   pgctl.mjs sql       <url> "<statement>"    — prints rows as JSON lines
// Uses the `pg` driver already installed for services/api; never touches
// anything but the local docker Postgres the caller points it at.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, "../../services/api/package.json"));
const { Client } = require("pg");

const [cmd, url, arg] = process.argv.slice(2);
if (!cmd || !url || !arg) {
  console.error("usage: pgctl.mjs <create-db|drop-db|sql> <url> <dbname|statement>");
  process.exit(64);
}
if (!/^postgres(ql)?:\/\/[^@]+@(localhost|127\.0\.0\.1)(:\d+)?\//.test(url)) {
  console.error("refusing: pgctl only talks to localhost");
  process.exit(65);
}
const ident = (s) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error(`bad identifier ${s}`);
  return `"${s}"`;
};

const client = new Client({ connectionString: url });
await client.connect();
try {
  if (cmd === "create-db") {
    await client.query(`DROP DATABASE IF EXISTS ${ident(arg)} WITH (FORCE)`);
    await client.query(`CREATE DATABASE ${ident(arg)}`);
  } else if (cmd === "drop-db") {
    await client.query(`DROP DATABASE IF EXISTS ${ident(arg)} WITH (FORCE)`);
  } else if (cmd === "sql") {
    const res = await client.query(arg);
    for (const row of res.rows) console.log(JSON.stringify(row));
  } else {
    throw new Error(`unknown command ${cmd}`);
  }
} finally {
  await client.end();
}
