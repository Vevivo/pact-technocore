import { createHash } from 'node:crypto';
import { decodeFrame, foldTranscript, transcriptRecord, verifyTranscriptRecord, dealRoom } from './vendor/tclk/index.js';

export const EVIDENCE_VERSION = 'pact-evidence/1';
export const VERIFIER = 'flop-labs/tclk@5cc4ab93efbc8999a3a7e1471b639deca25998ea + pact-evidence/1';
export const HASH_ID = /^0x[0-9a-f]{64}$/;
export const ROOM_NAME = /^[a-z0-9][a-z0-9_-]{0,47}$/;
export const TERMINAL = new Set(['claimed', 'refunded', 'cancelled']);
export const digest = value => createHash('sha256').update(value).digest('hex');
export const stableJson = value => value === null || typeof value !== 'object' ? JSON.stringify(value)
  : Array.isArray(value) ? `[${value.map(stableJson).join(',')}]`
    : `{${Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`;

// Node 24 supplies the original number token: a 19-digit transport nonce must
// never round-trip through Number. Signed text itself is never reserialized.
export const parseExactJson = raw => JSON.parse(raw, (key, value, context) =>
  key === 'nonce' && typeof value === 'number' ? context?.source ?? (() => { throw new Error('Lossless JSON parsing requires Node 24.'); })() : value);

export function inspectRecord(room, message) {
  let record;
  try {
    if (!message || typeof message.text !== 'string' || message.text.length > 4096) throw new Error('Message exceeds the supported limit.');
    record = transcriptRecord(room, message);
    const verified = verifyTranscriptRecord(record);
    if (!verified.ok) return { record, signatureValid: false, valid: false, reason: verified.reason, frame: null };
    if (!message.text.startsWith('tclk1 ')) return { record, signatureValid: true, valid: false, reason: 'Signed non-protocol statement; not a state transition.', frame: null };
    const frame = decodeFrame(message.text);
    if (frame.from !== record.sender) throw new Error('Frame DID differs from the transport signer.');
    if (['offer', 'accept'].includes(frame.type) && room !== 'tclk-offers') throw new Error('Handshake is outside tclk-offers.');
    if (!['offer', 'accept'].includes(frame.type) && room !== dealRoom(frame.contract)) throw new Error('Post-accept frame is outside the derived deal room.');
    return { record, frame, signatureValid: true, valid: true, reason: null };
  } catch (error) {
    return { record: record ?? null, frame: null, signatureValid: Boolean(record && verifyTranscriptRecord(record).ok), valid: false, reason: error.message };
  }
}

export function foldEvidence(items, contractId) {
  const records = items.filter(x => x.protocolValid).map(x => x.record);
  const fold = foldTranscript(records);
  const state = fold.state;
  const found = !contractId || state?.contract === contractId;
  const rejected = fold.steps.filter(step => !step.ok);
  return { state: found ? state : null, steps: fold.steps, rejected,
    protocolValid: Boolean(found && state),
    notice: 'State follows accepted transitions only. Rejected transitions remain diagnostics and cannot advance state.',
    payment: { status: state?.rail === 'paper' || state?.rail === 'memory' ? 'NO_VALUE' : 'UNVERIFIED',
      rail: state?.rail ?? null, reference: state?.railRef ?? null,
      reason: ['paper', 'memory'].includes(state?.rail) ? 'Rehearsal only. No money is held or transferred.' : 'A signed lock announcement is not independent rail verification. No funded rail verifier is configured.' } };
}

export function makeBundle(detail) {
  const payload = {
    version: EVIDENCE_VERSION, verifier: VERIFIER, collectedAt: new Date().toISOString(),
    contractId: detail.id, offerId: detail.offerId, source: detail.source,
    coverage: detail.coverage, records: detail.records, attachments: detail.attachments ?? [],
    assessment: detail.assessment,
    limits: ['Sender signatures cover room, nonce and exact text; not sequence, generation or venue timestamps.',
      'This is an observed record set, not proof that no other record exists.',
      'A reveal proves witness knowledge, not work quality. Payment is verified separately.',
      'No arbitration verdict or automatic GenLayer acceptance is claimed.'],
  };
  return { ...payload, bundleSha256: digest(stableJson(payload)) };
}

export function verifyBundle(bundle) {
  if (!bundle || bundle.version !== EVIDENCE_VERSION || !Array.isArray(bundle.records) || !bundle.records.length || bundle.records.length > 2000 || !Array.isArray(bundle.attachments ?? []) || (bundle.attachments?.length ?? 0)>3) throw new Error('Unsupported evidence bundle.');
  const { bundleSha256, ...payload } = bundle;
  const hashMatches = /^[0-9a-f]{64}$/.test(bundleSha256 || '') && digest(stableJson(payload)) === bundleSha256;
  const checks = bundle.records.map(item => {
    if (!item?.message || typeof item.room !== 'string') return { signatureValid: false, valid: false, reason: 'Missing raw envelope.' };
    return inspectRecord(item.room, item.message);
  });
  const signaturesValid = checks.every(c => c.signatureValid);
  const normalized = checks.map(c => ({ record: c.record, protocolValid: c.valid }));
  const assessment = foldEvidence(normalized, bundle.contractId?.startsWith('0x') ? bundle.contractId : undefined);
  const attachmentsValid = (bundle.attachments ?? []).every(a => a && typeof a.dataBase64 === 'string' && a.dataBase64.length<=64000
    && digest(Buffer.from(a.dataBase64, 'base64')) === a.sha256);
  const covered = bundle.coverage?.status === 'OBSERVED_CONTIGUOUS' && !bundle.coverage?.gaps?.length;
  const complete = assessment.protocolValid && TERMINAL.has(assessment.state?.status) && covered && bundle.contractId===assessment.state?.contract;
  return { verdict: !hashMatches || !signaturesValid || !attachmentsValid ? 'TAMPERED_OR_INVALID'
    : complete ? 'VALID_OBSERVED_TRANSCRIPT' : 'INCOMPLETE', hashMatches, signaturesValid, attachmentsValid,
    assessment, checks: checks.map((c, i) => ({ index: i, signatureValid: c.signatureValid, protocolValid: c.valid, reason: c.reason })),
    notice: 'Bundle integrity and sender signatures do not authenticate venue time, completeness, payment, work quality, or the collector identity.' };
}
