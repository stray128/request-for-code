const WebSocket = require('ws');
const fs = require('fs');

const CENTRAL_SERVER = 'ws://localhost:8080';

const ws = new WebSocket(CENTRAL_SERVER);

ws.on('open', () => {
  console.log('Connected to central server');
  
  // Read the miner address from a file
  const minerAddress = fs.readFileSync('miner_address.txt', 'utf8').trim();
  
  const testTransaction = {
    from: minerAddress,
    to: 'fedcba0987654321',
    amount: 5
  };

  const message = JSON.stringify({
    type: 'TRANSACTION',
    transaction: testTransaction
  });

  ws.send(message);
  console.log('Test transaction sent');

  // Close the connection after sending the transaction
  setTimeout(() => {
    ws.close();
  }, 1000);
});

ws.on('close', () => {
  console.log('Disconnected from central server');
});