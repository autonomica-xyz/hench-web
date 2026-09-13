// Hench web client — dispatch MCP tools/call tasks to Hench phone workers over ContextVM.
//
// Wire format (gift-wrapped mode, matches rs-sdk):
//   inner event:  kind 25910, content = JSON-RPC message, tags [["p", server]]
//   wrap:         kind 21059 (1059 also accepted), content = nip44(JSON.stringify(inner), convKey(ephemeral, server))
//   responses:    kinds 1059/21059 with #p = client; unwrap, then route by JSON-RPC id
//   discovery:    kinds 11316 (server) + 11317 (tools with inputSchema) + cap tags
// Payments: CEP-8 — notifications/payment_required carries a bolt11 pay_req;
// pay it with any wallet; settlement delivers payment_accepted then the result.

import { finalizeEvent, generateSecretKey, getPublicKey } from "https://esm.sh/nostr-tools@2.25.1/pure?bundle";
import { bytesToHex, hexToBytes } from "https://esm.sh/@noble/hashes@2.4.0/utils?bundle";
import * as nip44 from "https://esm.sh/nostr-tools@2.25.1/nip44?bundle";
import { toCanvas } from "https://esm.sh/qrcode@1.5.4?bundle";

const KIND_CTXVM = 25910;
const KIND_WRAP = 21059;
const KIND_WRAP_ALT = 1059;
const KIND_SERVER_ANNOUNCEMENT = 11316;
const KIND_TOOLS_LIST = 11317;
const CLIENT_SECRET_KEY = "hench-client-secret-key";
const DEFAULT_RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.primal.net",
  "wss://relay.nostr.net",
];
const MCP_PROTOCOL_VERSION = "2025-06-18";

const els = {
  form: document.querySelector("#taskForm"),
  workerSelect: document.querySelector("#workerSelect"),
  toolSelect: document.querySelector("#toolSelect"),
  toolFields: document.querySelector("#toolFields"),
  argsJson: document.querySelector("#argsJson"),
  relayUrls: document.querySelector("#relayUrls"),
  submitButton: document.querySelector("#submitButton"),
  connectionState: document.querySelector("#connectionState"),
  refreshWorkersButton: document.querySelector("#refreshWorkersButton"),
  workerList: document.querySelector("#workerList"),
  workerEmptyState: document.querySelector("#workerEmptyState"),
  jobList: document.querySelector("#jobList"),
  emptyState: document.querySelector("#emptyState"),
  clearButton: document.querySelector("#clearButton"),
  jobTemplate: document.querySelector("#jobTemplate"),
};

const discovered = new Map(); // pubkey -> {name, about, tools, caps, relays}

els.relayUrls.value = DEFAULT_RELAYS.join("\n");
els.refreshWorkersButton.addEventListener("click", () => startDiscovery());
els.workerSelect.addEventListener("change", renderToolOptions);
els.toolSelect.addEventListener("change", renderToolFields);
els.form.addEventListener("submit", submitTask);
els.clearButton.addEventListener("click", () => {
  els.jobList.replaceChildren();
  els.emptyState.hidden = false;
});

startDiscovery();

// ---------- discovery ----------

