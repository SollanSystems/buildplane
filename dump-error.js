import Database from "better-sqlite3";
import { join } from "path";

const db = new Database(join("/private/var/folders/5c/0syjh_4x2_l1vt90ycjf6xbc0000gn/T/bp-debug-tNNYdW", ".buildplane", "state.db"));
console.log(db.prepare("SELECT * FROM runs").all());
