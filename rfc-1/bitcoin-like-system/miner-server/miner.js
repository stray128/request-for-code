const WebSocket = require('ws');
const express = require('express');
const bodyParser = require('body-parser');
const readlineSync = require('readline-sync');
const CryptoJS = require('crypto-js');

const CENTRAL_SERVER = 'ws://localhost:8080';
const DIFFICULTY = 4;
const HTTP_PORT = process.env.HTTP_PORT || 3001;
const WS_PORT = process.env.WS_PORT || 8081;


// Define a common genesis block for all miners
const GENESIS_BLOCK = {
    index: 0,
    timestamp: 1726975000000, // Use a fixed timestamp for the genesis block
    transactions: [],
    previousHash: "0",
    hash: "000000000000000000000000000000000000000000000000000000000000000000",
    nonce: 0
};

function log(type, data) {
    const logEntry = {
        timestamp: new Date().toISOString(),
        type: type,
        data: data
    };
    console.log(JSON.stringify(logEntry));
}

class Block {
    constructor(index, timestamp, transactions, previousHash, hash, nonce) {
        this.index = index;
        this.timestamp = timestamp;
        this.transactions = transactions;
        this.previousHash = previousHash;
        this.hash = hash || this.calculateHash(); // Initialize hash if not provided
        this.nonce = nonce || 0;
    }

    calculateHash() {
        return CryptoJS.SHA256(
            this.index +
            this.previousHash +
            this.timestamp +
            JSON.stringify(this.transactions) +
            this.nonce
        ).toString();
    }

    mineBlock(difficulty) {
        while (this.hash.substring(0, difficulty) !== Array(difficulty + 1).join('0')) {
            this.nonce++;
            this.hash = this.calculateHash();
        }
        console.log(`Block mined: ${this.hash}`);
    }
}

const MIN_MINING_INTERVAL = 6000;

class Blockchain {
    constructor() {
        this.chain = [this.createGenesisBlock()];
        this.pendingTransactions = [];
        this.difficulty = DIFFICULTY;
        this.miningReward = 10;
        this.balances = new Map();
        this.balances.set(minerAddress, 0);
    }

    createGenesisBlock() {
        return new Block(
            GENESIS_BLOCK.index,
            GENESIS_BLOCK.timestamp,
            GENESIS_BLOCK.transactions,
            GENESIS_BLOCK.previousHash,
            GENESIS_BLOCK.hash,
            GENESIS_BLOCK.nonce
        );
    }

    getLatestBlock() {
        return this.chain[this.chain.length - 1];
    }


    addTransaction(transaction) {
        
        if (!this.isValidTransaction(transaction)) {
            throw new Error('Invalid transaction');
        }

        if (transaction.from === null) {
            // This is a faucet transaction
            if (!transaction.to) {
                throw new Error('Faucet transaction must include a to address');
            }
            console.log('Faucet transaction received');
            this.pendingTransactions.push(transaction);
            return;
        }

        const senderBalance = this.getBalance(transaction.from);
        console.log(`Attempting transaction: ${JSON.stringify(transaction)}`);
        console.log(`Sender balance: ${senderBalance}`);
        if (senderBalance >= transaction.amount) {
            this.pendingTransactions.push(transaction);
            console.log('Transaction added successfully');
            global.broadcastToClients({ type: 'NEW_TRANSACTION', transaction });
        } else {
            console.log(`Error adding transaction: Not enough balance. Required: ${transaction.amount}, Available: ${senderBalance}`);
            throw new Error('Not enough balance');
        }
    }


