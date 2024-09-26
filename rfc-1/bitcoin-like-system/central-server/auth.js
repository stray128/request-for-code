const db = require('./database');

function authenticateUser(publicAddress, privateAddress, callback) {
    db.get(`SELECT * FROM customers WHERE publicAddress = ? AND privateAddress = ?`, [publicAddress, privateAddress], (err, row) => {
        if (err) {
            return callback(err);
        }
        if (row) {
            return callback(null, row);
        } else {
            db.get(`SELECT * FROM miners WHERE publicAddress = ? AND privateAddress = ?`, [publicAddress, privateAddress], (err, row) => {
                if (err) {
                    return callback(err);
                }
                if (row) {
                    return callback(null, row);
                } else {
                    return callback(new Error('Invalid credentials'));
                }
            });
        }
    });
}

function registerUser(publicAddress, privateAddress, isMiner, callback) {
    const table = isMiner ? 'miners' : 'customers';
    db.run(`INSERT INTO ${table} (publicAddress, privateAddress) VALUES (?, ?)`, [publicAddress, privateAddress], (err) => {
        if (err) {
            return callback(err);
        }
        return callback(null);
    });
}

module.exports = {
    authenticateUser,
    registerUser
};