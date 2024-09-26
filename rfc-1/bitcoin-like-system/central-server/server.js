const WebSocket = require('ws');
const express = require('express');
const bodyParser = require('body-parser');
const CryptoJS = require('crypto-js');
const db = require('./database');
const auth = require('./auth'); // Import the auth module
const cors = require('cors');

const WS_PORT = 8080;
const HTTP_PORT = 3000;

const wsServer = new WebSocket.Server({ port: WS_PORT });
const app = express();

// Detailed CORS configuration
const corsOptions = {
  origin: 'http://localhost:8000',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
  optionsSuccessStatus: 200
};

app.use(cors(corsOptions));
app.use(bodyParser.json());
app.use(express.json());

const GENESIS_BLOCK = {
    index: 0,
    timestamp: 1726975000000,
    transactions: [],
    previousHash: "0",
    hash: "000000000000000000000000000000000000000000000000000000000000000000",
    nonce: 0
};

let longestChain = [GENESIS_BLOCK];
const clients = new Set();
const activeMiners = new Set();
const difficulty = 4;

const users = new Map(); // Store user information (in-memory for simplicity)

let pendingTransactions = [];

function log(type, data) {
    const logEntry = {
        timestamp: new Date().toISOString(),
        type: type,
        data: data
    };
    console.log(JSON.stringify(logEntry));
}

function isValidProofOfWork(block) {
    const hash = calculateHashForBlock(block);
    return hash.substring(0, difficulty) === '0'.repeat(difficulty);
}

function calculateHashForBlock(block) {
    return CryptoJS.SHA256(
        block.index +
        block.previousHash +
        block.timestamp +
        JSON.stringify(block.transactions) +
        block.nonce
    ).toString();
}

function isValidChain(chain) {
    if (JSON.stringify(chain[0]) !== JSON.stringify(GENESIS_BLOCK)) {
        log('VALIDATION_FAILED', { 
            reason: 'Invalid genesis block',
            receivedGenesis: JSON.stringify(chain[0]),
            expectedGenesis: JSON.stringify(GENESIS_BLOCK)
        });
        return false;
    }
    // Start from the last block
    for (let i = chain.length - 1; i > 0; i--) {
        const currentBlock = chain[i];
        const previousBlock = chain[i - 1];

        // Check if the current block's previousHash matches the hash of the previous block
        if (currentBlock.previousHash !== previousBlock.hash) {
            log('VALIDATION_FAILED', { reason: 'Invalid previous hash', blockIndex: i });
            return false;
        }

        if (currentBlock.index !== previousBlock.index + 1) {
            log('VALIDATION_FAILED', { reason: 'Invalid index', blockIndex: i });
            return false;
        }

        if (currentBlock.timestamp <= previousBlock.timestamp) {
            log('VALIDATION_FAILED', { reason: 'Invalid timestamp', blockIndex: i });
            return false;
        }

        if (!isValidProofOfWork(currentBlock)) {
            log('VALIDATION_FAILED', { reason: 'Invalid proof of work', blockIndex: i });
            return false;
        }

        const calculatedHash = calculateHashForBlock(currentBlock);
        if (calculatedHash !== currentBlock.hash) {
            log('VALIDATION_FAILED', { 
                reason: 'Invalid hash', 
                blockIndex: i, 
                calculatedHash: calculatedHash, 
                blockHash: currentBlock.hash 
            });
            return false;
        }

        // Check the proof of work
        if (!isValidProofOfWork(currentBlock)) {
            log('VALIDATION_FAILED', { reason: 'Invalid proof of work', blockIndex: i });
            return false;
        }
    }

    // If we've made it through all blocks without returning false, the chain is valid
    return true;
}

function updateLongestChain(newChain) {
    if (!isValidChain(newChain)) {
        log('BLOCKCHAIN_REJECTED', { reason: 'Invalid chain' });
        return false;
    }

    if (newChain.length > longestChain.length || 
        (newChain.length === longestChain.length && 
         newChain[newChain.length - 1].timestamp < longestChain[longestChain.length - 1].timestamp)) {
        log('BLOCKCHAIN_UPDATED', { 
            reason: 'Longer or equal length with earlier timestamp', 
            newLength: newChain.length,
            oldLength: longestChain.length
        });
        longestChain = newChain;
        broadcast(JSON.stringify({type: 'BLOCKCHAIN', chain: longestChain}));
        return true;
    } else {
        log('BLOCKCHAIN_REJECTED', { 
            reason: 'Not longer or not earlier',
            newLength: newChain.length,
            currentLength: longestChain.length
        });
        return false;
    }
}

