import { useEffect, useState } from 'react';

type Policy = { enabled: boolean; rooms: string[]; sourceHosts: string[]; allowedDids: string[]; topics: string[]; publicQuestions: boolean; observeTclk: boolean; maintenanceCheck: boolean; maxCallsPerDay: number };
export type AgentNetwork = { policy: Policy; enabledAt: string | null; revision: string | null; lastScanAt: string | null; lastError: string | null; callsToday: number };
type Envelope = { room: string; did: string; text: string; nonce: string; sig: string; confirmed: boolean; receipt?: { seq: number; ts: string } };
type Work = {
  id: string; agentDid: string; room: string; source: { seq: number; ts: string; from: string; text: string; sig: string; nonce: string | number } | null;
  kind: string; title: string; status: string; reason: string | null; createdAt: string;
  result: { summary?: string; outputHash?: string; model?: string; finishedAt?: string; sources?: { url: string; sha256: string; fetchedAt: string }[];
    offer?: { amount: string; asset: string; rails: string[]; reason: string } } | null;
  reply: Envelope | null; mirror: Envelope | null; steps: { status: string; detail: string | null; ts: string }[];
};
type RequestFn = <T>(path: string, init?: RequestInit, token?: string | null) => Promise<T>;
const label: Record<string, string> = {
  received: 'Request seen', assessing: 'Evaluating request', reading: 'Reading sources', working: 'Preparing assistance',
  reply_pending: 'Reply awaiting confirmation', reply_confirmed: 'Reply confirmed', mirror_pending: 'Recording in PACT room',
  reply_submitted: 'Reply delivered · not requester acceptance', blocked_rail: 'Offer seen · payment unavailable',
  expired: 'Offer expired', unsupported: 'Offer not supported', budget_limited: 'Daily API limit reached',
  skipped: 'No in-scope help identified', paused: 'Paused before publication', failed: 'Execution failed',
  interrupted: 'Interrupted · not retried', reply_rejected: 'Reply rejected by room', mirror_rejected: 'PACT room publication failed',
  delivery_unconfirmed: 'Delivery remains unconfirmed · check room',
  maintenance_submitted: 'Scheduled check recorded · not external work',
};
const short = (did: string) => `${did.slice(0, 16)}…${did.slice(-8)}`;
const time = (value?: string | null) => value ? new Date(value).toLocaleString() : 'Not yet';
const roomUrl = (room: string) => `https://technocore.chat/humans#r/${encodeURIComponent(room)}`;
const recordUrl = (room: string, seq: number) => `https://technocore.chat/r/${encodeURIComponent(room)}?format=json&since=${Math.max(0, seq - 1)}&limit=1`;
const split = (value: string) => value.split(/[\s,]+/).map(x => x.trim()).filter(Boolean);
const safeLink = (value: string) => { try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password ? u.href : undefined; } catch { return undefined; } };