    isValidChain(chain) {
        if (JSON.stringify(chain[0]) !== JSON.stringify(GENESIS_BLOCK)) {
            log('VALIDATION_FAILED', { 
                reason: 'Invalid genesis block',
                receivedGenesis: JSON.stringify(chain[0]),
                expectedGenesis: JSON.stringify(GENESIS_BLOCK)
            });
            return false;
        }

        for (let i = chain.length - 1; i > 0; i--) {
            const currentBlock = chain[i];
            const previousBlock = chain[i - 1];

            if (currentBlock.previousHash !== previousBlock.hash) {
                console.log('VALIDATION_FAILED', { 
                    reason: 'Invalid previous hash', 
                    blockIndex: i,
                    expectedHash: previousBlock.hash,
                    actualHash: currentBlock.previousHash
                });
                return false;
            }

            if (currentBlock.index !== previousBlock.index + 1) {
                console.log('VALIDATION_FAILED', { 
                    reason: 'Invalid index', 
                    blockIndex: i,
                    expectedIndex: previousBlock.index + 1,
                    actualIndex: currentBlock.index
                });
                return false;
            }

            if (currentBlock.timestamp <= previousBlock.timestamp) {
                console.log('VALIDATION_FAILED', { 
                    reason: 'Invalid timestamp', 
                    blockIndex: i,
                    previousTimestamp: previousBlock.timestamp,
                    currentTimestamp: currentBlock.timestamp
                });
                return false;
            }

            const calculatedHash = this.calculateHashForBlock(currentBlock);
            if (calculatedHash !== currentBlock.hash) {
                console.log('VALIDATION_FAILED', { 
                    reason: 'Invalid hash', 
                    blockIndex: i, 
                    calculatedHash: calculatedHash, 
                    blockHash: currentBlock.hash 
                });
                return false;
            }

            if (!this.isValidProofOfWork(currentBlock)) {
                console.log('VALIDATION_FAILED', { 
                    reason: 'Invalid proof of work', 
                    blockIndex: i,
                    blockHash: currentBlock.hash,
                    difficulty: this.difficulty
                });
                return false;
            }
        }

        console.log('Chain validation successful');
        return true;
    }

    calculateHashForBlock(block) {
        return CryptoJS.SHA256(
            block.index +
            block.previousHash +
            block.timestamp +
            JSON.stringify(block.transactions) +
            block.nonce
        ).toString();
    }

    isValidProofOfWork(block) {
        const hash = this.calculateHashForBlock(block);
        return hash.substring(0, this.difficulty) === '0'.repeat(this.difficulty);
    }

    replaceChain(newChain) {
        if (!this.isValidChain(newChain)) {
            log('BLOCKCHAIN_REJECTED', { reason: 'Invalid chain received from central server' });
            return false;
        }

        if (newChain.length > this.chain.length) {
            log('BLOCKCHAIN_UPDATED', { reason: 'Longer chain received from central server', newLength: newChain.length });
            this.chain = newChain;
            return true;
        } else if (newChain.length === this.chain.length) {
            const currentLastBlock = this.chain[this.chain.length - 1];
            const newLastBlock = newChain[newChain.length - 1];
            
            if (newLastBlock.timestamp < currentLastBlock.timestamp) {
                log('BLOCKCHAIN_UPDATED', { reason: 'Equal length, earlier timestamp received from central server', newLength: newChain.length });
                this.chain = newChain;
                return true;
            } else {
                log('BLOCKCHAIN_REJECTED', { reason: 'Equal length, not earlier received from central server' });
                return false;
            }
        } else {
            log('BLOCKCHAIN_REJECTED', { reason: 'Shorter chain received from central server' });
            return false;
        }
    }

    isValidNewBlock(newBlock, previousBlock) {
        if (previousBlock.index + 1 !== newBlock.index) {
            return false;
        } else if (previousBlock.hash !== newBlock.previousHash) {
            return false;
        } else if (newBlock.calculateHash() !== newBlock.hash) {
            return false;
        }
        return true;
    }

    addBlock(newBlock) {
        const latestBlock = this.getLatestBlock();
        
        if (latestBlock.index + 1 !== newBlock.index) {
            console.log('Block rejected: Invalid index');
            return false;
        }
        
        if (latestBlock.hash !== newBlock.previousHash) {
            console.log('Block rejected: Invalid previous hash');
            return false;
        }
        
        const calculatedHash = newBlock.calculateHash();
        if (calculatedHash !== newBlock.hash) {
            console.log('Block rejected: Invalid hash');
            console.log('Calculated:', calculatedHash);
            console.log('Provided:', newBlock.hash);
            return false;
        }
        
        if (!this.isValidTimestamp(newBlock, latestBlock)) {
            console.log('Block rejected: Invalid timestamp');
            return false;
        }
        
        if (!this.hasValidTransactions(newBlock)) {
            console.log('Block rejected: Invalid transactions');
            return false;
        }
        
        this.chain.push(newBlock);
        console.log('Block added to chain');
        
        return true;
    }

