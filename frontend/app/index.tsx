import React, { useState, useEffect, useRef } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  TextInput,
  ScrollView,
  StatusBar,
  KeyboardAvoidingView,
  Platform,
  TouchableWithoutFeedback,
  Keyboard,
  Dimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { Audio } from 'expo-av';
import * as FileSystem from 'expo-file-system';
// @ts-ignore
import io from 'socket.io-client/dist/socket.io';

const { width, height } = Dimensions.get('window');

interface Channel {
  id: string;
  name: string;
  frequency: string;
}

interface Operator {
  socketId: string;
  name: string;
  callsign: string;
  isActive: boolean;
}

export default function WalkieTalkieStateController() {
  const [view, setView] = useState<'home' | 'join-screen' | 'create-channel' | 'active'>('home');

  // User Profile & Server Setup
  const [userName, setUserName] = useState('');
  const [serverUrl, setServerUrl] = useState('http://10.115.47.252:3000');
  const [isConnected, setIsConnected] = useState(false);

  // Channels History & Search Query
  const [previouslyJoined, setPreviouslyJoined] = useState<Channel[]>([
    { id: '1', name: 'GENERAL DISPATCH', frequency: '446.006 MHz' },
    { id: '2', name: 'HQ COMMAND', frequency: '446.025 MHz' },
    { id: '3', name: 'TACTICAL TEAM 5', frequency: '446.088 MHz' },
  ]);
  const [searchQuery, setSearchQuery] = useState('');
  const [newChanName, setNewChanName] = useState('');
  const [activeChannelName, setActiveChannelName] = useState('');

  // Transceiver Talk State
  const [isTalking, setIsTalking] = useState(false);
  const [waveHeights, setWaveHeights] = useState<number[]>(Array(16).fill(4));

  // Microphone & Recording State
  const [hasPermission, setHasPermission] = useState<boolean | null>(null);
  const recordingRef = useRef<Audio.Recording | null>(null);
  const socketRef = useRef<any>(null);

  // Live operators list synced from backend
  const [operators, setOperators] = useState<Operator[]>([]);

  // Filter history based on search query
  const filteredChannels = previouslyJoined.filter((chan) =>
    chan.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const isExactMatchInHistory = previouslyJoined.some(
    (c) => c.name.toUpperCase().trim() === searchQuery.toUpperCase().trim()
  );

  // Check & request microphone permission
  const checkAndRequestPermissions = async () => {
    try {
      const { status } = await Audio.getPermissionsAsync();
      if (status === 'granted') {
        setHasPermission(true);
        return true;
      }
      const { status: askStatus } = await Audio.requestPermissionsAsync();
      setHasPermission(askStatus === 'granted');
      return askStatus === 'granted';
    } catch (err) {
      console.warn('Failed to get mic permissions:', err);
      setHasPermission(false);
      return false;
    }
  };

  // Setup audio settings once on active view
  useEffect(() => {
    if (view === 'active') {
      checkAndRequestPermissions();
    }
  }, [view]);

  // Clean up recording & socket on unmount
  useEffect(() => {
    return () => {
      if (recordingRef.current) {
        recordingRef.current.stopAndUnloadAsync().catch(() => {});
      }
      if (socketRef.current) {
        socketRef.current.disconnect();
      }
    };
  }, []);

  const handleMeteringUpdate = (metering: number) => {
    const db = typeof metering === 'number' ? metering : -60;
    // Normalize metering: -60dB (silence) to 0dB (max loudness)
    const normalized = Math.max(0, Math.min(1, (db + 60) / 60));

    // Visual envelopes for 16 bars to form a beautiful organic wave shape
    const ENVELOPE = [
      0.15, 0.3, 0.55, 0.8, 0.95, 1.0, 0.85, 0.6,
      0.6, 0.85, 1.0, 0.95, 0.8, 0.55, 0.3, 0.15
    ];

    setWaveHeights((prev) =>
      prev.map((_, i) => {
        const envFactor = ENVELOPE[i] || 0.5;
        const noise = 0.05 + Math.random() * 0.15;
        const peakValue = (normalized * 0.85 + noise) * envFactor;
        return Math.max(4, Math.floor(4 + peakValue * 44));
      })
    );
  };

  const startRecording = async () => {
    try {
      const granted = await checkAndRequestPermissions();
      if (!granted) {
        console.warn('Microphone permission not granted.');
        return;
      }

      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
      });

      if (recordingRef.current) {
        try {
          await recordingRef.current.stopAndUnloadAsync();
        } catch (e) {}
        recordingRef.current = null;
      }

      const recording = new Audio.Recording();
      await recording.prepareToRecordAsync({
        ...Audio.RecordingOptionsPresets.HIGH_QUALITY,
        isMeteringEnabled: true,
      });

      recording.setOnRecordingStatusUpdate((status) => {
        if (status.isRecording && status.metering !== undefined) {
          handleMeteringUpdate(status.metering);
        }
      });

      await recording.startAsync();
      recordingRef.current = recording;
    } catch (err) {
      console.error('Failed to start recording:', err);
    }
  };

  const stopRecording = async () => {
    try {
      if (recordingRef.current) {
        const recording = recordingRef.current;
        await recording.stopAndUnloadAsync();
        recordingRef.current = null;

        const uri = recording.getURI();
        if (uri && socketRef.current) {
          console.log('[AUDIO] Reading local file:', uri);
          const base64 = await FileSystem.readAsStringAsync(uri, {
            encoding: FileSystem.EncodingType.Base64,
          });

          console.log(`[SOCKET] Emitting voice payload (${base64.length} base64 chars)`);
          socketRef.current.emit('voice-payload', {
            audioBase64: base64,
          }, (response: any) => {
            if (response && response.status === 'success') {
              console.log("message sent");
              console.log('[SOCKET] Message sent and broadcasted successfully!');
            } else {
              console.warn('[SOCKET] Server failed to acknowledge message:', response?.message);
            }
          });
        }
      }
    } catch (err) {
      console.error('Failed to stop recording & transmit:', err);
    } finally {
      setIsTalking(false);
    }
  };

  const disconnectSocket = () => {
    if (socketRef.current) {
      socketRef.current.emit('leave-channel');
      socketRef.current.disconnect();
      socketRef.current = null;
    }
    setIsConnected(false);
    setOperators([]);
  };

  const connectAndJoin = (channelName: string) => {
    const cleanChan = channelName.toUpperCase().trim();
    if (!cleanChan) return;

    // Build unique history item
    const exists = previouslyJoined.some((c) => c.name === cleanChan);
    if (!exists) {
      const newChan: Channel = {
        id: (previouslyJoined.length + 1).toString(),
        name: cleanChan,
        frequency: '446.035 MHz',
      };
      setPreviouslyJoined([newChan, ...previouslyJoined]);
    }

    // Connect to WebSocket Server
    if (!socketRef.current) {
      console.log('[SOCKET] Connecting to server:', serverUrl);
      const socketInstance = io(serverUrl, {
        transports: ['websocket'],
        forceNew: true,
      });

      socketInstance.on('connect', () => {
        setIsConnected(true);
        console.log('[SOCKET] Connected! Joining channel:', cleanChan);
        socketInstance.emit('join-channel', {
          userName: userName.trim() || 'Operator',
          channelName: cleanChan,
        });
      });

      socketInstance.on('disconnect', () => {
        setIsConnected(false);
        console.log('[SOCKET] Disconnected.');
      });

      socketInstance.on('room-users', (users: Array<{ socketId: string; name: string; callsign: string }>) => {
        console.log('[SOCKET] Roster update:', users);
        // Map other operators excluding ourselves
        const others = users
          .filter((u) => u.socketId !== socketInstance.id)
          .map((u) => ({
            socketId: u.socketId,
            name: u.name,
            callsign: u.callsign,
            isActive: false,
          }));
        setOperators(others);
      });

      socketInstance.on('voice-broadcast', async ({ audioBase64, senderCallsign }: { audioBase64: string; senderCallsign: string }) => {
        console.log(`[SOCKET] Received voice broadcast from: ${senderCallsign}`);
        try {
          // Set speaking light active
          setOperators((prev) =>
            prev.map((op) =>
              op.callsign === senderCallsign ? { ...op, isActive: true } : op
            )
          );

          // Write Base64 to cache directory
          const tempFileUri = `${FileSystem.cacheDirectory}received_voice_${Date.now()}.m4a`;
          await FileSystem.writeAsStringAsync(tempFileUri, audioBase64, {
            encoding: FileSystem.EncodingType.Base64,
          });

          // Play audio file
          const { sound } = await Audio.Sound.createAsync(
            { uri: tempFileUri },
            { shouldPlay: true }
          );

          sound.setOnPlaybackStatusUpdate((status) => {
            if (status.isLoaded && status.didJustFinish) {
              // Turn off speaking indicator
              setOperators((prev) =>
                prev.map((op) =>
                  op.callsign === senderCallsign ? { ...op, isActive: false } : op
                )
              );
              FileSystem.deleteAsync(tempFileUri, { idempotent: true }).catch(() => {});
            }
          });
        } catch (playErr) {
          console.error('[AUDIO] Playback error:', playErr);
          setOperators((prev) => prev.map((op) => ({ ...op, isActive: false })));
        }
      });

      socketRef.current = socketInstance;
    } else {
      socketRef.current.emit('join-channel', {
        userName: userName.trim() || 'Operator',
        channelName: cleanChan,
      });
    }

    setActiveChannelName(cleanChan);
    setView('active');
    setSearchQuery('');
  };

  const handleConnectToChannel = (channelName: string) => {
    connectAndJoin(channelName);
  };

  const handleCreateSubmit = () => {
    if (!newChanName.trim()) return;
    connectAndJoin(newChanName);
    setNewChanName('');
  };

  const activeOpCount = operators.filter(o => o.isActive).length;
  const receivingState = activeOpCount > 0;
  const currentSpeaker = operators.find(o => o.isActive);

  // Waveform Bar Animation loop for standby and simulated receiving states
  useEffect(() => {
    if (view !== 'active') return;

    const interval = setInterval(() => {
      setWaveHeights((prev) =>
        prev.map((h, i) => {
          if (isTalking) {
            // Handled dynamically by microphone metering
            return h;
          } else if (receivingState) {
            // High energetic peaks from someone else speaking (simulated)
            const ENVELOPE = [
              0.1, 0.25, 0.45, 0.7, 0.9, 1.0, 0.8, 0.6,
              0.6, 0.8, 1.0, 0.9, 0.7, 0.45, 0.25, 0.1
            ];
            const envFactor = ENVELOPE[i] || 0.5;
            const noise = 0.3 + Math.random() * 0.7;
            return Math.max(4, Math.floor(4 + noise * envFactor * 32));
          } else {
            // Low flat noise static when standby
            return 4 + Math.floor(Math.random() * 8);
          }
        })
      );
    }, 100);

    return () => clearInterval(interval);
  }, [view, isTalking, receivingState]);

  // Simulate other operators occasionally speaking
  useEffect(() => {
    if (view !== 'active') return;
    let speakTimer: NodeJS.Timeout;

    const simulateChant = () => {
      if (isTalking) {
        speakTimer = setTimeout(simulateChant, 5000);
        return;
      }

      // 30% chance an operator speaks
      if (Math.random() < 0.35) {
        const speakIdx = Math.floor(Math.random() * operators.length);
        setOperators((prev) =>
          prev.map((op, idx) => ({ ...op, isActive: idx === speakIdx }))
        );

        // Talk for 3 seconds
        setTimeout(() => {
          setOperators((prev) => prev.map((op) => ({ ...op, isActive: false })));
        }, 3000);
      }

      speakTimer = setTimeout(simulateChant, 6000 + Math.random() * 4000);
    };

    speakTimer = setTimeout(simulateChant, 4000);
    return () => clearTimeout(speakTimer);
  }, [view, isTalking]);

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#070A13" />
      <TouchableWithoutFeedback onPress={Keyboard.dismiss}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={{ flex: 1 }}
        >
          {/* VIEW 1: MAIN LOBBY HOME PAGE */}
          {view === 'home' && (
            <View style={styles.lobbyContainer}>
              <View style={styles.header}>
                <Ionicons name="radio" size={48} color="#00F0FF" />
                <Text style={styles.title}>WALKIE TALKIE</Text>
                <Text style={styles.subtitle}>Secure voice channels at your fingertips</Text>
              </View>

              <View style={styles.card}>
                <Text style={styles.label}>ENTER YOUR NAME</Text>
                <TextInput
                  style={styles.textInput}
                  placeholder="e.g. Sgt. Miller, Alex..."
                  placeholderTextColor="#475569"
                  value={userName}
                  onChangeText={setUserName}
                  maxLength={16}
                  autoCorrect={false}
                />

                <Text style={styles.label}>TACTICAL NODE SERVER ADDR</Text>
                <TextInput
                  style={styles.textInput}
                  placeholder="http://10.115.47.252:3000"
                  placeholderTextColor="#475569"
                  value={serverUrl}
                  onChangeText={setServerUrl}
                  autoCorrect={false}
                  autoCapitalize="none"
                />

                <View style={styles.buttonRow}>
                  <TouchableOpacity
                    style={[styles.actionBtn, styles.joinBtn, !userName.trim() && styles.btnDisabled]}
                    disabled={!userName.trim()}
                    onPress={() => setView('join-screen')}
                  >
                    <Ionicons name="enter-outline" size={18} color="#FFF" />
                    <Text style={styles.actionBtnText}>JOIN CHANNEL</Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={[styles.actionBtn, styles.createBtn, !userName.trim() && styles.btnDisabled]}
                    disabled={!userName.trim()}
                    onPress={() => setView('create-channel')}
                  >
                    <Ionicons name="add-circle-outline" size={18} color="#FFF" />
                    <Text style={styles.actionBtnText}>CREATE CHANNEL</Text>
                  </TouchableOpacity>
                </View>
              </View>
            </View>
          )}

          {/* VIEW 2: SELECT CHANNEL */}
          {view === 'join-screen' && (
            <View style={styles.lobbyContainer}>
              <View style={styles.header}>
                <Text style={styles.title}>SELECT CHANNEL</Text>
                <Text style={styles.subtitle}>Search existing bands or connect to a new frequency</Text>
              </View>

              <View style={styles.card}>
                {/* Search Input Field */}
                <View style={styles.inputGroup}>
                  <Text style={styles.label}>SEARCH OR ENTER CHANNEL NAME</Text>
                  <View style={styles.searchRow}>
                    <Ionicons name="search" size={18} color="#475569" style={styles.searchIcon} />
                    <TextInput
                      style={styles.searchInput}
                      placeholder="Type channel name to search/join..."
                      placeholderTextColor="#475569"
                      value={searchQuery}
                      onChangeText={setSearchQuery}
                      maxLength={18}
                      autoCorrect={false}
                    />
                    {searchQuery.length > 0 && (
                      <TouchableOpacity onPress={() => setSearchQuery('')} style={styles.clearBtn}>
                        <Ionicons name="close-circle" size={16} color="#64748B" />
                      </TouchableOpacity>
                    )}
                  </View>
                </View>

                {/* Direct Connect to Custom Typed Channel */}
                {searchQuery.trim().length > 0 && !isExactMatchInHistory && (
                  <TouchableOpacity
                    style={styles.customConnectCard}
                    onPress={() => handleConnectToChannel(searchQuery)}
                  >
                    <Ionicons name="radio-outline" size={18} color="#00FF66" />
                    <Text style={styles.customConnectText} numberOfLines={1}>
                      CONNECT TO NEW BAND: "{searchQuery.toUpperCase()}"
                    </Text>
                    <Ionicons name="arrow-forward" size={14} color="#00FF66" />
                  </TouchableOpacity>
                )}

                {/* History list */}
                <View style={styles.historySection}>
                  <Text style={styles.label}>
                    {searchQuery.trim() ? 'SEARCH RESULTS' : 'PREVIOUSLY JOINED CHANNELS'}
                  </Text>
                  <ScrollView
                    showsVerticalScrollIndicator={false}
                    contentContainerStyle={styles.historyList}
                    style={{ maxHeight: 180 }}
                  >
                    {filteredChannels.length === 0 ? (
                      <Text style={styles.emptyHistoryText}>
                        {searchQuery.trim()
                          ? 'No matching channels found. Tap the button above to establish it!'
                          : 'No channels joined yet.'}
                      </Text>
                    ) : (
                      filteredChannels.map((chan) => (
                        <TouchableOpacity
                          key={chan.id}
                          style={styles.channelRow}
                          onPress={() => handleConnectToChannel(chan.name)}
                        >
                          <View>
                            <Text style={styles.channelNameText}>{chan.name}</Text>
                            <Text style={styles.channelFreqText}>{chan.frequency}</Text>
                          </View>
                          <View style={styles.reconnectRow}>
                            <Text style={styles.reconnectText}>RECONNECT</Text>
                            <Ionicons name="chevron-forward" size={14} color="#00F0FF" />
                          </View>
                        </TouchableOpacity>
                      ))
                    )}
                  </ScrollView>
                </View>

                <TouchableOpacity style={styles.backBtn} onPress={() => setView('home')}>
                  <Text style={styles.backBtnText}>BACK TO LOBBY</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}

          {/* VIEW 3: CREATE CHANNEL INPUT */}
          {view === 'create-channel' && (
            <View style={styles.lobbyContainer}>
              <View style={styles.header}>
                <Text style={styles.title}>CREATE CHANNEL</Text>
                <Text style={styles.subtitle}>Establish a new callsign frequency</Text>
              </View>

              <View style={styles.card}>
                <Text style={styles.label}>CHANNEL NAME</Text>
                <TextInput
                  style={styles.textInput}
                  placeholder="e.g. ALPHA SQUAD, PATROL-9"
                  placeholderTextColor="#475569"
                  value={newChanName}
                  onChangeText={setNewChanName}
                  maxLength={18}
                  autoCorrect={false}
                />

                <TouchableOpacity
                  style={[styles.submitBtn, !newChanName.trim() && styles.btnDisabled]}
                  disabled={!newChanName.trim()}
                  onPress={handleCreateSubmit}
                >
                  <Text style={styles.submitBtnText}>INITIALIZE FREQUENCY</Text>
                </TouchableOpacity>

                <TouchableOpacity style={styles.backBtn} onPress={() => setView('home')}>
                  <Text style={styles.backBtnText}>BACK TO LOBBY</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}

          {/* VIEW 4: IMPROVED DYNAMIC & RESPONSIVE ACTIVE TRANSCEIVER */}
          {view === 'active' && (
            <View style={styles.activeContainer}>
              {/* Top Bar with Safe Abort */}
              <View style={styles.activeTopBar}>
                <View style={styles.activeTitleContainer}>
                  <View style={styles.pulsingDotLive} />
                  <Text style={styles.activeTitleText}>BAND TRANSCEIVER</Text>
                </View>

                <TouchableOpacity
                  activeOpacity={0.7}
                  style={styles.safeAbortHeaderBtn}
                  onPress={() => {
                    stopRecording();
                    disconnectSocket();
                    setView('home');
                  }}
                >
                  <Ionicons name="power" size={10} color="#EF4444" style={{ marginRight: 4 }} />
                  <Text style={styles.safeAbortHeaderBtnText}>DISCONNECT</Text>
                </TouchableOpacity>
              </View>

              {/* LCD Display Console */}
              <View style={styles.lcdFrame}>
                <View style={styles.lcdHeader}>
                  <View style={styles.signalRssi}>
                    <View style={[styles.rssiBar, styles.rssiBarActive]} />
                    <View style={[styles.rssiBar, styles.rssiBarActive]} />
                    <View style={[styles.rssiBar, styles.rssiBarActive]} />
                    <View style={[styles.rssiBar, isTalking || receivingState ? styles.rssiBarActive : null]} />
                  </View>
                  <View style={styles.secureBadge}>
                    <Ionicons name="shield-checkmark" size={10} color="#00FF66" />
                    <Text style={styles.secureBadgeText}>SECURE AES-256</Text>
                  </View>
                </View>

                {/* Big Channel & Status details */}
                <View style={styles.lcdFrequencyBlock}>
                  <Text style={[
                    styles.lcdChannel,
                    isTalking ? styles.lcdTextTalking : receivingState ? styles.lcdTextReceiving : null
                  ]}>
                    {activeChannelName}
                  </Text>
                  <Text style={styles.lcdFrequencyText}>FREQ: 446.035 MHz</Text>
                </View>

                {/* Bottom line: Operator metadata */}
                <View style={styles.lcdFooter}>
                  <Text style={styles.lcdUser}>
                    OP: {userName.toUpperCase()}
                  </Text>
                  <Text style={[
                    styles.lcdStatusText,
                    isTalking ? styles.lcdStatusTextTalking : receivingState ? styles.lcdStatusTextReceiving : null
                  ]}>
                    {isTalking ? '● TRANSMITTING' : receivingState ? `● RX: ${currentSpeaker?.callsign}` : '● STANDBY'}
                  </Text>
                </View>
              </View>

              {/* Responsive Waveform Section */}
              <View style={styles.waveformBezel}>
                <View style={styles.waveformRow}>
                  {waveHeights.map((h, bIdx) => (
                    <View
                      key={`wave-bar-${bIdx}`}
                      style={[
                        styles.waveformBar,
                        { height: h },
                        isTalking
                          ? styles.waveformBarTalking
                          : receivingState
                            ? styles.waveformBarReceiving
                            : null
                      ]}
                    />
                  ))}
                </View>
              </View>

              {/* Roster & Live Participant Counts */}
              <View style={styles.rosterCard}>
                <View style={styles.rosterHeader}>
                  <Text style={styles.rosterTitle}>COMMUNICATION MATRIX</Text>
                  <View style={styles.rosterPill}>
                    <Text style={styles.rosterPillText}>{operators.length + 1} ONLINE</Text>
                  </View>
                </View>

                {/* Avatars List */}
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.avatarScroll}>
                  {/* Your Avatar */}
                  <View style={styles.avatarWrapper}>
                    <View style={[
                      styles.avatarCircle,
                      styles.avatarCircleYou,
                      isTalking && styles.avatarCircleYouTalking
                    ]}>
                      <Text style={styles.avatarInitial}>YOU</Text>
                    </View>
                    <Text style={[styles.avatarName, isTalking && styles.avatarNameTalking]}>You</Text>
                    {isTalking && <View style={styles.speakingIndicatorDot} />}
                  </View>

                  {/* Other Operator Avatars */}
                  {operators.map((op, idx) => (
                    <View key={`avatar-${idx}`} style={styles.avatarWrapper}>
                      <View style={[
                        styles.avatarCircle,
                        op.isActive && styles.avatarCircleSpeaking
                      ]}>
                        <Text style={styles.avatarInitial}>
                          {op.callsign.substring(0, 2)}
                        </Text>
                      </View>
                      <Text style={[styles.avatarName, op.isActive && styles.avatarNameSpeaking]}>
                        {op.callsign}
                      </Text>
                      {op.isActive && <View style={styles.speakingIndicatorDot} />}
                    </View>
                  ))}
                </ScrollView>
              </View>

              {/* Giant Center PTT Button Area */}
              <View style={styles.pttContainer}>
                <TouchableOpacity
                  activeOpacity={0.85}
                  onPressIn={() => {
                    setOperators((prev) => prev.map((op) => ({ ...op, isActive: false })));
                    setIsTalking(true);
                    startRecording();
                  }}
                  onPressOut={stopRecording}
                  style={[styles.pttButton, isTalking && styles.pttButtonActive]}
                >
                  <Ionicons name="mic-sharp" size={48} color="#FFF" />
                </TouchableOpacity>
                <Text style={[styles.pttHint, isTalking && styles.pttHintActive]}>
                  {isTalking ? 'SPEECH STREAM INJECTION LIVE' : 'PRESS & HOLD RED DOME TO TALK'}
                </Text>
              </View>


            </View>
          )}
        </KeyboardAvoidingView>
      </TouchableWithoutFeedback>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#070A13', // Deep midnight backing
  },
  lobbyContainer: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  header: {
    alignItems: 'center',
    marginBottom: 24,
    gap: 8,
  },
  title: {
    color: '#00F0FF',
    fontFamily: 'SpaceMono',
    fontSize: 24,
    fontWeight: 'bold',
    letterSpacing: 2,
  },
  subtitle: {
    color: '#64748B',
    fontSize: 12,
    textAlign: 'center',
  },
  card: {
    backgroundColor: '#0F172A',
    borderWidth: 1.5,
    borderColor: '#1E293B',
    borderRadius: 16,
    padding: 20,
    gap: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 10,
    elevation: 6,
  },
  label: {
    color: '#94A3B8',
    fontFamily: 'SpaceMono',
    fontSize: 10,
    fontWeight: 'bold',
    letterSpacing: 1,
  },
  textInput: {
    backgroundColor: '#070A13',
    borderWidth: 1,
    borderColor: '#1E293B',
    borderRadius: 8,
    color: '#FFF',
    fontFamily: 'SpaceMono',
    fontSize: 13,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 8,
  },
  actionBtn: {
    flex: 1,
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 6,
  },
  joinBtn: {
    backgroundColor: '#3B82F6', // Indigo-Blue
  },
  createBtn: {
    backgroundColor: '#10B981', // Emerald-Green
  },
  btnDisabled: {
    backgroundColor: '#1E293B',
    opacity: 0.5,
  },
  actionBtnText: {
    color: '#FFF',
    fontFamily: 'SpaceMono',
    fontSize: 11,
    fontWeight: 'bold',
  },
  inputGroup: {
    gap: 8,
  },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#070A13',
    borderWidth: 1,
    borderColor: '#1E293B',
    borderRadius: 8,
    paddingHorizontal: 12,
  },
  searchIcon: {
    marginRight: 8,
  },
  searchInput: {
    flex: 1,
    color: '#FFF',
    fontFamily: 'SpaceMono',
    fontSize: 13,
    paddingVertical: 12,
  },
  clearBtn: {
    padding: 4,
  },
  customConnectCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#122D1B',
    borderWidth: 1,
    borderColor: '#00FF66',
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginTop: 2,
  },
  customConnectText: {
    color: '#00FF66',
    fontFamily: 'SpaceMono',
    fontSize: 10,
    fontWeight: 'bold',
    flex: 1,
    marginHorizontal: 10,
  },
  historySection: {
    gap: 8,
    marginTop: 4,
  },
  historyList: {
    gap: 8,
  },
  emptyHistoryText: {
    color: '#475569',
    fontSize: 11.5,
    textAlign: 'center',
    paddingVertical: 16,
    lineHeight: 18,
  },
  channelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#070A13',
    borderWidth: 1,
    borderColor: '#1E293B',
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  channelNameText: {
    color: '#FFF',
    fontFamily: 'SpaceMono',
    fontSize: 12,
    fontWeight: 'bold',
  },
  channelFreqText: {
    color: '#64748B',
    fontFamily: 'SpaceMono',
    fontSize: 9,
    marginTop: 1,
  },
  reconnectRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  reconnectText: {
    color: '#00F0FF',
    fontFamily: 'SpaceMono',
    fontSize: 9,
    fontWeight: 'bold',
  },
  submitBtn: {
    backgroundColor: '#10B981',
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  submitBtnText: {
    color: '#FFF',
    fontFamily: 'SpaceMono',
    fontSize: 12,
    fontWeight: 'bold',
  },
  backBtn: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
    marginTop: 4,
  },
  backBtnText: {
    color: '#64748B',
    fontFamily: 'SpaceMono',
    fontSize: 11,
    fontWeight: 'bold',
  },

  // RESPONSIVE ACTIVE TRANSCEIVER STYLES
  activeContainer: {
    flex: 1,
    paddingHorizontal: 20,
    paddingVertical: height * 0.02,
    justifyContent: 'space-between',
  },
  lcdFrame: {
    backgroundColor: '#0A1C10', // Deep forest LCD emerald
    borderRadius: 16,
    borderWidth: 2,
    borderColor: '#183821',
    padding: 16,
    gap: 12,
    shadowColor: '#00FF66',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.12,
    shadowRadius: 10,
    elevation: 3,
  },
  lcdHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  signalRssi: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 3,
  },
  rssiBar: {
    width: 2.5,
    height: 4,
    backgroundColor: '#162F1C',
    borderRadius: 0.5,
  },
  rssiBarActive: {
    backgroundColor: '#00FF66',
  },
  secureBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#122D18',
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  secureBadgeText: {
    color: '#00FF66',
    fontSize: 7.5,
    fontFamily: 'SpaceMono',
    fontWeight: 'bold',
  },
  lcdFrequencyBlock: {
    alignItems: 'center',
    gap: 2,
  },
  lcdChannel: {
    color: '#00FF66',
    fontFamily: 'SpaceMono',
    fontSize: height > 700 ? 32 : 26,
    fontWeight: 'bold',
    textAlign: 'center',
    letterSpacing: -0.5,
    textShadowColor: 'rgba(0, 255, 102, 0.4)',
    textShadowRadius: 8,
  },
  lcdTextTalking: {
    color: '#FF3D00',
    textShadowColor: 'rgba(255, 61, 0, 0.5)',
  },
  lcdTextReceiving: {
    color: '#00FFCC',
    textShadowColor: 'rgba(0, 255, 204, 0.5)',
  },
  lcdFrequencyText: {
    color: '#1A4D27',
    fontFamily: 'SpaceMono',
    fontSize: 9,
    fontWeight: 'bold',
  },
  lcdFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderTopWidth: 1,
    borderTopColor: '#122D18',
    paddingTop: 8,
  },
  lcdUser: {
    color: '#00FF66',
    fontFamily: 'SpaceMono',
    fontSize: 9.5,
    fontWeight: 'bold',
  },
  lcdStatusText: {
    fontSize: 9.5,
    fontFamily: 'SpaceMono',
    fontWeight: 'bold',
    color: '#1C4A28',
  },
  lcdStatusTextTalking: {
    color: '#FF3D00',
  },
  lcdStatusTextReceiving: {
    color: '#00FFCC',
  },
  waveformBezel: {
    height: 70,
    backgroundColor: '#08080C',
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: '#1E293B',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  waveformRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    width: '100%',
    gap: 4.5,
  },
  waveformBar: {
    width: 4,
    borderRadius: 2,
    backgroundColor: '#1E293B',
  },
  waveformBarTalking: {
    backgroundColor: '#FF3D00', // Energetic orange spikes
  },
  waveformBarReceiving: {
    backgroundColor: '#00FFCC', // Green waves when receiving
  },
  rosterCard: {
    backgroundColor: '#0F172A',
    borderWidth: 1.5,
    borderColor: '#1E293B',
    borderRadius: 16,
    padding: 14,
    gap: 12,
  },
  rosterHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  rosterTitle: {
    color: '#64748B',
    fontFamily: 'SpaceMono',
    fontSize: 9,
    fontWeight: 'bold',
    letterSpacing: 0.5,
  },
  rosterPill: {
    backgroundColor: '#162E1A',
    borderWidth: 0.5,
    borderColor: '#10B981',
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  rosterPillText: {
    color: '#10B981',
    fontFamily: 'SpaceMono',
    fontSize: 8.5,
    fontWeight: 'bold',
  },
  avatarScroll: {
    gap: 16,
    paddingRight: 10,
    alignItems: 'center',
  },
  avatarWrapper: {
    alignItems: 'center',
    position: 'relative',
    gap: 4,
  },
  avatarCircle: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: '#1E293B',
    borderWidth: 1.5,
    borderColor: '#334155',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarCircleYou: {
    backgroundColor: '#1F2E3D',
    borderColor: '#3B82F6',
  },
  avatarCircleYouTalking: {
    backgroundColor: '#3D1C16',
    borderColor: '#FF3D00',
  },
  avatarCircleSpeaking: {
    backgroundColor: '#0D2D1B',
    borderColor: '#00FFCC',
  },
  avatarInitial: {
    color: '#FFF',
    fontSize: 10,
    fontFamily: 'SpaceMono',
    fontWeight: 'bold',
  },
  avatarName: {
    color: '#64748B',
    fontSize: 9.5,
    fontWeight: 'bold',
  },
  avatarNameTalking: {
    color: '#FF3D00',
  },
  avatarNameSpeaking: {
    color: '#00FFCC',
  },
  speakingIndicatorDot: {
    position: 'absolute',
    top: 0,
    right: 0,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#00FFCC',
    borderWidth: 1.5,
    borderColor: '#0F172A',
  },
  pttContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  pttButton: {
    width: height > 700 ? 134 : 110,
    height: height > 700 ? 134 : 110,
    borderRadius: height > 700 ? 67 : 55,
    backgroundColor: '#DC2626', // Tactile red dome
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 6,
    borderColor: '#991B1B',
    shadowColor: '#EF4444',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.25,
    shadowRadius: 10,
    elevation: 6,
  },
  pttButtonActive: {
    backgroundColor: '#FF3D00',
    borderColor: '#B91C1C',
    shadowColor: '#FF3D00',
    shadowOpacity: 0.5,
  },
  pttHint: {
    color: '#475569',
    fontFamily: 'SpaceMono',
    fontSize: 9.5,
    fontWeight: 'bold',
    letterSpacing: 0.5,
    textAlign: 'center',
  },
  pttHintActive: {
    color: '#FF3D00',
  },
  activeTopBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#1E293B',
    marginBottom: 8,
  },
  activeTitleContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  pulsingDotLive: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#00FF66',
  },
  activeTitleText: {
    color: '#64748B',
    fontFamily: 'SpaceMono',
    fontSize: 10,
    fontWeight: 'bold',
    letterSpacing: 0.5,
  },
  safeAbortHeaderBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#271B1E',
    borderWidth: 1,
    borderColor: '#EF4444',
    borderRadius: 14,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  safeAbortHeaderBtnText: {
    color: '#EF4444',
    fontFamily: 'SpaceMono',
    fontSize: 9,
    fontWeight: 'bold',
  },
});
