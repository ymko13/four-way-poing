const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');

// Initialize Express app
const app = express();
app.use(express.json());
app.use(cors());

// Create HTTP server
const server = http.createServer(app);

// Initialize WebSocket server
const wss = new WebSocket.Server({ server });

// Game state storage
const lobbies = new Map();

// Helper function to generate a random 4-character lobby code
function generateLobbyCode() {
  return Math.random().toString(36).substring(2, 6).toUpperCase();
}

// Helper function to broadcast to all clients in a lobby
function broadcastToLobby(lobbyCode, message) {
  const lobby = lobbies.get(lobbyCode);
  if (!lobby) return;

  lobby.clients.forEach(client => {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify(message));
    }
  });
}

// REST API Endpoints
app.post('/api/lobby/create', (req, res) => {
  const { hostName } = req.body;
  
  if (!hostName) {
    return res.status(400).json({ error: 'Host name is required' });
  }
  
  // Generate a unique lobby code
  let lobbyCode;
  do {
    lobbyCode = generateLobbyCode();
  } while (lobbies.has(lobbyCode));
  
  // Generate a host ID
  const hostId = `player-${uuidv4()}`;
  
  // Create a new lobby
  lobbies.set(lobbyCode, {
    code: lobbyCode,
    host: hostId,
    clients: [],
    players: [{ id: hostId, name: hostName, isReady: false, position: 'TOP' }],
    gameState: {
      status: 'WAITING',
      ball: { x: 300, y: 300, velocityX: 0, velocityY: 0 },
      paddles: [],
      scores: {}
    }
  });
  
  res.json({ lobbyCode, hostId });
});

app.post('/api/lobby/join', (req, res) => {
  const { lobbyCode, playerName } = req.body;
  
  if (!lobbyCode || !playerName) {
    return res.status(400).json({ error: 'Lobby code and player name are required' });
  }
  
  const lobby = lobbies.get(lobbyCode);
  
  if (!lobby) {
    return res.status(404).json({ error: 'Lobby not found' });
  }
  
  // Check if lobby is full (max 4 players)
  if (lobby.players.length >= 4) {
    return res.status(400).json({ error: 'Lobby is full' });
  }
  
  // Generate a player ID
  const playerId = `player-${uuidv4()}`;
  
  // Assign a position based on the number of players
  const positions = ['TOP', 'RIGHT', 'BOTTOM', 'LEFT'];
  const position = positions[lobby.players.length];
  
  // Add player to the lobby
  lobby.players.push({ id: playerId, name: playerName, isReady: false, position });
  
  // Initialize score for the player
  lobby.gameState.scores[playerId] = 0;
  
  // Broadcast player joined message
  broadcastToLobby(lobbyCode, {
    type: 'PLAYER_JOINED',
    payload: { playerName }
  });
  
  res.json({ playerId, lobbyCode });
});

app.get('/api/lobby/status', (req, res) => {
  const { lobbyCode } = req.query;
  
  if (!lobbyCode) {
    return res.status(400).json({ error: 'Lobby code is required' });
  }
  
  const lobby = lobbies.get(lobbyCode);
  
  if (!lobby) {
    return res.status(404).json({ error: 'Lobby not found' });
  }
  
  res.json({
    lobbyCode,
    players: lobby.players.map(player => player.name)
  });
});

// WebSocket connection handler
wss.on('connection', (ws, req) => {
  // Parse URL parameters
  const url = new URL(req.url, 'http://localhost');
  const lobbyCode = url.searchParams.get('lobbyCode');
  const playerId = url.searchParams.get('playerId');
  
  if (!lobbyCode || !playerId) {
    ws.close(1000, 'Missing lobbyCode or playerId');
    return;
  }
  
  const lobby = lobbies.get(lobbyCode);
  
  if (!lobby) {
    ws.close(1000, 'Lobby not found');
    return;
  }
  
  // Find player in the lobby
  const playerIndex = lobby.players.findIndex(p => p.id === playerId);
  
  if (playerIndex === -1) {
    ws.close(1000, 'Player not found in lobby');
    return;
  }
  
  // Add client to the lobby
  lobby.clients.push({ ws, playerId });
  
  // Send initial game state
  ws.send(JSON.stringify({
    type: 'GAME_STATE_UPDATE',
    payload: lobby.gameState
  }));
  
  // Handle WebSocket messages
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      
      switch (data.type) {
        case 'PLAYER_READY':
          handlePlayerReady(lobbyCode, playerId);
          break;
        case 'MOVE_PADDLE':
          handleMovePaddle(lobbyCode, playerId, data.payload.direction);
          break;
        case 'LEAVE_LOBBY':
          handlePlayerLeave(lobbyCode, playerId);
          break;
        default:
          console.warn(`Unknown message type: ${data.type}`);
      }
    } catch (error) {
      console.error('Error handling message:', error);
    }
  });
  
  // Handle WebSocket close
  ws.on('close', () => {
    handlePlayerLeave(lobbyCode, playerId);
  });
});