    isValidTimestamp(newBlock, previousBlock) {
        const minTimeBetweenBlocks = MIN_MINING_INTERVAL;
        const currentTime = Date.now();
        const earliestValidTimestamp = previousBlock.timestamp + minTimeBetweenBlocks;
        const latestValidTimestamp = currentTime + 60000;

        const isValid = (newBlock.timestamp > earliestValidTimestamp) && 
                        (newBlock.timestamp <= latestValidTimestamp);

        if (!isValid) {
            console.log(`Invalid timestamp for block ${newBlock.index}`);
        }

        return isValid;
    }

    hasValidTransactions(block) {
        for (const tx of block.transactions) {
            if (!this.isValidTransaction(tx)) {
                return false;
            }
        }
        return true;
    }

    isValidTransaction(transaction) {
        if (!transaction.to || !transaction.amount) {
            return false;
        }
        return true;
    }

    getBalance(address) {
        let balance = 0;
        for (const block of this.chain) {
            for (const transaction of block.transactions) {
                if (transaction.from === address) {
                    balance -= transaction.amount;
                }
                if (transaction.to === address) {
                    balance += transaction.amount;
                }
            }
        }
        console.log(`Balance for ${address}: ${balance}`); // Add this log
        return balance;
    }
}

let ws;
let minerAddress;

function connectToCentralServer() {
    return new Promise((resolve, reject) => {
        ws = new WebSocket(CENTRAL_SERVER);
        ws.on('open', () => {
            console.log('Connected to central server');
            resolve();
        });
        ws.on('error', (error) => {
            console.error('WebSocket connection error:', error);
            reject(error);
        });
    });
}

function authenticateWithCentralServer(publicAddress, privateAddress, isNewUser) {
    return new Promise((resolve, reject) => {
        const messageType = isNewUser ? 'REGISTER_MINER' : 'LOGIN';
        const message = JSON.stringify({
            type: messageType,
            publicAddress: publicAddress,
            privateAddress: privateAddress
        });

        ws.send(message);

        const responseHandler = (response) => {
            const data = JSON.parse(response);
            if (data.type === 'LOGIN_SUCCESS' || data.type === 'REGISTRATION_AND_LOGIN_SUCCESS') {
                resolve(data);
            } else if (data.type === 'LOGIN_FAILED' || data.type === 'REGISTRATION_FAILED') {
                reject(new Error(data.message));
            } else {
                // If it's not an auth response, ignore it
                return;
            }
            ws.removeListener('message', responseHandler);
        };

        ws.on('message', responseHandler);
    });
}

async function main() {
    const hasExistingAddresses = readlineSync.keyInYN('Do you have existing addresses?');

    let publicAddress, privateAddress;

    if (hasExistingAddresses) {
        publicAddress = readlineSync.question('Enter your public address: ');
        privateAddress = readlineSync.question('Enter your private address: ', { hideEchoBack: true });
    } else {
        publicAddress = CryptoJS.SHA256(Date.now().toString() + Math.random().toString()).toString();
        privateAddress = CryptoJS.SHA256(Date.now().toString() + Math.random().toString()).toString();

        console.log('Your new public address:', publicAddress);
        console.log('Your new private address:', privateAddress);
    }

    try {
        await connectToCentralServer();
        const authResult = await authenticateWithCentralServer(publicAddress, privateAddress, !hasExistingAddresses);
        console.log(hasExistingAddresses ? 'Authentication successful' : 'Registration and login successful');
        minerAddress = publicAddress;
        startMiner(authResult.user);
    } catch (error) {
        console.error(hasExistingAddresses ? 'Authentication failed:' : 'Registration failed:', error.message);
        process.exit(1);
    }
}