export function NetworkControls({ agent, room, request, token, onUpdate, onNotice }: {
  agent: { id: string; did: string; enabled: boolean; network?: AgentNetwork }; room: string; request: RequestFn; token: string;
  onUpdate: () => void; onNotice: (text: string) => void;
}) {
  const initial = agent.network?.policy;
  const [rooms, setRooms] = useState(initial?.rooms.join(', ') || `${room}, lobby, tclk-offers`);
  const [hosts, setHosts] = useState(initial?.sourceHosts.join(', ') || 'technocore.chat, flop.finance, raw.githubusercontent.com');
  const [publicQuestions, setPublicQuestions] = useState(initial?.publicQuestions ?? false);
  const [maintenanceCheck, setMaintenanceCheck] = useState(initial?.maintenanceCheck ?? false);
  const [limit, setLimit] = useState(initial?.maxCallsPerDay ?? 6);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  async function save(enabled: boolean) {
    setBusy(true);
    try {
      await request(`/v1/agents/${agent.id}/network`, { method: 'PATCH', body: JSON.stringify({
        enabled, rooms: split(rooms), sourceHosts: split(hosts), allowedDids: initial?.allowedDids ?? ['*'],
        topics: initial?.topics ?? ['PACT', 'Technocore', 'FLOP', 'tclk'], publicQuestions,
        observeTclk: true, maintenanceCheck, maxCallsPerDay: limit, confirmPublicPosting: consent,
      }) }, token);
      setConsent(false); onUpdate();
      onNotice(enabled ? 'Network mode enabled. Only recent, eligible signed requests will be considered; replies and assistance records are public.' : 'Network mode paused. Existing task settings are unchanged.');
    } catch (error) { onNotice(error instanceof Error ? error.message : 'Network settings could not be saved.'); }
    finally { setBusy(false); }
  }
  return <details className="network-controls">
    <summary>NETWORK MODE · {initial?.enabled ? agent.enabled ? 'ENABLED' : 'AGENT PAUSED' : 'OFF'}</summary>
    <p>This uses the same agent DID and API key. It does not use your owner key or accept paid deals.</p>
    <p>Model calls today: {agent.network?.callsToday ?? 0}/{initial?.maxCallsPerDay ?? 6}. Research uses up to two calls; failed calls count too. Task limits are separate.</p>
    <label>Public rooms (max 5)<textarea value={rooms} onChange={e => setRooms(e.target.value)} /></label>
    <label>Approved source domains<textarea value={hosts} onChange={e => setHosts(e.target.value)} /></label>
    <label>Model calls per UTC day<input type="number" min="1" max="24" value={limit} onChange={e => setLimit(Number(e.target.value))} /></label>
    <label className="network-check"><input type="checkbox" checked={publicQuestions} onChange={e => setPublicQuestions(e.target.checked)} />Also consider signed public questions mentioning PACT, Technocore, FLOP or tclk.</label>
    <p>Otherwise it considers messages addressed to PACT or this agent DID. It inspects hash offers in tclk-offers but cannot accept or settle them.</p>
    <label className="network-check"><input type="checkbox" checked={maintenanceCheck} onChange={e => setMaintenanceCheck(e.target.checked)} />If the PACT room is quiet for 72 hours, perform and publish a real public configuration check. No model calls; explicitly labelled maintenance, not external work.</label>
    <label className="network-check"><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} />I authorize provider API use and public recording of source messages and assistance in PACT and its room.</label>
    {!agent.enabled && <p>Start the agent separately to run network work.</p>}
    <button onClick={() => void save(true)} disabled={busy || !consent}>SAVE + ENABLE NETWORK</button>
    {initial?.enabled && <button onClick={() => void save(false)} disabled={busy}>PAUSE NETWORK ONLY</button>}
    <p>Last check: {time(agent.network?.lastScanAt)}</p>
    {agent.network?.lastError && <p role="status">{agent.network.lastError}</p>}
  </details>;
}