// Game logic handlers
function handlePlayerReady(lobbyCode, playerId) {
  const lobby = lobbies.get(lobbyCode);
  if (!lobby) return;
  
  // Find player and mark as ready
  const player = lobby.players.find(p => p.id === playerId);
  if (player) {
    player.isReady = true;
  }
  
  // Check if all players are ready
  const allReady = lobby.players.every(p => p.isReady);
  
  // If all players are ready and there are at least 2 players, start the game
  if (allReady && lobby.players.length >= 2) {
    startGame(lobbyCode);
  } else {
    // Update game state to reflect player readiness
    updateGameState(lobbyCode);
  }
}

function handleMovePaddle(lobbyCode, playerId, direction) {
  const lobby = lobbies.get(lobbyCode);
  if (!lobby || lobby.gameState.status !== 'PLAYING') return;
  
  // Find player's paddle
  const paddle = lobby.gameState.paddles.find(p => p.playerId === playerId);
  if (!paddle) return;
  
  // Move paddle based on position and direction
  const PADDLE_SPEED = 10;
  
  if (paddle.position === 'TOP' || paddle.position === 'BOTTOM') {
    if (direction === 'LEFT' && paddle.x > 0) {
      paddle.x -= PADDLE_SPEED;
    } else if (direction === 'RIGHT' && paddle.x + paddle.width < 600) {
      paddle.x += PADDLE_SPEED;
    }
  } else { // LEFT or RIGHT
    if (direction === 'UP' && paddle.y > 0) {
      paddle.y -= PADDLE_SPEED;
    } else if (direction === 'DOWN' && paddle.y + paddle.height < 600) {
      paddle.y += PADDLE_SPEED;
    }
  }
  
  // Update game state
  updateGameState(lobbyCode);
}

function handlePlayerLeave(lobbyCode, playerId) {
  const lobby = lobbies.get(lobbyCode);
  if (!lobby) return;
  
  // Find player
  const playerIndex = lobby.players.findIndex(p => p.id === playerId);
  if (playerIndex === -1) return;
  
  const playerName = lobby.players[playerIndex].name;
  
  // Remove player from the lobby
  lobby.players.splice(playerIndex, 1);
  
  // Remove client from the lobby
  lobby.clients = lobby.clients.filter(client => client.playerId !== playerId);
  
  // If the host left, assign a new host or close the lobby
  if (lobby.host === playerId) {
    if (lobby.players.length > 0) {
      lobby.host = lobby.players[0].id;
    } else {
      // No players left, close the lobby
      lobbies.delete(lobbyCode);
      return;
    }
  }
  
  // Broadcast player left message
  broadcastToLobby(lobbyCode, {
    type: 'PLAYER_LEFT',
    payload: { playerName }
  });
  
  // If game was in progress, end it
  if (lobby.gameState.status === 'PLAYING') {
    endGame(lobbyCode, null);
  } else {
    // Update game state
    updateGameState(lobbyCode);
  }
}

function startGame(lobbyCode) {
  const lobby = lobbies.get(lobbyCode);
  if (!lobby) return;
  
  // Initialize paddles for each player
  lobby.gameState.paddles = lobby.players.map(player => {
    const position = player.position;
    let x, y, width, height;
    
    // Position paddles based on their position
    if (position === 'TOP') {
      width = 100;
      height = 10;
      x = 250;
      y = 20;
    } else if (position === 'RIGHT') {
      width = 10;
      height = 100;
      x = 570;
      y = 250;
    } else if (position === 'BOTTOM') {
      width = 100;
      height = 10;
      x = 250;
      y = 570;
    } else { // LEFT
      width = 10;
      height = 100;
      x = 20;
      y = 250;
    }
    
    return { playerId: player.id, position, x, y, width, height };
  });
  
  // Initialize ball
  lobby.gameState.ball = {
    x: 300,
    y: 300,
    velocityX: Math.random() > 0.5 ? 3 : -3,
    velocityY: Math.random() > 0.5 ? 3 : -3
  };
  
  // Initialize scores
  lobby.players.forEach(player => {
    lobby.gameState.scores[player.id] = 0;
  });
  
  // Set game status to PLAYING
  lobby.gameState.status = 'PLAYING';
  
  // Broadcast game start message
  broadcastToLobby(lobbyCode, {
    type: 'GAME_START',
    payload: { startTime: Date.now() }
  });
  
  // Start game loop
  startGameLoop(lobbyCode);
}