function calculateBalance(address) {
    let balance = 0;
    for (const block of longestChain) {
        for (const transaction of block.transactions) {
            if (transaction.from === address) {
                balance -= transaction.amount;
            }
            if (transaction.to === address) {
                balance += transaction.amount;
            }
        }
    }
    return balance;
}

wsServer.on('connection', (ws) => {
    const clientId = Date.now().toString(36) + Math.random().toString(36).substr(2);
    clients.add(ws);
    log('CONNECTION', { clientId: clientId, totalClients: clients.size });

    // Send the current blockchain to the new node
    ws.send(JSON.stringify({
        type: 'BLOCKCHAIN',
        chain: longestChain
    }));

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            log('MESSAGE_RECEIVED', { clientId: clientId, type: data.type });

            if (data.type === 'BLOCKCHAIN') {
                updateLongestChain(data.chain);
            } else if (data.type === 'GET_BLOCKCHAIN' && longestChain) {
                ws.send(JSON.stringify({
                    type: 'BLOCKCHAIN',
                    chain: longestChain
                }));
                log('BLOCKCHAIN_SENT', { clientId: clientId, chainLength: longestChain.length });
            } else if (data.type === 'TRANSACTION') {
                broadcast(message);
                log('TRANSACTION_BROADCAST', { from: data.transaction.from, to: data.transaction.to, amount: data.transaction.amount });
            } else if (data.type === 'REGISTER_MINER') {
                const { publicAddress, privateAddress } = data;
                auth.registerUser(publicAddress, privateAddress, true, (err) => {
                    if (err) {
                        log('ERROR', { message: err.message });
                        ws.send(JSON.stringify({ type: 'REGISTRATION_FAILED', message: err.message }));
                    } else {
                        log('MINER_REGISTERED', { publicAddress: publicAddress });
                        activeMiners.add(ws);
                        broadcastActiveMinersCount();
                        // After successful registration, immediately log in the user
                        auth.authenticateUser(publicAddress, privateAddress, (loginErr, user) => {
                            if (loginErr) {
                                log('ERROR', { message: loginErr.message });
                                ws.send(JSON.stringify({ type: 'LOGIN_FAILED', message: 'Registration successful, but login failed' }));
                            } else {
                                log('LOGIN_SUCCESS', { publicAddress: publicAddress });
                                ws.send(JSON.stringify({ 
                                    type: 'REGISTRATION_AND_LOGIN_SUCCESS', 
                                    user: user,
                                    message: 'Miner registered and logged in successfully'
                                }));
                            }
                        });
                    }
                });
            } else if (data.type === 'REGISTER_CUSTOMER') {
                const { publicAddress, privateAddress } = data;
                auth.registerUser(publicAddress, privateAddress, false, (err) => {
                    if (err) {
                        log('ERROR', { message: err.message });
                    } else {
                        log('CUSTOMER_REGISTERED', { publicAddress: publicAddress });
                    }
                });
            } else if (data.type === 'LOGIN') {
                const { publicAddress, privateAddress } = data;
                auth.authenticateUser(publicAddress, privateAddress, (err, user) => {
                    if (err) {
                        log('ERROR', { message: err.message });
                        ws.send(JSON.stringify({ type: 'LOGIN_FAILED', message: 'Invalid credentials' }));
                    } else {
                        log('LOGIN_SUCCESS', { publicAddress: publicAddress });
                        ws.send(JSON.stringify({ type: 'LOGIN_SUCCESS', user: user }));
                    }
                });
            } else if (data.type === 'BLOCK') {
                const newBlock = data.block;
                const newChain = longestChain.concat(newBlock);
                updateLongestChain(newChain);
            }
        } catch (error) {
            log('ERROR', { message: error.message, stack: error.stack });
        }
    });

    ws.on('close', () => {
        clients.delete(ws);
        activeMiners.delete(ws);
        log('DISCONNECTION', { clientId: clientId, totalClients: clients.size });
        broadcastActiveMinersCount();
    });
});

function broadcast(message, sender) {
    clients.forEach(client => {
        if (client !== sender && client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
    log('BROADCAST', { messageType: JSON.parse(message).type, recipients: clients.size - (sender ? 1 : 0) });
}

function broadcastActiveMinersCount() {
    const count = activeMiners.size;
    wsServer.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: 'ACTIVE_MINERS_UPDATE', count }));
        }
    });
}

