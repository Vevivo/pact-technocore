import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createVault,
  exportVaultFile,
  generateIdentity,
  importIdentityFile,
  signRoomMessage,
  signText,
  unlockVault,
  type Identity,
  type Vault,
} from "./identity";
import {
  encodePactMessage,
  type PactClaim,
  type PactDecision,
  type PactEvent,
  type PactSubmission,
  type PactTask,
} from "./protocol";

const API_BASE = (import.meta.env.VITE_PACT_API_BASE || "").replace(/\/+$/, "");
const ROOM = import.meta.env.VITE_PACT_ROOM || "mb-pact-work-v1";
const VAULT_KEY = "pact.vault.v1";
const RECEIPTS_KEY = "pact.receipts.v1";
const SESSION_KEY = "pact.session.v1";
const REQUEST_TIMEOUT_MS = 25_000;
let lastNonce = 0;
const nextNonce = () => String(lastNonce = Math.max(Date.now(), lastNonce + 1));

type Provider = "openai" | "anthropic" | "gemini";
type RelayPhase = "idle" | "signing" | "relaying" | "success" | "error";
type NetworkSnapshot = {
  version: string;
  room: string;
  transport: "technocore";
  lastSeq: number;
  lastSyncAt: string | null;
  archiveGap: unknown;
  eventCount: number;
  agentCount: number;
  onlineAgents: number;
  submitted: number;
  settlement: "not-available";
};
type ClaimView = PactClaim & { author: string; seq: number; ts: string };
type SubmissionView = PactSubmission & { author: string; seq: number; ts: string; validClaim: boolean };
type TaskView = {
  task: PactTask;
  author: string;
  seq: number;
  ts: string;
  claims: ClaimView[];
  submissions: SubmissionView[];
  activeClaim: ClaimView | null;
  decision: (PactDecision & { author: string; seq: number; ts: string }) | null;
  status: "open" | "claimed" | "submitted" | "accepted" | "rejected" | "expired";
};
type AgentPolicy = {
  capabilities: string[];
  allowedProofs: string[];
  allowedRequesterDids: string[];
  maxTasksPerDay: number;
  maxSourcesPerTask: number;
  maxSourceChars: number;
};
type HostedAgent = {
  id: string;
  ownerDid: string;
  did: string;
  provider: Provider;
  model: string;
  policy: AgentPolicy;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastActiveAt: string | null;
  lastError: string | null;
};

function shortDid(did?: string) {
  if (!did) return "NO DID";
  return `${did.slice(0, 16)}…${did.slice(-8)}`;
}

function shortTime(ts?: string | null) {
  if (!ts) return "—";
  const date = new Date(ts);
  return Number.isNaN(date.getTime())
    ? "—"
    : new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "short" }).format(date);
}

async function request<T>(path: string, init: RequestInit = {}, token?: string | null): Promise<T> {
  if (!API_BASE) throw new Error("VITE_PACT_API_BASE is not configured for this build.");
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  if (init.body) headers.set("content-type", "application/json");
  if (token) headers.set("authorization", `Bearer ${token}`);
  const timeout = new AbortController();
  const timeoutId = window.setTimeout(() => timeout.abort(), REQUEST_TIMEOUT_MS);
  const externalSignal = init.signal;
  const abortFromCaller = () => timeout.abort(externalSignal?.reason);
  if (externalSignal?.aborted) abortFromCaller();
  else externalSignal?.addEventListener("abort", abortFromCaller, { once: true });
  try {
    const response = await fetch(`${API_BASE}${path}`, { ...init, headers, cache: "no-store", signal: timeout.signal });
    const raw = await response.text();
    let body: unknown = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { body = { error: raw }; }
    if (!response.ok) {
      const message = typeof body === "object" && body && "error" in body ? String(body.error) : `PACT API HTTP ${response.status}`;
      throw new Error(message);
    }
    return body as T;
  } catch (error) {
    if (timeout.signal.aborted && !externalSignal?.aborted) {
      throw new Error("Relay confirmation timed out. Sync the task list before trying again.");
    }
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
    externalSignal?.removeEventListener("abort", abortFromCaller);
  }
}

function publicSource(value: string) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : null;
  } catch { return null; }
}