function startMiner(user) {
    console.log('Miner server started');
    console.log(`Miner WebSocket server running on port ${WS_PORT}`);
    console.log(`Miner HTTP server running on port ${HTTP_PORT}`);
    console.log('Logged in as:', user);

    // Initialize blockchain
    const blockchain = new Blockchain();

    // WebSocket server for clients
    const wss = new WebSocket.Server({ port: WS_PORT });

    let isMining = false;
    let miningInterval;
    let isSyncing = true;  // Add this flag to prevent mining before syncing

    // HTTP server setup
    const app = express();
    app.use(bodyParser.json());

    // Add these routes to view the blockchain and pending transactions
    app.get('/blockchain', (req, res) => {
        res.json(blockchain.chain);
    });

    app.get('/pending-transactions', (req, res) => {
        res.json(blockchain.pendingTransactions);
    });

    app.post('/transaction', (req, res) => {
        try {
            blockchain.addTransaction(req.body);
            res.json({ message: 'Transaction added successfully' });
        } catch (error) {
            res.status(400).json({ error: error.message });
        }
    });

    app.get('/balance/:address', (req, res) => {
        const balance = blockchain.getBalance(req.params.address);
        res.json({ balance });
    });

    ws.on('message', (message) => {
        const data = JSON.parse(message);
        if (data.type === 'BLOCKCHAIN') {
            if (JSON.stringify(data.chain[0]) !== JSON.stringify(GENESIS_BLOCK)) {
                console.error('Received invalid genesis block from central server');
                console.error('Received:', JSON.stringify(data.chain[0]));
                console.error('Expected:', JSON.stringify(GENESIS_BLOCK));
            } else {
                const receivedChain = data.chain.map(blockData => {
                    // Reconstruct all blocks as Block instances
                    return new Block(
                        blockData.index,
                        blockData.timestamp,
                        blockData.transactions,
                        blockData.previousHash,
                        blockData.hash, // Use the provided hash
                        blockData.nonce
                    );
                });
                const chainReplaced = blockchain.replaceChain(receivedChain);
                if (chainReplaced) {
                    if (isMining) {
                        clearInterval(miningInterval);
                    }
                }
                startMining();

                if (isSyncing) {
                    isSyncing = false;
                    startMining();
                }
            }
        } else if (data.type === 'TRANSACTION') {
            try {
                blockchain.addTransaction(data.transaction);
                console.log('New transaction added to pending transactions');
            } catch (error) {
                console.error('Error adding transaction:', error.message);
            }
        }
    });

    wss.on('connection', (ws) => {
        console.log('New client connected');
        
        ws.on('close', () => {
            console.log('Client disconnected');
        });
    });

    function broadcastToClients(message) {
        wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify(message));
            }
        });
    }

    global.broadcastToClients = broadcastToClients;

    function broadcastBlockchain() {
        ws.send(JSON.stringify({
            type: 'BLOCKCHAIN',
            chain: blockchain.chain
        }));
    }

    async function mine() {
        const lastBlock = blockchain.getLatestBlock();
        const currentTime = Date.now();
        const timeSinceLastBlock = currentTime - lastBlock.timestamp;
        
        if (timeSinceLastBlock < MIN_MINING_INTERVAL) {
            // console.log(`Waiting ${MIN_MINING_INTERVAL - timeSinceLastBlock}ms before mining next block`);
            return;
        }

        const newBlock = new Block(
            lastBlock.index + 1,
            currentTime,
            [...blockchain.pendingTransactions],
            lastBlock.hash,
            null,
            0
        );

        console.log(`Mining block ${newBlock.index}...`);
        newBlock.mineBlock(blockchain.difficulty);

        if (blockchain.addBlock(newBlock)) {
            console.log(`Block ${newBlock.index} mined and added: ${newBlock.hash}`);
            broadcastBlockchain();
            broadcastToClients({ type: 'BLOCK', block: newBlock });
            blockchain.pendingTransactions = [
                { from: null, to: minerAddress, amount: blockchain.miningReward }
            ];
        } else {
            console.log(`Block ${newBlock.index} rejected after mining`);
        }
    }

    function startMining() {
        if (isSyncing) return;
        isMining = true;
        
        async function miningLoop() {
            if (!isMining) return;

            await mine();

            const minWaitTime = MIN_MINING_INTERVAL;
            const additionalRandomTime = Math.floor(Math.random() * 20000);
            const nextMiningTime = minWaitTime + additionalRandomTime;

            // console.log(`Next mining attempt in ${nextMiningTime}ms`);
            
            setTimeout(miningLoop, nextMiningTime);
        }

        miningLoop();
    }

    // Start the HTTP server
    app.listen(HTTP_PORT, () => {
        console.log(`Miner HTTP server running on port ${HTTP_PORT}`);
    });

    // Request the blockchain from the central server
    ws.send(JSON.stringify({ type: 'GET_BLOCKCHAIN' }));
}

main();