// Hench web client — dispatch MCP tools/call tasks to Hench phone workers over ContextVM.
//
// Wire format (gift-wrapped mode, matches rs-sdk):
//   inner event:  kind 25910, content = JSON-RPC message, tags [["p", server]]
//   wrap:         kind 21059 (1059 also accepted), content = nip44(JSON.stringify(inner), convKey(ephemeral, server))
//   responses:    kinds 1059/21059 with #p = client and an "e" tag naming our request's
//                 inner event id; unwrap, verify worker signature, route by that e-tag
//   discovery:    kinds 11316 (server) + 11317 (tools with inputSchema) + cap tags
// Payments: CEP-8 — notifications/payment_required carries a bolt11 pay_req;
// pay it with any wallet; settlement delivers payment_accepted then the result.

import {
  finalizeEvent, generateSecretKey, getPublicKey, verifyEvent, nip19, nip44,
} from "./vendor/nostr-tools.mjs";
import { bytesToHex, hexToBytes } from "./vendor/noble-hashes-utils.mjs";
import { toCanvas } from "./vendor/qrcode.mjs";
import {
  KIND_CTXVM, KIND_WRAP, KIND_WRAP_ALT, KIND_SERVER_ANNOUNCEMENT, KIND_TOOLS_LIST,
  MCP_PROTOCOL_VERSION, CLIENT_SECRET_KEY, DEFAULT_RELAYS, STALE_AFTER_S,
  isEventObject, announcementFresh, discoverySince, fromWorker, cleanBolt11,
  InvocationRouter,
} from "./lib.mjs";

const { npubEncode } = nip19;

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
  henchOnlyToggle: document.querySelector("#henchOnlyToggle"),
  workerList: document.querySelector("#workerList"),
  workerEmptyState: document.querySelector("#workerEmptyState"),
  jobList: document.querySelector("#jobList"),
  emptyState: document.querySelector("#emptyState"),
  clearButton: document.querySelector("#clearButton"),
  jobTemplate: document.querySelector("#jobTemplate"),
};

const discovered = new Map(); // pubkey -> {name, about, tools, caps, relays}
let discoveryRound = 0;              // incremented per refresh; late events from old rounds are dropped
const discoverySockets = new Set();  // open/CONNECTING sockets of the current round
let discoveryTimer = 0;              // the current round's final render timer

els.relayUrls.value = DEFAULT_RELAYS.join("\n");
els.refreshWorkersButton.addEventListener("click", () => startDiscovery());
els.henchOnlyToggle.addEventListener("change", () => renderWorkers());
els.workerSelect.addEventListener("change", () => {
  highlightSelectedWorker();
  renderToolOptions();
});
els.toolSelect.addEventListener("change", renderToolFields);
els.form.addEventListener("submit", submitTask);
els.clearButton.addEventListener("click", () => {
  els.jobList.replaceChildren();
  els.emptyState.hidden = false;
});

startDiscovery();

// ---------- discovery ----------