function broadcastToMiners(message) {
    wsServer.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

// Add this new endpoint to get the current blockchain
app.get('/blockchain', (req, res) => {
    log('BLOCKCHAIN_REQUESTED', { method: 'HTTP' });
    res.json({
        chain: longestChain,
        length: longestChain.length
    });
});

// Add this new endpoint to get the balance of an address
app.get('/balance/:address', (req, res) => {
    const address = req.params.address;
    const balance = calculateBalance(address);
    log('BALANCE_REQUESTED', { address: address, balance: balance });
    res.json({ address: address, balance: balance });
});

// Add this new endpoint to get all miners
app.get('/miners', (req, res) => {
    db.all(`SELECT * FROM miners`, [], (err, rows) => {
        if (err) {
            log('ERROR', { message: err.message });
            res.status(500).json({ error: err.message });
            return;
        }
        res.json({ miners: rows });
    });
});

// Add this new endpoint to get all customers
app.get('/customers', (req, res) => {
    db.all(`SELECT * FROM customers`, [], (err, rows) => {
        if (err) {
            log('ERROR', { message: err.message });
            res.status(500).json({ error: err.message });
            return;
        }
        res.json({ customers: rows });
    });
});

// Login endpoint
app.post('/login', (req, res) => {
    console.log('Login attempt received:', req.body);
    const { publicKey, privateKey } = req.body;
    
    auth.authenticateUser(publicKey, privateKey, (err, user) => {
        if (err) {
            console.error('Authentication error:', err);
            return res.status(401).json({ success: false, message: 'Invalid credentials' });
        }
        
        console.log('User authenticated:', user);
        res.json({ success: true, message: 'Login successful', user });
    });
});

// Get active nodes endpoint
app.get('/active-nodes', (req, res) => {
    const activeNodesCount = activeMiners.size;
    log('ACTIVE_MINERS_REQUESTED', { count: activeNodesCount });
    res.json({ count: activeNodesCount });
});

// HTTP endpoint for getting active miners count
app.get('/active-miners', (req, res) => {
    const activeMinersCount = activeMiners.size;
    log('ACTIVE_MINERS_REQUESTED', { count: activeMinersCount });
    res.json({ count: activeMinersCount });
});

// Faucet endpoint
app.post('/faucet', (req, res) => {
    console.log('Faucet request received:', req.body);
    const { address } = req.body;
    const faucetAmount = 100; // or whatever amount you want to give

    // Add faucet amount to the address's balance
    // This is a simplified version. You should implement proper balance management
    const transaction = {
        from: null, // null indicates it's from the faucet
        to: address,
        amount: faucetAmount,
        timestamp: Date.now()
    };

    // Add the transaction to pending transactions
    pendingTransactions.push(transaction);

    // Broadcast the transaction to all connected clients
    broadcastToMiners(JSON.stringify({
        type: 'TRANSACTION',
        transaction: transaction
    }));

    res.json({ success: true, message: `${faucetAmount} coins ==> ${address} added in pending transactions` });
});

app.get('/blockchain-details', (req, res) => {
    let totalFauceted = 0;
    let totalMiningRewards = 0;
    const blockchainLength = longestChain.length;
    const blockReward = 10; // Make sure this matches your actual mining reward

    // Start from index 1 to skip genesis block
    for (let i = 1; i < longestChain.length; i++) {
        const block = longestChain[i];
        block.transactions.forEach(tx => {
            if (tx.from === null) {
                if (tx.amount === blockReward) {
                    totalMiningRewards += tx.amount;
                } else {
                    totalFauceted += tx.amount;
                }
            }
        });
    }

    res.json({
        totalFauceted,
        totalMiningRewards,
        blockchainLength,
        blockReward
    });
});

app.get('/addresses', (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = 10;
    const offset = (page - 1) * limit;

    db.all(`SELECT publicAddress FROM miners UNION SELECT publicAddress FROM customers ORDER BY publicAddress LIMIT ? OFFSET ?`, [limit, offset], (err, rows) => {
        if (err) {
            log('ERROR', { message: err.message });
            res.status(500).json({ error: err.message });
            return;
        }
        db.get(`SELECT COUNT(*) as total FROM (SELECT publicAddress FROM miners UNION SELECT publicAddress FROM customers)`, [], (err, count) => {
            if (err) {
                log('ERROR', { message: err.message });
                res.status(500).json({ error: err.message });
                return;
            }
            res.json({ 
                addresses: rows.map(row => row.publicAddress),
                totalPages: Math.ceil(count.total / limit),
                currentPage: page
            });
        });
    });
});

// Start the HTTP server
app.listen(HTTP_PORT, () => {
    log('HTTP_SERVER_STARTED', { port: HTTP_PORT });
});

log('WEBSOCKET_SERVER_STARTED', { port: WS_PORT });
