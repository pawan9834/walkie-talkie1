const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// Heartbeat status route
app.get('/status', (req, res) => {
  res.json({ status: 'online', timestamp: new Date() });
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
  maxHttpBufferSize: 1e7, // Support up to 10MB voice files (100 seconds+ audio)
});

// Dynamic map: roomName -> Array of active operators
// operator = { socketId, name, callsign }
const rooms = new Map();

io.on('connection', (socket) => {
  console.log(`[SYS] Client connected: ${socket.id}`);

  // Track room and user profile on socket object for fast disconnect cleanup
  let currentRoom = null;
  let currentUser = null;

  socket.on('join-channel', ({ userName, channelName }) => {
    const cleanChan = channelName.toUpperCase().trim();
    const cleanUser = userName.trim();
    if (!cleanChan || !cleanUser) return;

    // Leave previous room if joined
    if (currentRoom) {
      socket.leave(currentRoom);
      removeUserFromRoom(currentRoom, socket.id);
    }

    currentRoom = cleanChan;
    currentUser = {
      socketId: socket.id,
      name: cleanUser,
      callsign: cleanUser.substring(0, 4).toUpperCase() + '-' + Math.floor(10 + Math.random() * 90),
    };

    socket.join(cleanChan);
    console.log(`[JOIN] ${cleanUser} (${currentUser.callsign}) joined channel: ${cleanChan}`);

    // Add to rooms map
    if (!rooms.has(cleanChan)) {
      rooms.set(cleanChan, []);
    }
    rooms.get(cleanChan).push(currentUser);

    // Broadcast updated operator roster to all operators in the channel
    const roster = rooms.get(cleanChan);
    io.to(cleanChan).emit('room-users', roster);
  });

  socket.on('voice-payload', ({ audioBase64 }, callback) => {
    if (!currentRoom || !currentUser) {
      if (callback) callback({ status: 'error', message: 'Not connected to room' });
      return;
    }
    console.log(`[PTT] ${currentUser.name} (${currentUser.callsign}) transmitting to: ${currentRoom} (${audioBase64.length} bytes)`);

    // Broadcast the voice payload to everyone in the room EXCEPT the sender
    socket.to(currentRoom).emit('voice-broadcast', {
      audioBase64,
      senderCallsign: currentUser.callsign,
      senderName: currentUser.name,
    });

    if (callback) {
      callback({ status: 'success' });
    }
  });

  socket.on('leave-channel', () => {
    if (currentRoom) {
      console.log(`[LEAVE] ${currentUser?.name} left channel: ${currentRoom}`);
      socket.leave(currentRoom);
      removeUserFromRoom(currentRoom, socket.id);
      currentRoom = null;
      currentUser = null;
    }
  });

  socket.on('disconnect', () => {
    console.log(`[SYS] Client disconnected: ${socket.id}`);
    if (currentRoom) {
      removeUserFromRoom(currentRoom, socket.id);
    }
  });
});

function removeUserFromRoom(roomName, socketId) {
  if (!rooms.has(roomName)) return;

  const users = rooms.get(roomName);
  const updated = users.filter((u) => u.socketId !== socketId);

  if (updated.length === 0) {
    rooms.delete(roomName);
    console.log(`[SYS] Channel ${roomName} is empty, removing room.`);
  } else {
    rooms.set(roomName, updated);
    // Broadcast updated operator roster
    io.to(roomName).emit('room-users', updated);
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[RUNNING] Tactical Walkie-Talkie Socket Server live on port ${PORT}`);
});