function startDiscovery() {
  // Each refresh is a round: kill the previous round's sockets and timer,
  // drop its results, and ignore any late event carrying its identity — an
  // old round must never contaminate a new relay selection.
  const round = ++discoveryRound;
  for (const socket of discoverySockets) closeQuietly(socket);
  discoverySockets.clear();
  clearTimeout(discoveryTimer);
  discovered.clear();
  const seenEvents = new Set();
  for (const relayUrl of relayUrls()) {
    try {
      const socket = new WebSocket(relayUrl);
      discoverySockets.add(socket);
      socket.addEventListener("close", () => discoverySockets.delete(socket));
      socket.addEventListener("error", () => discoverySockets.delete(socket));
      // Close on a timer whether or not it ever opened — a socket stuck in
      // CONNECTING otherwise leaks until the tab closes.
      setTimeout(() => {
        if (discoverySockets.delete(socket)) closeQuietly(socket);
      }, 8000);
      socket.addEventListener("open", () => {
        if (round !== discoveryRound) { closeQuietly(socket); return; }
        socket.send(JSON.stringify([
          "REQ",
          `hench-disc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          { kinds: [KIND_SERVER_ANNOUNCEMENT, KIND_TOOLS_LIST], since: discoverySince(), limit: 200 },
        ]));
      });
      socket.addEventListener("message", ({ data }) => {
        if (round !== discoveryRound) return; // late event from a superseded round
        let message;
        try { message = JSON.parse(data); } catch { return; }
        if (!Array.isArray(message) || message[0] !== "EVENT" || !message[2]) return;
        const event = message[2];
        if (seenEvents.has(event.id)) return;
        seenEvents.add(event.id);
        if (ingestAnnouncement(event, relayUrl)) renderWorkers();
      });
    } catch { /* relay unreachable */ }
  }
  renderWorkers(); // reflect the cleared previous round immediately
  setConnection("Scanning relays", "live");
  discoveryTimer = setTimeout(() => {
    if (round === discoveryRound) renderWorkers();
  }, 9000);
}

function ingestAnnouncement(event, relayUrl) {
  // Relays (or anyone who can write to one) can push anything; only signed,
  // well-formed, fresh announcements count.
  if (!isEventObject(event)) return false;
  if (event.kind !== KIND_SERVER_ANNOUNCEMENT && event.kind !== KIND_TOOLS_LIST) return false;
  if (!announcementFresh(event)) return false;
  if (!verifyEvent(event)) return false;
  const pubkey = event.pubkey;
  if (!discovered.has(pubkey)) {
    discovered.set(pubkey, { pubkey, name: null, about: null, tools: [], caps: new Map(), relays: new Set(), lastAnnounced: 0 });
  }
  const worker = discovered.get(pubkey);
  worker.relays.add(relayUrl);
  worker.lastAnnounced = Math.max(worker.lastAnnounced || 0, event.created_at);
  for (const tag of event.tags) {
    if (!Array.isArray(tag)) continue;
    if (tag[0] === "name" && tag[1]) worker.name = tag[1];
    if (tag[0] === "about" && tag[1]) worker.about = tag[1];
    if (tag[0] === "cap" && tag[1]) worker.caps.set(tag[1], { range: tag[2], unit: tag[3] });
    if (tag[0] === "agent" && tag[1] === "hench") worker.isHench = true;
  }
  // Marker tag is authoritative; name/about fallback covers pre-tag builds.
  if (event.kind === KIND_SERVER_ANNOUNCEMENT && !worker.isHench) {
    const payload = parseJson(event.content) || {};
    if (payload.name === "Hench" || String(payload.about || "").startsWith("Hench:")) worker.isHench = true;
  }
  if (event.kind === KIND_TOOLS_LIST) {
    const payload = parseJson(event.content);
    const tools = Array.isArray(payload?.tools) ? payload.tools : [];
    for (const tool of tools) {
      if (!tool?.name || worker.tools.some((t) => t.name === tool.name)) continue;
      const schema = tool.inputSchema && typeof tool.inputSchema === "object" ? tool.inputSchema : {};
      const properties = schema.properties && typeof schema.properties === "object" ? schema.properties : {};
      worker.tools.push({
        name: tool.name,
        description: typeof tool.description === "string" ? tool.description : "",
        inputSchema: { ...schema, type: "object", properties },
      });
    }
  }
  if (event.kind === KIND_SERVER_ANNOUNCEMENT) {
    const payload = parseJson(event.content);
    if (payload?.name) worker.name = payload.name;
    if (payload?.about) worker.about = payload.about;
  }
  return true;
}

function renderWorkers() {
  // Live workers re-announce on every boot; stale announcements (debug ghosts,
  // offline phones) are hidden after STALE_AFTER_S.
  const allWorkers = [...discovered.values()].filter((worker) => worker.tools.length > 0);
  const henchOnly = els.henchOnlyToggle.checked;
  const fresh = allWorkers.filter((worker) => Date.now() / 1000 - worker.lastAnnounced < STALE_AFTER_S);
  const workers = fresh
    .filter((worker) => !henchOnly || worker.isHench)
    .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  const staleCount = allWorkers.length - fresh.length;
  const otherCount = fresh.filter((w) => !w.isHench).length;

  els.workerEmptyState.textContent = workers.length === 0 ? "No Hench workers found on these relays" : "";
  const notes = [];
  if (staleCount > 0) notes.push(`${staleCount} offline (no announcement in 12h)`);
  if (henchOnly && otherCount > 0) notes.push(`${otherCount} non-Hench ContextVM server${otherCount === 1 ? "" : "s"} hidden`);
  if (notes.length > 0) {
    const note = document.createElement("small");
    note.className = "stale-note";
    note.textContent = `${notes.join(" · ")} — hidden`;
    els.workerEmptyState.hidden = false;
    els.workerEmptyState.textContent = "";
    els.workerEmptyState.append(note);
  }
  els.workerList.replaceChildren();

  const previous = els.workerSelect.value;
  els.workerSelect.replaceChildren(new Option("select a worker…", ""));
  for (const worker of workers) {
    els.workerSelect.append(new Option(`${worker.name || shortId(worker.pubkey)} (${worker.tools.length} tools)`, worker.pubkey));
  }
  if (previous && workers.some((worker) => worker.pubkey === previous)) els.workerSelect.value = previous;
  const selectedPubkey = els.workerSelect.value;

  for (const worker of workers) {
    const card = document.createElement("article");
    card.className = "worker-card";
    card.dataset.pubkey = worker.pubkey;
    if (worker.pubkey === selectedPubkey) card.classList.add("selected");

    const identity = document.createElement("div");
    identity.className = "worker-identity";

    const label = document.createElement("strong");
    label.className = "worker-name";
    label.textContent = worker.name || shortId(worker.pubkey);
    if (!worker.isHench) {
      const badge = document.createElement("em");
      badge.className = "non-hench-badge";
      badge.textContent = "not hench";
      label.append(" ", badge);
    }

    const npub = toNpub(worker.pubkey);
    const npubRow = document.createElement("div");
    npubRow.className = "npub-row";
    const npubEl = document.createElement("code");
    npubEl.className = "npub-value";
    npubEl.textContent = npub;
    npubEl.title = npub;
    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "npub-copy";
    copyBtn.textContent = "Copy";
    copyBtn.title = "Copy full npub";
    copyBtn.addEventListener("click", async (event) => {
      event.stopPropagation();
      await navigator.clipboard.writeText(npub);
      copyBtn.textContent = "Copied";
      setTimeout(() => (copyBtn.textContent = "Copy"), 1200);
    });
    npubRow.addEventListener("click", (event) => event.stopPropagation());
    npubRow.append(npubEl, copyBtn);

    const sub = document.createElement("small");
    const ageMin = Math.max(0, Math.round((Date.now() / 1000 - worker.lastAnnounced) / 60));
    const age = ageMin < 60 ? `${ageMin}m ago` : ageMin < 2880 ? `${Math.round(ageMin / 60)}h ago` : `${Math.round(ageMin / 1440)}d ago`;
    sub.textContent = `${worker.tools.length} tools · ${worker.relays.size} relays · seen ${age}`;

    identity.append(label, npubRow, sub);
    card.append(identity);
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
      highlightSelectedWorker();
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
  const previousTool = els.toolSelect.value;
  els.toolSelect.replaceChildren(new Option("select a tool…", ""));
  if (worker) for (const tool of worker.tools) els.toolSelect.append(new Option(tool.name, tool.name));
  els.toolSelect.disabled = !worker;
  if (previousTool && worker?.tools.some((tool) => tool.name === previousTool)) {
    els.toolSelect.value = previousTool;
  }
  renderToolFields();
}

function renderToolFields() {
  const worker = discovered.get(els.workerSelect.value);
  const tool = worker?.tools.find((t) => t.name === els.toolSelect.value);
  els.toolFields.replaceChildren();
  if (!tool) return;

  const schema = tool.inputSchema || {};
  const requiredNames = new Set(schema.required || []);
  const properties = Object.entries(schema.properties || {});

  if (tool.description) {
    const desc = document.createElement("p");
    desc.className = "tool-description";
    desc.textContent = tool.description;
    els.toolFields.append(desc);
  }

  if (properties.length === 0) {
    if (!tool.description) {
      const note = document.createElement("p");
      note.className = "hint";
      note.textContent = "This tool takes no parameters.";
      els.toolFields.append(note);
    }
    return;
  }

  const required = properties.filter(([name]) => requiredNames.has(name));
  const optional = properties.filter(([name]) => !requiredNames.has(name));

  if (required.length) {
    const group = document.createElement("div");
    group.className = "param-group param-required";
    const heading = document.createElement("h3");
    heading.className = "param-heading";
    heading.textContent = "Required";
    group.append(heading);
    for (const [name, property] of required) group.append(createField(name, property, true));
    els.toolFields.append(group);
  } else if (optional.length) {
    const note = document.createElement("p");
    note.className = "hint";
    note.textContent = "No required parameters.";
    els.toolFields.append(note);
  }

  if (optional.length) {
    const details = document.createElement("details");
    details.className = "param-group param-optional";
    const summary = document.createElement("summary");
    summary.textContent = optional.length === 1 ? "Optional parameter" : `Optional parameters · ${optional.length}`;
    details.append(summary);
    for (const [name, property] of optional) details.append(createField(name, property, false));
    els.toolFields.append(details);
  }
}

function createField(name, property, isRequired) {
  const type = schemaType(property);
  const wrap = document.createElement("label");
  wrap.className = type === "boolean" ? "field field-check" : "field";

  const head = document.createElement("span");
  head.className = "field-label";
  const title = document.createElement("span");
  title.className = "field-name";
  title.textContent = name;
  const badge = document.createElement("span");
  badge.className = isRequired ? "badge badge-required" : "badge badge-optional";
  badge.textContent = isRequired ? "required" : "optional";
  head.append(title, badge);
  wrap.append(head);

  let input;
  if (Array.isArray(property.enum)) {
    input = document.createElement("select");
    if (!isRequired) input.append(new Option("—", ""));
    for (const value of property.enum) input.append(new Option(String(value), String(value)));
    if (property.default !== undefined) input.value = String(property.default);
  } else if (type === "boolean") {
    const row = document.createElement("span");
    row.className = "check-row";
    input = document.createElement("input");
    input.type = "checkbox";
    input.checked = property.default === true;
    const checkLabel = document.createElement("span");
    checkLabel.textContent = property.default === true ? "On" : "Off";
    input.addEventListener("change", () => {
      checkLabel.textContent = input.checked ? "On" : "Off";
    });
    row.append(input, checkLabel);
    wrap.append(row);
  } else if (type === "integer" || type === "number") {
    input = document.createElement("input");
    input.type = "number";
    if (type === "integer") input.step = "1";
    if (property.minimum !== undefined) input.min = String(property.minimum);
    if (property.maximum !== undefined) input.max = String(property.maximum);
    if (property.default !== undefined) input.value = String(property.default);
  } else if (useTextarea(name, property)) {
    input = document.createElement("textarea");
    input.rows = 6;
    input.spellcheck = false;
    if (property.default !== undefined) input.value = String(property.default);
  } else {
    input = document.createElement("input");
    input.type = property.format === "uri" || /url$/i.test(name) ? "url" : "text";
    if (property.default !== undefined) input.value = String(property.default);
  }

  if (type !== "boolean") wrap.append(input);
  input.dataset.argName = name;
  input.dataset.argType = type;
  if (isRequired) input.dataset.required = "true";
  if (isRequired && type !== "boolean") input.required = true;
  const example = property.examples?.[0] ?? property.example;
  if (example !== undefined && input.placeholder !== undefined && !input.value) {
    input.placeholder = String(example);
  }

  if (property.description) {
    const hint = document.createElement("small");
    hint.className = "field-hint";
    hint.textContent = property.description;
    wrap.append(hint);
  }
  return wrap;
}

function schemaType(property) {
  const type = property?.type;
  if (Array.isArray(type)) return type.find((entry) => entry !== "null") || "string";
  return type || "string";
}

function useTextarea(name, property) {
  if (property.maxLength && property.maxLength <= 120) return false;
  if (property.maxLength && property.maxLength >= 200) return true;
  return /^(script|code|body|content|text|prompt|source|css|html|markdown)$/i.test(name);
}

function highlightSelectedWorker() {
  const pubkey = els.workerSelect.value;
  for (const card of els.workerList.querySelectorAll(".worker-card")) {
    card.classList.toggle("selected", card.dataset.pubkey === pubkey);
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
      if (input.checked || input.dataset.required === "true") args[name] = input.checked;
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
  if (!els.argsJson.value.trim() && !els.form.reportValidity()) return;
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
    if (response.error) throw new Error(response.error.message || "tool error");
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
    this.invocations = new InvocationRouter(); // request inner-event id -> pending call
    this.closed = false;
  }

  async start() {
    const since = Math.floor(Date.now() / 1000) - 90;
    await Promise.allSettled(this.relays.map((url) => this.openRelay(url, since)));
    if (!this.sockets.size) throw new Error("could not connect any relay");
    await this.request({
      jsonrpc: "2.0",
      id: this.invocations.takeId(),
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
        if (this.closed) { closeQuietly(socket); return resolve(); }
        socket.send(JSON.stringify([
          "REQ",
          `hench-${Math.random().toString(36).slice(2, 10)}`,
          { kinds: [KIND_WRAP, KIND_WRAP_ALT], "#p": [this.clientPubkey], since },
        ]));
        this.sockets.set(relayUrl, socket);
        resolve();
      });
      socket.addEventListener("message", ({ data }) => this.handleFrame(data));
      socket.addEventListener("error", () => { closeQuietly(socket); resolve(); });
      socket.addEventListener("close", () => resolve());
      setTimeout(() => {
        // Never opened in time — close it so a late open can't subscribe and leak.
        if (!this.sockets.has(relayUrl)) closeQuietly(socket);
        resolve();
      }, 5000);
    });
  }

  handleFrame(raw) {
    let message;
    try { message = JSON.parse(raw); } catch { return; }
    if (!Array.isArray(message) || message[0] !== "EVENT" || !message[2]) return;
    const event = message[2];
    if ((event.kind !== KIND_WRAP && event.kind !== KIND_WRAP_ALT) || this.seen.has(event.id)) return;
    if (!Array.isArray(event.tags) || !event.tags.some((t) => Array.isArray(t) && t[0] === "p" && t[1] === this.clientPubkey)) return;
    this.seen.add(event.id);
    let inner;
    try {
      const key = nip44.v2.utils.getConversationKey(this.sk, event.pubkey);
      inner = JSON.parse(nip44.decrypt(event.content, key));
    } catch { return; }
    // The gift wrap is ephemeral-signed; identity is proven by the inner
    // event's schnorr signature — without this anyone can claim inner.pubkey.
    if (!fromWorker(inner, this.serverPubkey) || !verifyEvent(inner)) return;
    // Route strictly by invocation: the inner event must "e"-tag one of this
    // session's own request event ids. A replayed prior-session invoice or
    // result — even one genuinely signed by this worker — names a request
    // event this session never published, so it is dropped here.
    const routed = this.invocations.route(inner);
    if (!routed) return;
    if (routed.type === "notification") this.handleNotification(routed.payload);
    else routed.entry.resolve(routed.payload);
  }

  handleNotification(notification) {
    const method = notification.method || "";
    const params = notification.params && typeof notification.params === "object" ? notification.params : {};
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

  // Returns { wrap, innerId }: innerId is the signed request/notification
  // event id the worker "e"-tags its reply to.
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
    const wrap = finalizeEvent(
      {
        kind: KIND_WRAP,
        created_at: Math.floor(Date.now() / 1000),
        tags: [["p", this.serverPubkey]],
        content: ciphertext,
      },
      ephemeral,
    );
    return { wrap, innerId: inner.id };
  }

  broadcast(message) {
    const { wrap } = this.wrap(message);
    for (const socket of this.sockets.values()) {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(["EVENT", wrap]));
    }
  }

  request(message, timeoutMs = 20000, progressToken) {
    return new Promise((resolve, reject) => {
      const { wrap, innerId } = this.wrap(message);
      // Correlation key = this request's signed inner-event id (what the
      // worker e-tags back), not the JSON-RPC id — replayed events can't
      // mint a matching one.
      this.invocations.register(innerId, message.id, progressToken, resolve);
      for (const socket of this.sockets.values()) {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(["EVENT", wrap]));
      }
      setTimeout(() => {
        if (this.invocations.drop(innerId)) {
          reject(new Error(`no response to ${message.method} — worker offline?`));
        }
      }, timeoutMs);
    });
  }

  async callTool(toolName, args) {
    const id = this.invocations.takeId();
    return this.request({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: toolName, arguments: args, _meta: { progressToken: id } },
    }, 10 * 60 * 1000, id);
  }

  close() {
    this.closed = true;
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
    onPaymentRequired(params = {}) {
      const bolt11 = cleanBolt11(params.pay_req);
      if (!bolt11) {
        this.step("payment_required arrived with a malformed invoice — ignored");
        return;
      }
      invoiceEl.hidden = false;
      this.setState("Payment required", "");
      this.step(`invoice: ${params.amount ?? "?"} sats (ttl ${params.ttl ?? "?"}s)`);
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
      invoiceEl.hidden = true;
      resultEl.hidden = false;
      resultEl.textContent = text;
      this.setState("Complete", "live");
      this.step("result delivered");
    },
    onFailed(message) {
      invoiceEl.hidden = true;
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
  // Persistent key = stable invocation identity (replays return cached results
  // without a second invoice). Falls back to an ephemeral key when storage is
  // unavailable (private windows, storage disabled).
  try {
    let hex = localStorage.getItem(CLIENT_SECRET_KEY);
    if (!hex || !/^[0-9a-f]{64}$/i.test(hex)) {
      hex = bytesToHex(generateSecretKey());
      localStorage.setItem(CLIENT_SECRET_KEY, hex);
    }
    return hex;
  } catch {
    return bytesToHex(generateSecretKey());
  }
}
function relayUrls() {
  return els.relayUrls.value.split(/\n+/).map((s) => s.trim()).filter(Boolean);
}
function parseJson(text) { try { return JSON.parse(text); } catch { return null; } }
function shortId(id) { return `${id.slice(0, 8)}…${id.slice(-4)}`; }
function toNpub(hex) {
  try { return npubEncode(hex); } catch { return hex; }
}
function closeQuietly(socket) { try { socket.close(1000, "done"); } catch { /* closed */ } }
function setConnection(text, mode) {
  els.connectionState.textContent = text;
  els.connectionState.className = `connection-pill${mode === "error" ? " error" : mode === "live" ? " live" : ""}`;
}
