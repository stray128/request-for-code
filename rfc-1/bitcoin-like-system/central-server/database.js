const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./blockchain.db');

db.serialize(() => {
    // Create tables for miners and customers
    db.run(`CREATE TABLE IF NOT EXISTS miners (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        publicAddress TEXT UNIQUE,
        privateAddress TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS customers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        publicAddress TEXT UNIQUE,
        privateAddress TEXT
    )`);
});

module.exports = db;