function updateGameState(lobbyCode) {
  const lobby = lobbies.get(lobbyCode);
  if (!lobby) return;
  
  // Broadcast game state update
  broadcastToLobby(lobbyCode, {
    type: 'GAME_STATE_UPDATE',
    payload: lobby.gameState
  });
}

function endGame(lobbyCode, winnerId) {
  const lobby = lobbies.get(lobbyCode);
  if (!lobby) return;
  
  // Stop game loop
  if (lobby.gameLoopInterval) {
    clearInterval(lobby.gameLoopInterval);
    lobby.gameLoopInterval = null;
  }
  
  // Set game status to GAME_OVER
  lobby.gameState.status = 'GAME_OVER';
  
  // Find winner name
  let winnerName = 'Unknown';
  if (winnerId) {
    const winner = lobby.players.find(p => p.id === winnerId);
    if (winner) {
      winnerName = winner.name;
    }
  }
  
  // Broadcast game over message
  broadcastToLobby(lobbyCode, {
    type: 'GAME_OVER',
    payload: { winner: winnerName }
  });
  
  // Reset player ready status
  lobby.players.forEach(player => {
    player.isReady = false;
  });
  
  // Update game state
  updateGameState(lobbyCode);
}

function startGameLoop(lobbyCode) {
  const lobby = lobbies.get(lobbyCode);
  if (!lobby) return;
  
  // Clear any existing game loop
  if (lobby.gameLoopInterval) {
    clearInterval(lobby.gameLoopInterval);
  }
  
  // Start game loop
  lobby.gameLoopInterval = setInterval(() => {
    updateBallPosition(lobbyCode);
    updateGameState(lobbyCode);
  }, 1000 / 60); // 60 FPS
}

function updateBallPosition(lobbyCode) {
  const lobby = lobbies.get(lobbyCode);
  if (!lobby || lobby.gameState.status !== 'PLAYING') return;
  
  const ball = lobby.gameState.ball;
  const paddles = lobby.gameState.paddles;
  
  // Update ball position
  ball.x += ball.velocityX;
  ball.y += ball.velocityY;
  
  // Check for collisions with paddles
  for (const paddle of paddles) {
    if (checkCollision(ball, paddle)) {
      // Reverse ball direction based on paddle position
      if (paddle.position === 'TOP' || paddle.position === 'BOTTOM') {
        ball.velocityY = -ball.velocityY;
      } else { // LEFT or RIGHT
        ball.velocityX = -ball.velocityX;
      }
      
      // Increase ball speed slightly
      ball.velocityX *= 1.05;
      ball.velocityY *= 1.05;
      
      break;
    }
  }
  
  // Check for collisions with walls (scoring)
  let scorer = null;
  
  // Top wall
  if (ball.y < 0) {
    // Find player at BOTTOM
    const bottomPlayer = lobby.players.find(p => p.position === 'BOTTOM');
    if (bottomPlayer) {
      lobby.gameState.scores[bottomPlayer.id]++;
      scorer = bottomPlayer.id;
    }
    resetBall(ball);
  }
  // Right wall
  else if (ball.x > 600) {
    // Find player at LEFT
    const leftPlayer = lobby.players.find(p => p.position === 'LEFT');
    if (leftPlayer) {
      lobby.gameState.scores[leftPlayer.id]++;
      scorer = leftPlayer.id;
    }
    resetBall(ball);
  }
  // Bottom wall
  else if (ball.y > 600) {
    // Find player at TOP
    const topPlayer = lobby.players.find(p => p.position === 'TOP');
    if (topPlayer) {
      lobby.gameState.scores[topPlayer.id]++;
      scorer = topPlayer.id;
    }
    resetBall(ball);
  }
  // Left wall
  else if (ball.x < 0) {
    // Find player at RIGHT
    const rightPlayer = lobby.players.find(p => p.position === 'RIGHT');
    if (rightPlayer) {
      lobby.gameState.scores[rightPlayer.id]++;
      scorer = rightPlayer.id;
    }
    resetBall(ball);
  }
  
  // Check for game end (first to 10 points)
  if (scorer) {
    const score = lobby.gameState.scores[scorer];
    if (score >= 10) {
      endGame(lobbyCode, scorer);
    }
  }
}

function checkCollision(ball, paddle) {
  // Simple AABB collision detection
  return (
    ball.x < paddle.x + paddle.width &&
    ball.x + 10 > paddle.x &&
    ball.y < paddle.y + paddle.height &&
    ball.y + 10 > paddle.y
  );
}

function resetBall(ball) {
  // Reset ball to center with random direction
  ball.x = 300;
  ball.y = 300;
  ball.velocityX = Math.random() > 0.5 ? 3 : -3;
  ball.velocityY = Math.random() > 0.5 ? 3 : -3;
}

// Start the server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

module.exports = app;
