// Ported from MemoSuite sync/SyncService.ts; protocol/encryption intentionally preserved.
import { encryptData, decryptData, deriveTopic } from "./sync-crypto.js";
export const cleanRoomId = (roomId) => {
  return roomId.trim().replace(/[^a-zA-Z0-9_-]/g, "-").toUpperCase();
};
const RELAY_BASE = "https://ntfy.sh";
const WS_BASE = "wss://ntfy.sh";
export class SyncService {
  options;
  ws = null;
  roomId = null;
  // The ntfy topic is a one-way hash of roomId; roomId itself (the encryption key) is never sent.
  topic = null;
  isHost = false;
  seenMessageIds = /* @__PURE__ */ new Set();
  isSyncing = false;
  isProcessing = false;
  messageQueue = [];
  instanceId = Math.random().toString(36).substring(2, 10);
  hasSentInitialSync = false;
  mergedExcludeIds = [];
  heartbeatTimer = null;
  reconnectTimer = null;
  isDestroyed = false;
  constructor(options) {
    this.options = options;
  }
  setStatus(status, message) {
    this.options.onStatusChange(status, message);
  }
  async initialize(roomId) {
    this.isHost = true;
    this.roomId = cleanRoomId(roomId);
    this.topic = await deriveTopic(this.roomId);
    await this.analyzeSyncData();
    this.setStatus("connecting", "Connecting to relay server...");
    await this.connectRelay();
    this.setStatus("ready", `Room ID: ${this.roomId} - Waiting for peer...`);
    return this.roomId;
  }
  async analyzeSyncData() {
    if (!this.options.onSyncInfo) return;
    try {
      const info = await this.options.adapter.analyzeSyncData(this.options.initialDataLogId);
      this.options.onSyncInfo(info);
    } catch (e) {
      console.error("Failed to analyze sync data", e);
    }
  }
  async connect(targetRoomId) {
    this.isHost = false;
    this.roomId = cleanRoomId(targetRoomId);
    this.topic = await deriveTopic(this.roomId);
    this.setStatus("connecting", "Connecting to relay server...");
    await this.connectRelay();
    console.log("Sending join message...");
    await this.sendRelayMessage({ type: "join" });
    this.setStatus("connected", "Found peer! Waiting for source data...");
  }
  async connectRelay() {
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.onmessage = null;
      this.ws.close();
    }
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.isDestroyed) return;
    return new Promise((resolve, reject) => {
      const url = `${WS_BASE}/${this.topic}/ws?since=all`;
      const timeout = setTimeout(() => {
        if (this.ws && this.ws.readyState !== WebSocket.OPEN) {
          this.ws.close();
          reject(new Error("Relay connection timeout"));
        }
      }, 1e4);
      this.ws = new WebSocket(url);
      this.ws.onopen = () => {
        clearTimeout(timeout);
        console.log("Relay connected");
        this.heartbeatTimer = setInterval(() => {
          if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ type: "ping" }));
          }
        }, 15e3);
        if (this.options.onPing) this.options.onPing();
        resolve();
      };
      this.ws.onmessage = async (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.event === "message") {
            if (this.seenMessageIds.has(msg.id)) return;
            this.seenMessageIds.add(msg.id);
            if (this.seenMessageIds.size > 100) {
              const first = this.seenMessageIds.values().next().value;
              if (first) this.seenMessageIds.delete(first);
            }
            this.messageQueue.push(msg);
            this.processQueue();
          }
        } catch (e) {
        }
      };
      this.ws.onerror = (e) => {
        console.error("WebSocket error:", e);
      };
      this.ws.onclose = (event) => {
        console.log("Relay connection closed", event.code);
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        if (!this.isDestroyed && this.roomId) {
          console.log("Attempting to reconnect in 3s...");
          this.reconnectTimer = setTimeout(() => this.connectRelay(), 3e3);
        }
      };
    });
  }
  async processQueue() {
    if (this.isProcessing || this.messageQueue.length === 0) return;
    this.isProcessing = true;
    const msg = this.messageQueue.shift();
    try {
      await this.handleRelayMessage(msg);
    } catch (e) {
      console.error("Message processing failed", e);
    } finally {
      this.isProcessing = false;
      this.processQueue();
    }
  }
  async handleRelayMessage(msg) {
    if (msg.attachment) {
      if (msg.tags && msg.tags.includes(`inst_${this.instanceId}`)) {
        return;
      }
      await this.downloadAndProcessAttachment(msg.attachment.url);
      return;
    }
    let payload;
    try {
      payload = JSON.parse(msg.message);
    } catch (e) {
      return;
    }
    if (payload.instanceId === this.instanceId) {
      return;
    }
    switch (payload.type) {
      case "join":
        if (this.isHost) {
          this.setStatus("syncing", "Peer joined! Packaging local data...");
          setTimeout(() => this.syncData(), 500);
        }
        break;
      case "sync_data":
        if (payload.data) {
          await this.processReceivedEncodedData(payload.data);
        }
        break;
      case "sync_complete_ack":
        if (!this.isHost) {
          console.log("Received ACK from Host, finalizing sync");
          this.setStatus("completed", "Sync completed! All data mirrored.");
          this.options.onDataReceived();
        } else {
          console.log("Received ACK from Client");
          this.setStatus("completed", "Sync verified by peer.");
          this.options.onDataReceived();
        }
        break;
    }
  }
  async syncData() {
    if (!this.roomId || this.isSyncing) {
      return;
    }
    try {
      this.isSyncing = true;
      this.hasSentInitialSync = true;
      this.setStatus("syncing", "Scanning items to share...");
      const targetLogIds = await this.options.adapter.getSyncTargetIds(this.options.initialDataLogId);
      this.setStatus("syncing", "Syncing encrypted content...");
      const data = await this.options.adapter.getBackupData(targetLogIds, this.mergedExcludeIds);
      const jsonStr = JSON.stringify(data);
      const encrypted = await encryptData(jsonStr, this.roomId);
      const finalData = (targetLogIds ? "PARTIAL:" : "FULL:") + encrypted;
      if (finalData.length > 2e3) {
        await this.sendRelayAttachment(finalData);
      } else {
        await this.sendRelayMessage({
          type: "sync_data",
          data: finalData
        });
      }
      if (this.options.initialDataLogId) {
        this.setStatus("completed", "Item shared successfully!");
        this.options.onDataReceived();
      } else {
        if (this.isHost) {
          this.setStatus("syncing", "Data sent! Waiting for peer updates...");
        } else {
          this.setStatus("syncing", "Local changes sent! Waiting for verification...");
        }
      }
    } catch (err) {
      console.error("Sync failed:", err);
      this.setStatus("error", `Sync error: ${err.message}`);
    } finally {
      this.isSyncing = false;
    }
  }
  async sendRelayAttachment(encryptedData) {
    if (!this.roomId) return;
    const tags = [this.isHost ? "host" : "client", `inst_${this.instanceId}`];
    const response = await fetch(`${RELAY_BASE}/${this.topic}`, {
      method: "PUT",
      body: encryptedData,
      headers: {
        "Filename": "sync.enc",
        "Tags": tags.join(",")
      }
    });
    if (!response.ok) {
      throw new Error(`Upload failed: ${response.status} ${response.statusText}`);
    }
  }
  async sendRelayMessage(payload) {
    if (!this.roomId) return;
    payload.instanceId = this.instanceId;
    const message = JSON.stringify(payload);
    const response = await fetch(`${RELAY_BASE}/${this.topic}`, {
      method: "POST",
      body: message
    });
    if (!response.ok) {
      throw new Error(`Message failed: ${response.status} ${response.statusText}`);
    }
  }
  async downloadAndProcessAttachment(url) {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error("Download failed");
      const encodedData = await response.text();
      await this.processReceivedEncodedData(encodedData);
    } catch (err) {
      this.setStatus("error", `Download error: ${err.message}`);
    }
  }
  async processReceivedEncodedData(encodedData) {
    let isPartial = false;
    let realEncodedData = encodedData;
    if (encodedData.startsWith("PARTIAL:")) {
      isPartial = true;
      realEncodedData = encodedData.substring(8);
    } else if (encodedData.startsWith("FULL:")) {
      isPartial = false;
      realEncodedData = encodedData.substring(5);
    }
    let decrypted = "";
    try {
      this.setStatus("syncing", "Decrypting package...");
      decrypted = await decryptData(realEncodedData, this.roomId);
    } catch (e) {
      this.setStatus("error", "Decryption failed. Check room ID.");
      return;
    }
    let data;
    try {
      data = JSON.parse(decrypted);
      this.updateSyncInfoMeta(data, isPartial);
    } catch (e) {
      this.setStatus("error", "Data parsing failed.");
      return;
    }
    try {
      this.setStatus("merging", "Merging database changes...");
      const excludeIds = await this.options.adapter.mergeBackupData(data, this.options.onConflict);
      if (Array.isArray(excludeIds)) {
        this.mergedExcludeIds = excludeIds;
      }
      if (this.isHost) {
        console.log("Host merged client data. Sending ACK and finalizing.");
        await this.sendRelayMessage({ type: "sync_complete_ack" });
        this.setStatus("completed", "Sync completed! Exchange verified.");
        this.options.onDataReceived();
      } else {
        if (!isPartial) {
          if (!this.hasSentInitialSync) {
            console.log("Client merged host data. Sending local updates back.");
            await this.syncData();
          } else {
            console.log("Client already sent data. Waiting for host verification.");
          }
        } else {
          this.setStatus("completed", "Item received successfully!");
          this.options.onDataReceived();
        }
      }
    } catch (err) {
      this.setStatus("error", `Merge error: ${err.message}`);
    }
  }
  updateSyncInfoMeta(data, isPartial) {
    if (!this.options.onSyncInfo) return;
    let count = 0;
    let label = this.options.remoteItemsLabel || "Remote items";
    if (data.memos && Array.isArray(data.memos)) {
      count = data.memos.length;
      label = data.memos[0]?.title || "Combined Memos";
    } else if (data.logs && Array.isArray(data.logs)) {
      count = data.logs.length;
      label = data.logs[0]?.title || "Combined Logs";
    } else if (data.words && Array.isArray(data.words)) {
      count = data.words.length;
      label = data.words[0]?.title || "Combined Words";
    }
    if (!isPartial) {
      this.options.onSyncInfo({ type: "full", count: count || 0, label: "Full Sync Payload" });
    } else {
      this.options.onSyncInfo({ type: count > 1 ? "thread" : "single", count, label });
    }
  }
  destroy() {
    this.isDestroyed = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.onmessage = null;
      this.ws.close();
      this.ws = null;
    }
    this.roomId = null;
    this.topic = null;
  }
}