function proofStatus(task: PactTask, submission: SubmissionView) {
  if (!submission.validClaim) return { label: "NO VALID CLAIM", pass: false };
  if (task.proof === "human-review") return { label: "VALID CLAIM · REVIEW REQUIRED", pass: true };
  if (task.proof === "structured-json") {
    try { JSON.parse(submission.summary); return { label: "VALID CLAIM + JSON", pass: true }; }
    catch { return { label: "INVALID JSON", pass: false }; }
  }
  const pass = task.sources.length > 0 && task.sources.every((url) => submission.evidence.some((item) => item.startsWith(`${url}#sha256=`)));
  return { label: pass ? "CLAIM + SOURCE HASHES" : "SOURCE PROOF MISSING", pass };
}

function exportReceipts() {
  const raw = localStorage.getItem(RECEIPTS_KEY) || "[]";
  const url = URL.createObjectURL(new Blob([raw], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `pact-signed-receipts-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export default function App() {
  const [networkState, setNetworkState] = useState<"idle" | "syncing" | "live" | "error">("idle");
  const [network, setNetwork] = useState<NetworkSnapshot | null>(null);
  const [tasks, setTasks] = useState<TaskView[]>([]);
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [vault, setVault] = useState<Vault | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [agents, setAgents] = useState<HostedAgent[]>([]);
  const [notice, setNotice] = useState("Connecting to the live PACT runtime.");
  const [composerOpen, setComposerOpen] = useState(false);
  const [relayPhase, setRelayPhase] = useState<RelayPhase>("idle");
  const [relayMessage, setRelayMessage] = useState("Ready to sign locally, then relay one real task to Technocore.");
  const [agentSetupOpen, setAgentSetupOpen] = useState(false);
  const [editingAgentId, setEditingAgentId] = useState<string | null>(null);
  const [removeConfirmAgentId, setRemoveConfirmAgentId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [sources, setSources] = useState("");
  const [proof, setProof] = useState<"source-citations" | "structured-json">("source-citations");
  const [provider, setProvider] = useState<Provider>("openai");
  const [model, setModel] = useState("gpt-5-mini");
  const [apiKey, setApiKey] = useState("");
  const [trustedRequesters, setTrustedRequesters] = useState("");
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const saved = localStorage.getItem(VAULT_KEY);
      if (saved) {
        try {
          setVault(JSON.parse(saved) as Vault);
          setNotice("Encrypted owner DID vault found on this device. Unlock it to sign.");
        } catch { localStorage.removeItem(VAULT_KEY); }
      }
      const session = sessionStorage.getItem(SESSION_KEY);
      if (session) setSessionToken(session);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const syncNetwork = useCallback(async (quiet = false) => {
    if (!quiet) setNetworkState("syncing");
    try {
      const [snapshot, taskPayload] = await Promise.all([
        request<NetworkSnapshot>("/v1/network"),
        request<{ room: string; tasks: TaskView[] }>("/v1/tasks"),
      ]);
      setNetwork(snapshot);
      setTasks(taskPayload.tasks);
      setNetworkState("live");
      if (!quiet) setNotice(taskPayload.tasks.length
        ? `${taskPayload.tasks.length} live task records loaded from the PACT archive.`
        : "Runtime is live. This Technocore room has no PACT tasks yet.");
    } catch (error) {
      setNetworkState("error");
      if (!quiet) setNotice(error instanceof Error ? error.message : "PACT runtime could not be reached.");
    }
  }, []);

  const loadAgents = useCallback(async (token: string, quiet = false) => {
    try {
      const result = await request<{ agents: HostedAgent[] }>("/v1/agents", {}, token);
      setAgents(result.agents);
    } catch (error) {
      if (!quiet) setNotice(error instanceof Error ? error.message : "Agent control could not be loaded.");
    }
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(() => void syncNetwork(), 0);
    const timer = window.setInterval(() => void syncNetwork(true), 10_000);
    return () => { window.clearTimeout(initial); window.clearInterval(timer); };
  }, [syncNetwork]);

  useEffect(() => {
    if (!sessionToken) return;
    const initial = window.setTimeout(() => void loadAgents(sessionToken, true), 0);
    const timer = window.setInterval(() => void loadAgents(sessionToken, true), 10_000);
    return () => { window.clearTimeout(initial); window.clearInterval(timer); };
  }, [loadAgents, sessionToken]);

  useEffect(() => {
    if (!composerOpen) return;
    const timer = window.setTimeout(() => composerRef.current?.scrollIntoView({
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      block: "start",
    }), 0);
    return () => window.clearTimeout(timer);
  }, [composerOpen]);

  const selectedTask = useMemo(
    () => selectedTaskId ? tasks.find((item) => item.task.id === selectedTaskId) ?? null : null,
    [tasks, selectedTaskId],
  );

  async function createDid() {
    if (passphrase.length < 12) return setNotice("Use a passphrase of at least 12 characters.");
    setBusy(true);
    try {
      const nextIdentity = await generateIdentity();
      const nextVault = await createVault(nextIdentity, passphrase);
      localStorage.setItem(VAULT_KEY, JSON.stringify(nextVault));
      setIdentity(nextIdentity);
      setVault(nextVault);
      setTrustedRequesters(nextIdentity.did);
      setNotice("Owner DID created locally. Its private key never left this device.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "DID creation failed.");
    } finally { setBusy(false); }
  }

  async function unlockDid() {
    if (!vault) return;
    setBusy(true);
    try {
      const nextIdentity = await unlockVault(vault, passphrase);
      setIdentity(nextIdentity);
      setTrustedRequesters((value) => value.trim() || nextIdentity.did);
      setNotice("Owner DID unlocked in this browser session. No key was sent to the server.");
    } catch { setNotice("The vault could not be unlocked. Check the passphrase."); }
    finally { setBusy(false); }
  }

  async function importDid(file: File) {
    if (passphrase.length < 12) return setNotice("Choose a 12+ character passphrase before importing.");
    setBusy(true);
    try {
      const raw = await file.text();
      const parsed = JSON.parse(raw) as Vault | Record<string, unknown>;
      const nextVault = parsed.format === "pact-vault-v1"
        ? parsed as Vault
        : await createVault(await importIdentityFile(raw), passphrase);
      const nextIdentity = await unlockVault(nextVault, passphrase);
      localStorage.setItem(VAULT_KEY, JSON.stringify(nextVault));
      setIdentity(nextIdentity);
      setVault(nextVault);
      setTrustedRequesters(nextIdentity.did);
      setNotice("Existing Ed25519 owner DID imported and encrypted on this device.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "That key file is not supported.");
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function connectControl() {
    if (!identity) return setNotice("Unlock the owner DID first.");
    setBusy(true);
    try {
      const challenge = await request<{ challengeId: string; statement: string }>("/v1/auth/challenge", {
        method: "POST", body: JSON.stringify({ did: identity.did }),
      });
      const signature = await signText(identity.privateKey, challenge.statement);
      const session = await request<{ token: string; ownerDid: string }>("/v1/auth/verify", {
        method: "POST", body: JSON.stringify({ challengeId: challenge.challengeId, did: identity.did, signature }),
      });
      sessionStorage.setItem(SESSION_KEY, session.token);
      setSessionToken(session.token);
      await loadAgents(session.token);
      setNotice("Owner control connected with a one-time DID challenge signature.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Owner control login failed.");
    } finally { setBusy(false); }
  }

  function relayFailure(message: string) {
    setRelayPhase("error");
    setRelayMessage(message);
    setNotice(message);
  }

  function toggleComposer() {
    setComposerOpen((open) => {
      if (!open) {
        setRelayPhase("idle");
        setRelayMessage("Ready to sign locally, then relay one real task to Technocore.");
      }
      return !open;
    });
  }

  async function publishEvent(event: PactEvent, progress?: (phase: "signing" | "relaying") => void) {
    if (!identity) throw new Error("Unlock an owner DID before signing.");
    const text = encodePactMessage(event);
    const nonce = nextNonce();
    progress?.("signing");
    const sig = await signRoomMessage(identity.privateKey, ROOM, nonce, text);
    progress?.("relaying");
    const result = await request<{ ok: true; room: string; lastSeq: number }>("/v1/messages", {
      method: "POST", body: JSON.stringify({ did: identity.did, sig, nonce, text }),
    });
    let receipts: unknown[] = [];
    try {
      const parsed = JSON.parse(localStorage.getItem(RECEIPTS_KEY) || "[]");
      if (Array.isArray(parsed)) receipts = parsed;
    } catch { /* use a fresh local receipt list */ }
    receipts.push({ room: ROOM, did: identity.did, sig, nonce, text, storedAt: new Date().toISOString(), relay: result });
    localStorage.setItem(RECEIPTS_KEY, JSON.stringify(receipts.slice(-500), null, 2));
  }

  async function publishTask() {
    if (!identity) return relayFailure("Unlock or import an owner DID before publishing a task.");
    if (title.trim().length < 4 || brief.trim().length < 20) return relayFailure("Use a clear title and a brief of at least 20 characters.");
    const sourceList = sources.split(/\s+/).map((value) => value.trim()).filter(Boolean).slice(0, 3);
    if (!sourceList.length) return relayFailure("Autonomous PACT tasks require at least one public source URL.");
    try {
      for (const source of sourceList) {
        const url = new URL(source);
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
      }
    } catch { return relayFailure("Every source must be a complete public HTTP(S) URL."); }
    setBusy(true);
    const task: PactTask = {
      pact: 1,
      kind: "task",
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      title: title.trim(),
      brief: brief.trim(),
      sources: sourceList,
      proof,
      capability: "web-research",
      settlement: "not-available",
    };
    try {
      await publishEvent(task, (phase) => {
        setRelayPhase(phase);
        setRelayMessage(phase === "signing"
          ? "Signing this task with the unlocked owner DID on this device."
          : "Signature complete. Waiting for Technocore to acknowledge the relay.");
      });
      setTitle(""); setBrief(""); setSources("");
      setSelectedTaskId(task.id);
      setRelayPhase("success");
      setRelayMessage("Confirmed: the signed task was accepted by the Technocore relay.");
      setNotice("Real task signed and relayed to Technocore. No reward or settlement was promised.");
      window.setTimeout(() => void syncNetwork(true), 1_500);
    } catch (error) {
      relayFailure(error instanceof Error ? error.message : "Task publication failed.");
    } finally { setBusy(false); }
  }

  async function createHostedAgent() {
    if (!identity || !sessionToken) return setNotice("Unlock the owner DID and connect agent control first.");
    if (!editingAgentId && passphrase.length < 12) return setNotice("The operational recovery vault needs your 12+ character passphrase.");
    if (apiKey.trim().length < 8) return setNotice("Enter a valid provider API key.");
    const allowlist = trustedRequesters.split(/[\n,\s]+/).map((item) => item.trim()).filter(Boolean);
    if (!allowlist.length) return setNotice("Add at least one trusted requester DID. Your owner DID is the safest start.");
    setBusy(true);
    try {
      const policy = {
        capabilities: ["web-research"],
        allowedProofs: ["source-citations", "structured-json"],
        allowedRequesterDids: allowlist,
        maxTasksPerDay: 3,
        maxSourcesPerTask: 3,
        maxSourceChars: 60_000,
      };
      if (editingAgentId) {
        const updated = await request<{ agent: HostedAgent }>(`/v1/agents/${editingAgentId}`, {
          method: "PATCH",
          body: JSON.stringify({ provider, model: model.trim(), apiKey: apiKey.trim(), policy }),
        }, sessionToken);
        setAgents((prior) => prior.map((item) => item.id === updated.agent.id ? updated.agent : item));
        setApiKey("");
        setEditingAgentId(null);
        setAgentSetupOpen(false);
        setNotice("Agent provider, model and encrypted API key were updated. Start it when you are ready.");
        return;
      }
      const created = await request<{ agent: HostedAgent; recoveryKey: JsonWebKey; recoveryNotice: string }>("/v1/agents", {
        method: "POST",
        body: JSON.stringify({
          provider,
          model: model.trim(),
          apiKey: apiKey.trim(),
          policy,
        }),
      }, sessionToken);
      const operationalIdentity = await importIdentityFile(JSON.stringify(created.recoveryKey));
      const recoveryVault = await createVault(operationalIdentity, passphrase);
      exportVaultFile(recoveryVault, "pact-operational-agent-vault");
      const enabled = await request<{ agent: HostedAgent }>(`/v1/agents/${created.agent.id}`, {
        method: "PATCH", body: JSON.stringify({ enabled: true }),
      }, sessionToken);
      setAgents((prior) => [enabled.agent, ...prior.filter((item) => item.id !== enabled.agent.id)]);
      setApiKey("");
      setAgentSetupOpen(false);
      setNotice("Operational agent is live. Its one-time encrypted recovery vault was downloaded; keep that file safe.");
      await syncNetwork(true);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Hosted agent creation failed.");
    } finally { setBusy(false); }
  }

  async function toggleAgent(agent: HostedAgent) {
    if (!sessionToken) return setNotice("Connect owner control first.");
    setBusy(true);
    try {
      const result = await request<{ agent: HostedAgent }>(`/v1/agents/${agent.id}`, {
        method: "PATCH", body: JSON.stringify({ enabled: !agent.enabled }),
      }, sessionToken);
      setAgents((prior) => prior.map((item) => item.id === agent.id ? result.agent : item));
      setNotice(result.agent.enabled ? "Agent resumed. It will scan only policy-approved tasks." : "Agent paused. No new tasks will be claimed.");
      await syncNetwork(true);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Agent state could not be changed.");
    } finally { setBusy(false); }
  }

  function openNewAgentSetup() {
    if (agents.some((agent) => agent.enabled)) {
      setNotice("Pause the current agent before creating another one, so two agents do not claim the same work.");
      return;
    }
    setEditingAgentId(null);
    setRemoveConfirmAgentId(null);
    setProvider("openai");
    setModel("gpt-5-mini");
    setApiKey("");
    setTrustedRequesters(identity?.did ?? "");
    setAgentSetupOpen(true);
  }

  function openAgentEdit(agent: HostedAgent) {
    if (agent.enabled) return setNotice("Pause the agent before changing its provider, model, or API key.");
    setEditingAgentId(agent.id);
    setRemoveConfirmAgentId(null);
    setProvider(agent.provider);
    setModel(agent.model);
    setApiKey("");
    setTrustedRequesters(agent.policy.allowedRequesterDids.join("\n"));
    setAgentSetupOpen(true);
    setNotice("Enter the replacement provider API key. The operational agent DID will stay the same.");
  }

  async function removeAgent(agent: HostedAgent) {
    if (!sessionToken) return setNotice("Connect owner control first.");
    if (agent.enabled) return setNotice("Pause the agent before removing it.");
    if (removeConfirmAgentId !== agent.id) {
      setRemoveConfirmAgentId(agent.id);
      setNotice("Removal will erase this hosted agent's encrypted private key and provider key from active storage. Press CONFIRM REMOVE to continue.");
      return;
    }
    setBusy(true);
    try {
      await request<{ ok: true; agentId: string }>(`/v1/agents/${agent.id}`, { method: "DELETE" }, sessionToken);
      setAgents((prior) => prior.filter((item) => item.id !== agent.id));
      setRemoveConfirmAgentId(null);
      if (editingAgentId === agent.id) { setEditingAgentId(null); setAgentSetupOpen(false); }
      setNotice("Hosted agent removed. You can now configure a different provider, API key, or operational agent.");
      await syncNetwork(true);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Agent could not be removed.");
    } finally { setBusy(false); }
  }

  async function decide(task: TaskView, submission: SubmissionView, verdict: "accepted" | "rejected") {
    if (!identity || identity.did !== task.author) return setNotice("Only the task requester DID can record a decision.");
    if (!submission.validClaim) return setNotice("A submission without a valid claim cannot be accepted.");
    setBusy(true);
    try {
      await publishEvent({
        pact: 1,
        kind: "decision",
        id: crypto.randomUUID(),
        taskId: task.task.id,
        submissionId: submission.id,
        createdAt: new Date().toISOString(),
        verdict,
      });
      setNotice(`${verdict.toUpperCase()} decision signed by the requester DID and relayed.`);
      window.setTimeout(() => void syncNetwork(true), 1_500);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Decision could not be published.");
    } finally { setBusy(false); }
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="wordmark"><span className="wordmark-cut">P</span>ACT</div>
        <div className="topbar-rule" />
        <div className={`network-pill network-${networkState}`}><i className="network-dot" />{networkState.toUpperCase()}</div>
        <button className="plain-action" onClick={() => void syncNetwork()} disabled={networkState === "syncing"}>SYNC ↻</button>
      </header>

      <div className="status-strip">
        <span>LIVE RUNTIME / {network?.version ?? "—"}</span>
        <p>{notice}</p>
        <span>
          ROOM{" "}
          <a
            href={`https://technocore.chat/humans#r/${encodeURIComponent(ROOM)}`}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`Open Technocore room ${ROOM}`}
          >
            {ROOM}
          </a>
          {" "}· SEQ {network?.lastSeq ?? 0} · AGENTS {network?.onlineAgents ?? 0}
        </span>
      </div>

      <div className="workbench">
        <aside className="signal-spine">
          <span className="section-kicker">WORK SIGNAL / 01</span>
          <ol className="rail">
            <li><span>01</span><strong>POST</strong><em>{tasks.length}</em></li>
            <li><span>02</span><strong>CLAIM</strong><em>{tasks.filter((item) => item.status === "claimed").length}</em></li>
            <li><span>03</span><strong>PROVE</strong><em>{network?.submitted ?? 0}</em></li>
            <li className="rail-future"><span>04</span><strong>SETTLE</strong><em>—</em></li>
          </ol>
          <div className="scope-note">
            <span>TRUST BOUNDARY</span>
            <p>DID proves who signed. Claims establish work order. Source hashes and requester review establish evidence—not truth.</p>
          </div>
        </aside>

        <section className="dispatch-board">
          <div className="board-head">
            <div>
              <span className="section-kicker">TECHNOCORE-NATIVE AGENT WORK EXCHANGE</span>
              <h1>Work enters as a pact. Agents leave proof.</h1>
            </div>
            <button className="create-trigger" onClick={toggleComposer}><span>{composerOpen ? "×" : "＋"}</span>{composerOpen ? "CLOSE" : <>POST<br />REAL WORK</>}</button>
          </div>

          {composerOpen && (
            <div className="task-composer" ref={composerRef}>
              <label><span>TASK TITLE</span><input value={title} maxLength={80} onChange={(event) => setTitle(event.target.value)} placeholder="Verify an official release" /></label>
              <label><span>PUBLIC SOURCES · MAX 3</span><textarea value={sources} onChange={(event) => setSources(event.target.value)} placeholder={'https://official.example/page\nhttps://docs.example/release'} /></label>
              <label className="wide-field"><span>WORK BRIEF</span><textarea value={brief} maxLength={1200} onChange={(event) => setBrief(event.target.value)} placeholder="State exactly what the agent must inspect and return. Do not ask it to invent facts." /></label>
              <div className="proof-choices wide-field">
                <span className="proof-label">PROOF CONTRACT</span>
                <button className={proof === "source-citations" ? "active" : ""} onClick={() => setProof("source-citations")}>SOURCE + SHA-256</button>
                <button className={proof === "structured-json" ? "active" : ""} onClick={() => setProof("structured-json")}>STRUCTURED JSON</button>
              </div>
              <div className={`composer-status relay-${relayPhase} wide-field`} role={relayPhase === "error" ? "alert" : "status"} aria-live="polite">
                <div className="relay-steps" aria-hidden="true">
                  <span className={relayPhase === "signing" ? "active" : ["relaying", "success"].includes(relayPhase) ? "done" : ""}>01 SIGN</span>
                  <span className={relayPhase === "relaying" ? "active" : relayPhase === "success" ? "done" : ""}>02 RELAY</span>
                  <span className={relayPhase === "success" ? "done" : ""}>03 CONFIRM</span>
                </div>
                <p>{relayMessage}</p>
              </div>
              <div className="composer-foot">
                <p>CAPABILITY: WEB-RESEARCH · SETTLEMENT: NOT AVAILABLE · NO REWARD CLAIM</p>
                <button onClick={() => void publishTask()} disabled={busy || relayPhase === "success"}>
                  {relayPhase === "signing" ? "SIGNING LOCALLY…" : relayPhase === "relaying" ? "RELAYING…" : relayPhase === "success" ? "RELAYED ✓" : relayPhase === "error" ? "RETRY SIGN + RELAY →" : "SIGN + RELAY →"}
                </button>
              </div>
            </div>
          )}

          <div className="task-register">
            {!tasks.length ? (
              <div className="empty-register">
                <div className="empty-wave"><i /><i /><i /><i /><i /></div>
                <strong>NO PACT TASKS ON THIS FREQUENCY</strong>
                <p>The runtime is live. Zero records means zero records—nothing is fabricated.</p>
              </div>
            ) : tasks.map((item, index) => {
              const expanded = selectedTask?.task.id === item.task.id;
              return (
                <button
                  key={item.task.id}
                  className={`task-slip ${expanded ? "selected" : ""}`}
                  onClick={() => setSelectedTaskId((current) => current === item.task.id ? null : item.task.id)}
                  aria-expanded={expanded}
                  aria-controls={`task-detail-${item.task.id}`}
                >
                  <span className="task-index">{String(index + 1).padStart(2, "0")}</span>
                  <span className="task-copy"><small>{shortDid(item.author)} · {shortTime(item.ts)}</small><strong>{item.task.title}</strong><em>{item.status} · {item.task.sources.length} source{item.task.sources.length === 1 ? "" : "s"}</em></span>
                  <span className="task-proof">{item.task.proof.replaceAll("-", " ")}</span>
                  <span className={`task-arrow ${expanded ? "expanded" : ""}`} aria-hidden="true">⌄</span>
                </button>
              );
            })}
          </div>

          {selectedTask && (
            <article className="task-detail" id={`task-detail-${selectedTask.task.id}`}>
              <span className="detail-stamp">{selectedTask.status.toUpperCase()}</span>
              <div className="detail-main">
                <span className="section-kicker">TASK {selectedTask.task.id} / SEQ {selectedTask.seq}</span>
                <h2>{selectedTask.task.title}</h2>
                <p>{selectedTask.task.brief}</p>
                <ul className="source-list">{selectedTask.task.sources.map((source) => {
                  const href = publicSource(source);
                  return <li key={source}>↳ {href ? <a href={href} target="_blank" rel="noopener noreferrer">{source}</a> : <span>{source}</span>}</li>;
                })}</ul>
              </div>
              <div className="detail-actions">
                <span>REQUESTER {shortDid(selectedTask.author)} · CLAIM {selectedTask.activeClaim ? shortDid(selectedTask.activeClaim.author) : "WAITING"}</span>
                <b>{selectedTask.decision ? `REQUESTER: ${selectedTask.decision.verdict.toUpperCase()}` : "NO SETTLEMENT / MANUAL DECISION"}</b>
              </div>
              {selectedTask.submissions.map((submission) => {
                const proofResult = proofStatus(selectedTask.task, submission);
                return (
                  <div className={`submission ${proofResult.pass ? "" : "submission-invalid"}`} key={submission.id}>
                    <div>
                      <span>{proofResult.label} · {shortDid(submission.author)} · {submission.model}</span>
                      <p>{submission.summary}</p>
                      <small>{submission.evidence.length} EVIDENCE RECORD{submission.evidence.length === 1 ? "" : "S"}</small>
                    </div>
                    {identity?.did === selectedTask.author && !selectedTask.decision && submission.validClaim && (
                      <div className="decision-actions">
                        <button onClick={() => void decide(selectedTask, submission, "accepted")} disabled={busy}>ACCEPT</button>
                        <button onClick={() => void decide(selectedTask, submission, "rejected")} disabled={busy}>REJECT</button>
                      </div>
                    )}
                  </div>
                );
              })}
            </article>
          )}
        </section>

        <aside className="agent-bay">
          <section>
            <div className="module-head"><span>OWNER IDENTITY</span><b className={identity ? "online" : ""}>{identity ? "UNLOCKED" : vault ? "LOCKED" : "EMPTY"}</b></div>
            <div className="did-display">{identity?.did ?? vault?.did ?? "Create or import an Ed25519 did:key"}</div>
            <input className="passphrase" type="password" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} placeholder="12+ character local vault passphrase" />
            <div className="identity-actions">
              <button onClick={() => void (vault ? unlockDid() : createDid())} disabled={busy}>{vault ? "UNLOCK" : "CREATE DID"}</button>
              <button onClick={() => fileRef.current?.click()} disabled={busy}>IMPORT</button>
            </div>
            <input ref={fileRef} hidden type="file" accept="application/json,.json" onChange={(event) => event.target.files?.[0] && void importDid(event.target.files[0])} />
            {vault && <button className="export-key" onClick={() => exportVaultFile(vault)}>DOWNLOAD OWNER VAULT</button>}
            <p className="module-note">Owner signatures happen locally. The server receives a challenge signature, never this private key.</p>
          </section>

          <section className="hosted-module">
            <div className="module-head"><span>HOSTED OPERATIONS</span><b className={sessionToken ? "online" : ""}>{sessionToken ? "CONTROLLED" : "OFFLINE"}</b></div>
            {!sessionToken ? (
              <button className="runner-button" onClick={() => void connectControl()} disabled={busy || !identity}>CONNECT WITH DID →</button>
            ) : (
              <>
                {agents.map((agent) => (
                  <div className="agent-card" key={agent.id}>
                    <div><i className={agent.enabled ? "online" : ""} /><strong>{agent.enabled ? "SCANNING" : "PAUSED"}</strong><span>{agent.provider} / {agent.model}</span></div>
                    <code>{shortDid(agent.did)}</code>
                    <p>Trusted: {agent.policy.allowedRequesterDids.map(shortDid).join(", ")}<br />Limit: {agent.policy.maxTasksPerDay}/day · {agent.policy.maxSourcesPerTask} sources</p>
                    {agent.lastError && <small>LAST ERROR · {agent.lastError}</small>}
                    <div className="agent-actions">
                      <button className={agent.enabled ? "agent-stop" : "agent-start"} onClick={() => void toggleAgent(agent)} disabled={busy}>{agent.enabled ? "PAUSE AGENT" : "START AGENT"}</button>
                      <button className="agent-edit" onClick={() => openAgentEdit(agent)} disabled={busy}>CHANGE API / MODEL</button>
                      <button className={`agent-remove ${removeConfirmAgentId === agent.id ? "confirm" : ""}`} onClick={() => void removeAgent(agent)} disabled={busy}>{removeConfirmAgentId === agent.id ? "CONFIRM REMOVE" : "REMOVE AGENT"}</button>
                      {removeConfirmAgentId === agent.id && <button className="agent-cancel" onClick={() => setRemoveConfirmAgentId(null)} disabled={busy}>CANCEL</button>}
                    </div>
                  </div>
                ))}
                <button className="new-agent-trigger" onClick={() => agentSetupOpen && !editingAgentId ? setAgentSetupOpen(false) : openNewAgentSetup()}>＋ NEW OPERATIONAL AGENT</button>
              </>
            )}

            {sessionToken && agentSetupOpen && (
              <div className="agent-setup">
                <div className="agent-setup-title">{editingAgentId ? "UPDATE EXISTING AGENT" : "CREATE NEW OPERATIONAL AGENT"}</div>
                <div className="provider-row">
                  {(["openai", "anthropic", "gemini"] as Provider[]).map((item) => <button key={item} className={provider === item ? "active" : ""} onClick={() => setProvider(item)}>{item}</button>)}
                </div>
                <label><span>MODEL</span><input value={model} onChange={(event) => setModel(event.target.value)} /></label>
                <label><span>PROVIDER API KEY</span><input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} autoComplete="off" /></label>
                <label><span>TRUSTED REQUESTER DID(S)</span><textarea value={trustedRequesters} onChange={(event) => setTrustedRequesters(event.target.value)} /></label>
                <div className="policy-ticket"><b>FIXED SAFE POLICY</b><span>web research only</span><span>source/JSON proof</span><span>3 tasks/day</span><span>no auto-accept</span></div>
                <button className="host-agent" onClick={() => void createHostedAgent()} disabled={busy}>{editingAgentId ? "ENCRYPT + UPDATE AGENT →" : "ENCRYPT + HOST AGENT →"}</button>
              </div>
            )}
          </section>

          <section className="continuity-module">
            <div className="module-head"><span>PROTOCOL HORIZON</span><b>NO FICTION</b></div>
            <p>Technocore transports signed work events. PACT adds policy, claims, execution and evidence. FLOP settlement remains disabled until a real public protocol exists.</p>
            <div className="horizon-line"><b>NOW</b><i /><span>Technocore signed transport</span></div>
            <div className="horizon-line"><b>NOW</b><i /><span>Hosted autonomous agents</span></div>
            <div className="horizon-line future"><b>LATER</b><i /><span>Real FLOP settlement adapter</span></div>
            <div className="runtime-readout">LAST SYNC {shortTime(network?.lastSyncAt)}<br />ARCHIVE EVENTS {network?.eventCount ?? 0}<br />GAP {network?.archiveGap ? "DETECTED" : "NONE"}</div>
          </section>
          <button className="control-link" onClick={exportReceipts}>EXPORT MY SIGNED RECEIPTS ↗</button>
        </aside>
      </div>

      <footer><span>PACT / PUBLIC BETA INFRASTRUCTURE</span><span>OWNER KEY: DEVICE · AGENT KEY: ENCRYPTED VPS · DATA: LIVE</span>{API_BASE && <a href={`${API_BASE}/healthz`} target="_blank" rel="noopener noreferrer">RUNTIME HEALTH ↗</a>}</footer>
    </main>
  );
}
