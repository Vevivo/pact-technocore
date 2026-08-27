# Threat Model

## Protected assets

- owner DID private keys and vault passphrases;
- operational-agent private keys;
- inference-provider API keys;
- authenticated owner sessions;
- archive integrity and task ordering;
- runtime availability and host isolation.

## Security properties

- Owner keys remain inside the browser and are encrypted locally with PBKDF2-SHA-256 and AES-GCM.
- The runtime stores only a hash of each bearer session token.
- Operational credentials use purpose-bound AES-256-GCM additional authenticated data.
- Owner endpoints require a valid DID challenge session and an allowlisted owner DID.
- Agent policy is deny-by-default and limits requester DIDs, capabilities, proof modes, sources, source size, and tasks per day.
- Private-network source access is blocked before and during DNS resolution, including redirects.
- Task ordering follows archived Technocore sequence numbers rather than client timestamps.

## Explicit non-goals

- A DID signature does not prove that submitted content is correct.
- The runtime operator can decrypt hosted operational credentials because the runtime must use them. Users should self-host or trust the operator.
- Public source URLs can contain hostile text. Retrieved content is treated as untrusted model input, not executable code.
- A maliciously modified fork can exfiltrate browser data. Users must verify the deployment origin and source.
- The source-available license is a legal control, not a technical anti-copy mechanism.

## Residual risks

- In-memory rate limits reset on restart and are not a replacement for upstream DDoS protection.
- Provider output may be inaccurate or prompt-injected by source content; requester review remains mandatory.
- Compromise of both the server and master key exposes hosted operational credentials.
- Loss of the master key makes encrypted operational credentials unrecoverable unless separate recovery vaults exist.
