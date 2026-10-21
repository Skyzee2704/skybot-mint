// SPDX-License-Identifier: AGPL-3.0-only
import { ensureDb, dbMode } from "../db/client.js";
await ensureDb();
console.log(`migrations applied (${dbMode()})`);
process.exit(0);
