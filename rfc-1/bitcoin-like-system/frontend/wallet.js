const ec = new elliptic.ec('secp256k1');

let wallet = null;
let knownAddresses = [];
const MINER_HTTP_PORT = 3001; // This should match the HTTP_PORT of the miner you're connecting to
const MINER_WS_PORT = 8081;   // This should match the WS_PORT of the miner you're connecting to
const MINER_WS_SERVER = `ws://localhost:${MINER_WS_PORT}`;
const CENTRAL_SERVER = 'ws://localhost:8080';
const CENTRAL_SERVER_HTTP = 'http://localhost:3000'; // Make sure this matches your central server's HTTP_PORT
let ws;

let currentPage = 1;

async function fetchAddresses(page = 1) {
    try {
        const response = await fetch(`${CENTRAL_SERVER_HTTP}/addresses?page=${page}`);
        const data = await response.json();
        updateKnownAddresses(data.addresses);
        updatePagination(data.currentPage, data.totalPages);
    } catch (error) {
        console.error('Error fetching addresses:', error);
        showNotification('Failed to fetch addresses');
    }
}

function updatePagination(currentPage, totalPages) {
    const paginationDiv = document.getElementById('addressPagination');
    paginationDiv.innerHTML = '';

    if (currentPage > 1) {
        const prevButton = document.createElement('button');
        prevButton.textContent = 'Previous';
        prevButton.onclick = () => fetchAddresses(currentPage - 1);
        paginationDiv.appendChild(prevButton);
    }

    const pageInfo = document.createElement('span');
    pageInfo.textContent = `Page ${currentPage} of ${totalPages}`;
    paginationDiv.appendChild(pageInfo);

    if (currentPage < totalPages) {
        const nextButton = document.createElement('button');
        nextButton.textContent = 'Next';
        nextButton.onclick = () => fetchAddresses(currentPage + 1);
        paginationDiv.appendChild(nextButton);
    }
}


// Add this to your existing connectToCentralServer function
function connectToCentralServer() {
    ws = new WebSocket(CENTRAL_SERVER);
    
    ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'GET_MINERS' }));
        ws.send(JSON.stringify({ type: 'GET_WALLETS' }));
        updateActiveNodes();  // Update active nodes count when connection is established
        fetchAddresses(); // Fetch initial addresses
    };
    
    ws.onmessage = async (event) => {
        let data;
        if (event.data instanceof Blob) {
            // If the data is a Blob, read it as text
            const text = await event.data.text();
            data = JSON.parse(text);
        } else {
            // If it's already text, parse it directly
            data = JSON.parse(event.data);
        }

        if (data.type === 'TRANSACTION') {
            showNotification('New transaction added');
            updateBalance();  // Update balance after a new transaction
        } else if (data.type === 'BLOCK') {
            showNotification('New block mined. Transactions registered.');
            updateBalance();  // Update balance after a new block is mined
        } else if (data.type === 'MINERS_LIST') {
            updateKnownAddresses(data.miners.map(miner => miner.address));
        } else if (data.type === 'WALLETS_LIST') {
            updateKnownAddresses(data.wallets);
        } else if (data.type === 'NEW_MINER') {
            addKnownAddress(data.address);
        } else if (data.type === 'NEW_WALLET') {
            addKnownAddress(data.address);
        } else if (data.type === 'ACTIVE_MINERS_UPDATE') {
            document.getElementById('activeMinersCount').textContent = data.count;
        }
    };
}

async function updateActiveMiners() {
    try {
        const response = await fetch(`${CENTRAL_SERVER_HTTP}/active-miners`);
        const data = await response.json();
        document.getElementById('activeMinersCount').textContent = data.count;
    } catch (error) {
        console.error('Error getting active miners:', error);
        showNotification('Failed to get active miners count');
    }
}

function showNotification(message) {
    const notification = document.getElementById('notification');
    notification.textContent = message;
    notification.style.display = 'block';
    setTimeout(() => {
        notification.style.display = 'none';
    }, 10000);
}

async function createWallet() {
    const publicKey = CryptoJS.SHA256(Date.now().toString() + Math.random().toString()).toString();
    const privateKey = CryptoJS.SHA256(publicKey + Math.random().toString()).toString();
    
    wallet = {
        privateKey: privateKey,
        publicKey: publicKey,
    };
    
    document.getElementById('publicKey').textContent = wallet.publicKey;
    document.getElementById('privateKey').textContent = wallet.privateKey;
    document.getElementById('walletInfo').style.display = 'block';
    
    // Fetch the updated list of addresses
    await fetchAddresses();
    
    await updateBalance();  // Call here after creating wallet
    
    // After creating the wallet, register it with the central server
    ws.send(JSON.stringify({
        type: 'REGISTER_WALLET',
        address: wallet.publicKey
    }));
}

function addKnownAddress(address) {
    if (address) {
        const knownAddressesList = document.getElementById('knownAddresses');
        const li = document.createElement('li');
        li.textContent = address;
        knownAddressesList.appendChild(li);
    }
}

