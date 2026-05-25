# 📻 Tactical Socket Walkie-Talkie

A high-performance, ultra-premium real-time Walkie-Talkie voice broadcasting application built with **React Native (Expo SDK 51)** and a **Node.js Socket.io server**.

---

## 🚀 Key Features
- **Symmetric Cyberpunk HUD**: Sleek military-tactical design with high-contrast glowing elements and flex-scaling.
- **Real-Time Sound Metering**: Captures actual physical microphone decibel updates during PTT (Push-To-Talk).
- **Dynamic Waveform Visualizer**: Renders beautiful, organic, moving audio envelopes corresponding directly to your live voice levels.
- **Dynamic Operator Matrix**: Syncs connection rooms instantly, rendering active speech indicators (halo lights) during broadcasts.
- **Low-Latency Voice Broadcast**: Emits encoded Base64 chunks over WebSocket channels for near-instant cross-device playback.
- **Dynamic Server Entry**: Custom socket URL configurations on the Lobby screen.

---

## 📁 Repository Structure
```text
d:\walkie-talkie\
├── frontend/        # React Native Expo client app
└── backend/         # Node.js Socket.io server
```

---

## 🛠️ How to Start the App

### 1. Boot the Backend Socket Server
```bash
cd backend
npm install
npm run dev
```

### 2. Start the Expo Frontend
```bash
cd frontend
npm install
npx expo start -c
```
Scan the QR code with **Expo Go** on your iOS/Android device to begin transmitting!