function startDiscovery() {
  const relays = relayUrls();
  const seenEvents = new Set();
  for (const relayUrl of relays) {
    try {
      const socket = new WebSocket(relayUrl);
      socket.addEventListener("open", () => {
        socket.send(JSON.stringify([
          "REQ",
          `hench-disc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          { kinds: [KIND_SERVER_ANNOUNCEMENT, KIND_TOOLS_LIST], limit: 200 },
        ]));
        setTimeout(() => closeQuietly(socket), 8000);
      });
      socket.addEventListener("message", ({ data }) => {
        let message;
        try { message = JSON.parse(data); } catch { return; }
        if (!Array.isArray(message) || message[0] !== "EVENT" || !message[2]) return;
        const event = message[2];
        if (seenEvents.has(event.id)) return;
        seenEvents.add(event.id);
        ingestAnnouncement(event, relayUrl);
      });
    } catch { /* relay unreachable */ }
  }
  setConnection("Scanning relays", "live");
  setTimeout(renderWorkers, 9000);
}

function ingestAnnouncement(event, relayUrl) {
  const pubkey = event.pubkey;
  if (!discovered.has(pubkey)) {
    discovered.set(pubkey, { pubkey, name: null, about: null, tools: [], caps: new Map(), relays: new Set() });
  }
  const worker = discovered.get(pubkey);
  worker.relays.add(relayUrl);
  for (const tag of event.tags) {
    if (tag[0] === "name" && tag[1]) worker.name = tag[1];
    if (tag[0] === "about" && tag[1]) worker.about = tag[1];
    if (tag[0] === "cap" && tag[1]) worker.caps.set(tag[1], { range: tag[2], unit: tag[3] });
  }
  if (event.kind === KIND_TOOLS_LIST) {
    const payload = parseJson(event.content);
    const tools = Array.isArray(payload?.tools) ? payload.tools : [];
    for (const tool of tools) {
      if (!tool?.name || worker.tools.some((t) => t.name === tool.name)) continue;
      worker.tools.push({
        name: tool.name,
        description: tool.description || "",
        inputSchema: tool.inputSchema || { type: "object", properties: {} },
      });
    }
  }
  if (event.kind === KIND_SERVER_ANNOUNCEMENT) {
    const payload = parseJson(event.content);
    if (payload?.name) worker.name = payload.name;
    if (payload?.about) worker.about = payload.about;
  }
}

function renderWorkers() {
  const workers = [...discovered.values()]
    .filter((worker) => worker.tools.length > 0)
    .sort((a, b) => (a.name || "").localeCompare(b.name || ""));

  els.workerEmptyState.textContent = workers.length === 0 ? "No Hench workers found on these relays" : "";
  els.workerEmptyState.hidden = workers.length > 0;
  els.workerList.replaceChildren();

  const previous = els.workerSelect.value;
  els.workerSelect.replaceChildren(new Option("select a worker…", ""));
  for (const worker of workers) {
    els.workerSelect.append(new Option(`${worker.name || shortId(worker.pubkey)} (${worker.tools.length} tools)`, worker.pubkey));
  }
  if (previous && discovered.has(previous)) els.workerSelect.value = previous;

  for (const worker of workers) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "worker-card";
    const top = document.createElement("div");
    top.className = "worker-card-top";
    const identity = document.createElement("div");
    const label = document.createElement("strong");
    label.textContent = worker.name || shortId(worker.pubkey);
    const sub = document.createElement("small");
    sub.textContent = `${worker.tools.length} tools · ${worker.relays.size} relays`;
    identity.append(label, sub);
    top.append(identity);
    card.append(top);
    if (worker.about) {
      const about = document.createElement("p");
      about.className = "worker-about";
      about.textContent = worker.about;
      card.append(about);
    }
    const tags = document.createElement("div");
    tags.className = "worker-tags";
    for (const [toolName, cap] of worker.caps) {
      const chip = document.createElement("span");
      chip.className = "worker-chip";
      chip.textContent = `${toolName.replace("tool:", "")} ${cap.range} ${cap.unit}`;
      tags.append(chip);
    }
    card.append(tags);
    card.addEventListener("click", () => {
      els.workerSelect.value = worker.pubkey;
      renderToolOptions();
    });
    els.workerList.append(card);
  }
  setConnection(workers.length > 0 ? `${workers.length} workers online` : "No workers", workers.length ? "live" : "");
  renderToolOptions();
}

// ---------- task form ----------

function renderToolOptions() {
  const worker = discovered.get(els.workerSelect.value);
  els.toolSelect.replaceChildren(new Option("select a tool…", ""));
  if (worker) for (const tool of worker.tools) els.toolSelect.append(new Option(tool.name, tool.name));
  els.toolSelect.disabled = !worker;
  renderToolFields();
}

function renderToolFields() {
  const worker = discovered.get(els.workerSelect.value);
  const tool = worker?.tools.find((t) => t.name === els.toolSelect.value);
  els.toolFields.replaceChildren();
  if (!tool) return;
  const schema = tool.inputSchema || {};
  const required = new Set(schema.required || []);
  const properties = Object.entries(schema.properties || {});
  if (properties.length === 0) {
    const note = document.createElement("p");
    note.className = "hint";
    note.textContent = tool.description;
    els.toolFields.append(note);
    return;
  }
  for (const [name, property] of properties) {
    const wrap = document.createElement("label");
    wrap.className = "field";
    const label = document.createElement("span");
    label.textContent = required.has(name) ? `${name} *` : name;
    wrap.append(label);
    let input;
    if (Array.isArray(property.enum)) {
      input = document.createElement("select");
      for (const value of property.enum) input.append(new Option(String(value), String(value)));
      if (property.default !== undefined) input.value = String(property.default);
    } else if (property.type === "boolean") {
      input = document.createElement("input");
      input.type = "checkbox";
      input.checked = property.default === true;
    } else if (property.type === "integer" || property.type === "number") {
      input = document.createElement("input");
      input.type = "number";
      if (property.default !== undefined) input.value = String(property.default);
    } else {
      input = document.createElement("input");
      input.type = "text";
      if (property.default !== undefined) input.value = String(property.default);
    }
    input.dataset.argName = name;
    input.dataset.argType = property.type || "string";
    if (property.description) input.title = property.description;
    wrap.append(input);
    els.toolFields.append(wrap);
  }
}

function collectArguments() {
  const manual = els.argsJson.value.trim();
  if (manual) {
    const parsed = parseJson(manual);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Arguments JSON is not an object");
    return parsed;
  }
  const args = {};
  for (const input of els.toolFields.querySelectorAll("[data-arg-name]")) {
    const name = input.dataset.argName;
    if (input.type === "checkbox") {
      if (input.checked) args[name] = true;
    } else {
      const raw = input.value.trim();
      if (raw === "") continue;
      if (input.dataset.argType === "integer" || input.dataset.argType === "number") {
        const value = Number(raw);
        if (!Number.isFinite(value)) throw new Error(`${name} must be a number`);
        args[name] = value;
      } else {
        args[name] = raw;
      }
    }
  }
  return args;
}

// ---------- dispatch ----------

async function submitTask(formEvent) {
  formEvent.preventDefault();
  const worker = discovered.get(els.workerSelect.value);
  const tool = worker?.tools.find((t) => t.name === els.toolSelect.value);
  if (!worker || !tool) { setConnection("Pick a worker and tool", "error"); return; }

  let args;
  try { args = collectArguments(); } catch (error) {
    setConnection(error.message, "error");
    return;
  }

  els.submitButton.disabled = true;
  setConnection("Dispatching", "live");
  const job = createJobView(worker, tool);
  const session = new CvmSession(relayUrls(), worker.pubkey, job);
  try {
    await session.start();
    job.step("Session established");
    const response = await session.callTool(tool.name, args);
    const result = response.result ?? {};
    const text = Array.isArray(result.content)
      ? result.content.map((block) => block.text || block.uri || "").filter(Boolean).join("\n")
      : JSON.stringify(result, null, 2);
    if (result.isError) job.onFailed(text || "tool error");
    else job.onResult(text || "(empty result)");
    setConnection("Done", "live");
  } catch (error) {
    job.onFailed(error.message || String(error));
    setConnection(error.message || "Task failed", "error");
  } finally {
    els.submitButton.disabled = false;
    session.close();
  }
}

// ---------- CVM session (gift-wrapped JSON-RPC over Nostr) ----------

class CvmSession {
  constructor(relays, serverPubkey, job) {
    this.relays = relays;
    this.serverPubkey = serverPubkey;
    this.job = job;
    this.sk = hexToBytes(getOrCreateSecretKeyHex());
    this.clientPubkey = getPublicKey(this.sk);
    this.sockets = new Map();
    this.seen = new Set();
    this.pending = new Map(); // jsonrpc id -> resolve/reject
    this.jobsByToken = new Map(); // progressToken -> job (same object; kept for clarity)
    this.nextId = 1;
  }

  async start() {
    const since = Math.floor(Date.now() / 1000) - 90;
    await Promise.allSettled(this.relays.map((url) => this.openRelay(url, since)));
    if (!this.sockets.size) throw new Error("could not connect any relay");
    await this.request({
      jsonrpc: "2.0",
      id: this.takeId(),
      method: "initialize",
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "hench-web", version: "0.1.0" },
      },
    });
    this.broadcast({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  openRelay(relayUrl, since) {
    return new Promise((resolve) => {
      let socket;
      try { socket = new WebSocket(relayUrl); } catch { return resolve(); }
      socket.addEventListener("open", () => {
        socket.send(JSON.stringify([
          "REQ",
          `hench-${Math.random().toString(36).slice(2, 10)}`,
          { kinds: [KIND_WRAP, KIND_WRAP_ALT], "#p": [this.clientPubkey], since },
        ]));
        this.sockets.set(relayUrl, socket);
        resolve();
      });
      socket.addEventListener("message", ({ data }) => this.handleFrame(data));
      socket.addEventListener("error", () => resolve());
      socket.addEventListener("close", () => resolve());
      setTimeout(resolve, 5000);
    });
  }

  handleFrame(raw) {
    let message;
    try { message = JSON.parse(raw); } catch { return; }
    if (!Array.isArray(message) || message[0] !== "EVENT" || !message[2]) return;
    const event = message[2];
    if ((event.kind !== KIND_WRAP && event.kind !== KIND_WRAP_ALT) || this.seen.has(event.id)) return;
    if (!event.tags.some((t) => t[0] === "p" && t[1] === this.clientPubkey)) return;
    this.seen.add(event.id);
    let inner;
    try {
      const key = nip44.v2.utils.getConversationKey(this.sk, event.pubkey);
      inner = JSON.parse(nip44.decrypt(event.content, key));
    } catch { return; }
    if (inner.pubkey !== this.serverPubkey || inner.kind !== KIND_CTXVM) return;
    const payload = parseJson(inner.content);
    if (!payload) return;
    if (payload.method) this.handleNotification(payload);
    else if (payload.id !== undefined) this.handleResponse(payload);
  }

  handleNotification(notification) {
    const method = notification.method || "";
    const params = notification.params || {};
    if (method === "notifications/payment_required") {
      this.job.onPaymentRequired(params);
    } else if (method === "notifications/payment_accepted") {
      this.job.onPaymentAccepted();
    } else if (method === "notifications/payment_rejected") {
      this.job.onFailed(`payment rejected: ${params.message || "unknown"}`);
    } else if (method === "notifications/progress") {
      this.job.onProgress(params);
    }
  }

  handleResponse(response) {
    const entry = this.pending.get(jsonIdKey(response.id));
    if (!entry) return;
    this.pending.delete(jsonIdKey(response.id));
    entry(response);
  }

  wrap(message) {
    const inner = finalizeEvent(
      {
        kind: KIND_CTXVM,
        created_at: Math.floor(Date.now() / 1000),
        tags: [["p", this.serverPubkey]],
        content: JSON.stringify(message),
      },
      this.sk,
    );
    const ephemeral = generateSecretKey();
    const key = nip44.v2.utils.getConversationKey(ephemeral, this.serverPubkey);
    const ciphertext = nip44.encrypt(JSON.stringify(inner), key);
    return finalizeEvent(
      {
        kind: KIND_WRAP,
        created_at: Math.floor(Date.now() / 1000),
        tags: [["p", this.serverPubkey]],
        content: ciphertext,
      },
      ephemeral,
    );
  }

  broadcast(message) {
    const wrap = this.wrap(message);
    for (const socket of this.sockets.values()) {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(["EVENT", wrap]));
    }
  }

  takeId() {
    return this.nextId++;
  }

  request(message, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      const key = jsonIdKey(message.id);
      this.pending.set(key, resolve);
      this.broadcast(message);
      setTimeout(() => {
        if (this.pending.has(key)) {
          this.pending.delete(key);
          reject(new Error(`no response to ${message.method} — worker offline?`));
        }
      }, timeoutMs);
    });
  }

  async callTool(toolName, args) {
    const id = this.takeId();
    return this.request({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: toolName, arguments: args, _meta: { progressToken: id } },
    }, 10 * 60 * 1000);
  }

  close() {
    for (const socket of this.sockets.values()) closeQuietly(socket);
    this.sockets.clear();
  }
}

// ---------- job views ----------

function createJobView(worker, tool) {
  els.emptyState.hidden = true;
  const card = els.jobTemplate.content.firstElementChild.cloneNode(true);
  card.querySelector('[data-role="title"]').textContent = tool.name;
  card.querySelector('[data-role="subtitle"]').textContent =
    `${worker.name || shortId(worker.pubkey)} · ${new Date().toLocaleTimeString()}`;
  const stateEl = card.querySelector('[data-role="state"]');
  const timelineEl = card.querySelector('[data-role="timeline"]');
  const invoiceEl = card.querySelector('[data-role="invoice"]');
  const resultEl = card.querySelector('[data-role="result"]');
  els.jobList.prepend(card);

  const view = {
    step(text) {
      const li = document.createElement("li");
      li.textContent = text;
      timelineEl.append(li);
    },
    setState(text, mode) {
      stateEl.textContent = text;
      stateEl.className = `connection-pill${mode === "error" ? " error" : mode === "live" ? " live" : ""}`;
    },
    onProgress(params) {
      if (params.status) this.step(`worker: ${params.status}`);
    },
    onPaymentRequired(params) {
      invoiceEl.hidden = false;
      this.setState("Payment required", "");
      this.step(`invoice: ${params.amount ?? "?"} sats (ttl ${params.ttl ?? "?"}s)`);
      const bolt11 = params.pay_req || "";
      toCanvas(card.querySelector('[data-role="qr"]'), `lightning:${bolt11}`, {
        errorCorrectionLevel: "M", margin: 2, width: 220,
        color: { dark: "#111411", light: "#ffffff" },
      }).catch(() => {});
      card.querySelector('[data-role="amount"]').textContent = params.amount ? `${params.amount} sats` : "";
      card.querySelector('[data-role="copy"]').addEventListener("click", async () => {
        await navigator.clipboard.writeText(bolt11);
      });
      card.querySelector('[data-role="open"]').href = `lightning:${bolt11}`;
    },
    onPaymentAccepted() {
      invoiceEl.hidden = true;
      this.setState("Paid — running", "live");
      this.step("payment accepted, executing");
    },
    onResult(text) {
      resultEl.hidden = false;
      resultEl.textContent = text;
      this.setState("Complete", "live");
      this.step("result delivered");
    },
    onFailed(message) {
      resultEl.hidden = false;
      resultEl.textContent = message;
      this.setState("Failed", "error");
      this.step(`failed: ${message}`);
    },
  };
  view.step(`dispatched ${tool.name}`);
  return view;
}

// ---------- helpers ----------

function getOrCreateSecretKeyHex() {
  let hex = localStorage.getItem(CLIENT_SECRET_KEY);
  if (!hex || !/^[0-9a-f]{64}$/.test(hex)) {
    hex = bytesToHex(generateSecretKey());
    localStorage.setItem(CLIENT_SECRET_KEY, hex);
  }
  return hex;
}
function relayUrls() {
  return els.relayUrls.value.split(/\n+/).map((s) => s.trim()).filter(Boolean);
}
function parseJson(text) { try { return JSON.parse(text); } catch { return null; } }
function shortId(id) { return `${id.slice(0, 8)}…${id.slice(-4)}`; }
function jsonIdKey(id) { return typeof id === "object" ? JSON.stringify(id) : String(id); }
function closeQuietly(socket) { try { socket.close(1000, "done"); } catch { /* closed */ } }
function setConnection(text, mode) {
  els.connectionState.textContent = text;
  els.connectionState.className = `connection-pill${mode === "error" ? " error" : mode === "live" ? " live" : ""}`;
}