function signTransaction(transaction) {
    const key = ec.keyFromPrivate(wallet.privateKey, 'hex');
    const signature = key.sign(CryptoJS.SHA256(JSON.stringify(transaction)).toString());
    return signature.toDER('hex');
}

async function getBalance(address) {
    const response = await fetch(`${CENTRAL_SERVER_HTTP}/balance/${address}`);
    const data = await response.json();
    return data.balance;
}

async function updateBalance() {
    if (wallet) {
        try {
            const balance = await getBalance(wallet.publicKey);
            document.getElementById('balance').textContent = balance;
        } catch (error) {
            console.error('Error updating balance:', error);
            showNotification('Failed to update balance');
        }
    }
}

async function updateActiveNodes() {
    try {
        const count = await getActiveNodes();
        document.getElementById('activeNodesCount').textContent = count;
    } catch (error) {
        console.error('Error getting active nodes:', error);
        showNotification('Failed to get active nodes');
    }
}

document.getElementById('createWallet').addEventListener('click', createWallet);

document.getElementById('updateBalance').addEventListener('click', updateBalance);

// document.getElementById('getActiveMiners').addEventListener('click', updateActiveMiners);

document.getElementById('faucet').addEventListener('click', async function() {
    if (wallet) {
        try {
            const response = await fetch(`${CENTRAL_SERVER_HTTP}/faucet`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ address: wallet.publicKey }),
            });
            
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            
            const data = await response.json();
            if (data.success) {
                showNotification(data.message);
                await updateBalance();
            } else {
                showNotification('Faucet request failed: ' + data.message);
            }
        } catch (error) {
            console.error('Faucet error:', error);
            showNotification('Faucet request failed: ' + error.message);
        }
    } else {
        alert('Please create a wallet first');
    }
});

document.getElementById('sendTransaction').addEventListener('submit', async function(e) {
    e.preventDefault();
    if (!wallet) {
        alert('Please create a wallet first');
        return;
    }
    const recipient = document.getElementById('recipient').value;
    const amount = parseFloat(document.getElementById('amount').value);
    
    const transaction = {
        from: wallet.publicKey,
        to: recipient,
        amount: amount,
        timestamp: Date.now()
    };
    
    const signature = signTransaction(transaction);
    transaction.signature = signature;
    
    await broadcastTransaction(transaction);
    showNotification('Transaction sent');
    await updateBalance();  // Update balance after sending a transaction
});

async function broadcastTransaction(transaction) {
    ws.send(JSON.stringify({ type: 'TRANSACTION', transaction }));
}

function updateKnownAddresses(addresses) {
    const knownAddressesList = document.getElementById('knownAddresses');
    knownAddressesList.innerHTML = '';
    
    if (Array.isArray(addresses)) {
        addresses.forEach(address => {
            addKnownAddress(address);
        });
    } else if (typeof addresses === 'string') {
        addKnownAddress(addresses);
    } else {
        console.error('Invalid addresses:', addresses);
    }
}

// Add this function for login
async function login() {
    const publicKey = document.getElementById('loginPublicKey').value;
    const privateKey = document.getElementById('loginPrivateKey').value;

    try {
        const response = await fetch(`${CENTRAL_SERVER_HTTP}/login`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ publicKey, privateKey }),
            credentials: 'include' // This is important for CORS with credentials
        });

        if (response.ok) {
            const data = await response.json();
            if (data.success) {
                wallet = { publicKey, privateKey };
                document.getElementById('publicKey').textContent = publicKey;
                document.getElementById('privateKey').textContent = privateKey;
                document.getElementById('walletInfo').style.display = 'block';
                await updateBalance();  // Call here after successful login
                showNotification('Login successful');
            } else {
                showNotification('Login failed: ' + data.message);
            }
        } else {
            showNotification('Login failed');
        }
    } catch (error) {
        console.error('Login error:', error);
        showNotification('Login failed');
    }
}

// Add this function to get active nodes
async function getActiveNodes() {
    const response = await fetch(`${CENTRAL_SERVER_HTTP}/active-nodes`);
    const data = await response.json();
    document.getElementById('activeNodesCount').textContent = data.count;
}

// Add event listeners
document.getElementById('loginButton').addEventListener('click', login);
document.getElementById('getActiveNodes').addEventListener('click', getActiveNodes);


async function getBlockchainDetails() {
    try {
        const response = await fetch(`${CENTRAL_SERVER_HTTP}/blockchain-details`);
        const data = await response.json();
        document.getElementById('totalFauceted').textContent = data.totalFauceted;
        document.getElementById('totalMiningRewards').textContent = data.totalMiningRewards;
        document.getElementById('blockchainLength').textContent = data.blockchainLength;
        document.getElementById('blockReward').textContent = data.blockReward;
        document.getElementById('blockchainDetails').style.display = 'block';
    } catch (error) {
        console.error('Error fetching blockchain details:', error);
        showNotification('Failed to fetch blockchain details');
    }
}

document.getElementById('getBlockchainDetails').addEventListener('click', getBlockchainDetails);

// Initialize WebSocket connection when the page loads
connectToCentralServer();