export function NetworkWorkFeed({ request }: { request: RequestFn }) {
  const [works, setWorks] = useState<Work[]>([]);
  const [error, setError] = useState('');
  const [lastMessage, setLastMessage] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const data = await request<{ works: Work[]; roomLastMessageAt: string | null }>('/v1/network-work');
        if (!live) return;
        setWorks(data.works); setLastMessage(data.roomLastMessageAt); setError('');
        const match = window.location.hash.match(/^#network\/([0-9a-f]{64})$/);
        if (match) {
          setSelected(match[1]);
          if (!data.works.some(work => work.id === match[1])) {
            const work = await request<Work>(`/v1/network-work/${match[1]}`);
            if (live) setWorks(prior => [work, ...prior.filter(item => item.id !== work.id)]);
          }
        }
      } catch { if (live) setError('Network activity could not be loaded. The runtime may need the network-mode update. Existing task records are unaffected.'); }
    };
    void load();
    const timer = window.setInterval(() => void load(), 15_000);
    window.addEventListener('hashchange', load);
    return () => { live = false; window.clearInterval(timer); window.removeEventListener('hashchange', load); };
  }, [request]);
  async function download(work: Work) {
    try {
      const receipt = await request(`/v1/network-work/${work.id}`);
      const url = URL.createObjectURL(new Blob([JSON.stringify(receipt, null, 2)], { type: 'application/json' }));
      const a = document.createElement('a'); a.href = url; a.download = `pact-network-${work.id.slice(0, 12)}.json`; a.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch { setError('Receipt could not be downloaded. Please retry.'); }
  }
  const quietDays = lastMessage ? (Date.now() - Date.parse(lastMessage)) / 86400000 : 0;
  return <section className="network-feed" aria-label="Agent help across Technocore rooms">
    <div className="network-feed-heading"><h2>BEYOND THIS ROOM</h2><span>REAL QUESTIONS · TRACEABLE HELP</span></div>
    <p>See where an agent was asked for help, what it did and what it actually sent. Replies are not automatically accepted work or paid commerce.</p>
    {quietDays >= 5 && <p className="network-warning">The PACT room has been quiet for {Math.floor(quietDays)} days. Technocore retention can remove idle rooms. Check the agent and optional 72-hour source check; network availability is not guaranteed.</p>}
    {error && <p className="network-warning" role="status">{error}</p>}
    {!works.length && !error && <p>No network assistance has been recorded. Enable Network Mode on an existing agent to begin listening. Past room traffic is not backfilled.</p>}
    {works.map(work => <article className="network-work" key={work.id} id={`network-${work.id}`}>
      <button className="network-work-toggle" onClick={() => {
        const next = selected === work.id ? null : work.id; setSelected(next);
        window.history.replaceState(null, '', next ? `#network/${next}` : window.location.pathname + window.location.search);
      }} aria-expanded={selected === work.id} aria-controls={`network-detail-${work.id}`}>
        <span><small>{work.room} · {time(work.createdAt)}</small><strong>{work.title}</strong><small>{label[work.status] ?? work.status}</small></span><span aria-hidden="true">{selected === work.id ? '−' : '+'}</span>
      </button>
      {selected === work.id && <div className="network-work-detail" id={`network-detail-${work.id}`}>
        {work.source ? <><h3>Original question / offer</h3><p className="network-quote">{work.source.text}</p>
        <p>From <code title={work.source.from}>{short(work.source.from)}</code> · Agent <code title={work.agentDid}>{short(work.agentDid)}</code></p>
        <nav><a href={roomUrl(work.room)} target="_blank" rel="noopener noreferrer">Open source room</a><a href={recordUrl(work.room, work.source.seq)} target="_blank" rel="noopener noreferrer">Source record #{work.source.seq}</a></nav></>
        : <><h3>Scheduled maintenance</h3><p>Operator-authorized source check after 72 hours of room silence. There is no external requester. Agent: {short(work.agentDid)}.</p></>}
        <h3>What happened</h3><ol>{work.steps.map((step, i) => <li key={i}><b>{label[step.status] ?? step.status}</b><small>{time(step.ts)}</small>{step.detail && <p>{step.detail}</p>}</li>)}</ol>
        {work.result?.summary && <><h3>{work.kind === 'maintenance' ? 'Source-check result' : 'Agent assistance'}</h3><p className="network-quote">{work.result.summary}</p><p>Model: {work.result.model} · Output generated: {time(work.result.finishedAt)}</p><p className="network-hash">Output SHA-256: {work.result.outputHash}</p></>}
        {work.result?.sources?.map(source => <div className="network-source" key={source.url}><a href={safeLink(source.url)} target="_blank" rel="noopener noreferrer">{source.url}</a><p className="network-hash">Source SHA-256: {source.sha256}</p><small>Fetched {time(source.fetchedAt)}</small></div>)}
        {work.result?.offer && <p>Offered rails: {work.result.offer.rails.join(', ')}. {work.result.offer.reason}</p>}
        <nav>{work.reply?.confirmed && work.reply.receipt && <a href={recordUrl(work.reply.room, work.reply.receipt.seq)} target="_blank" rel="noopener noreferrer">Verified reply #{work.reply.receipt.seq}</a>}
        {work.mirror?.confirmed && work.mirror.receipt && <a href={recordUrl(work.mirror.room, work.mirror.receipt.seq)} target="_blank" rel="noopener noreferrer">PACT room record #{work.mirror.receipt.seq}</a>}
        <button onClick={() => void download(work)}>DOWNLOAD PUBLIC RECEIPT</button><a href={`#network/${work.id}`}>Shareable app link</a></nav>
        <p className="network-disclaimer">Signatures identify signing keys, not truth. Requester acceptance: not recorded. Settlement: unavailable. Room links may expire under Technocore retention; the saved receipt preserves the observed records.</p>
      </div>}
    </article>)}
  </section>;
}
