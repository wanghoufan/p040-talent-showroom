import { readConfig } from '../config.mjs';
import { openDatabase } from './database.mjs';
const db = openDatabase(readConfig().dbPath);
db.close();
console.log('Migrations applied');
