import { sweepSingleLine } from "./protocol";

export type Identity = { did: string; privateKey: CryptoKey; publicJwk: JsonWebKey; privateJwk: JsonWebKey };
export type Vault = { format: "pact-vault-v1"; did: string; publicJwk: JsonWebKey; salt: string; iv: string; ciphertext: string; iterations: number; createdAt: string };
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}
function base64UrlToBytes(value: string) {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((value.length + 3) % 4);
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}
function base58Encode(bytes: Uint8Array) {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let index = 0; index < digits.length; index += 1) { const value = digits[index] * 256 + carry; digits[index] = value % 58; carry = Math.floor(value / 58); }
    while (carry > 0) { digits.push(carry % 58); carry = Math.floor(carry / 58); }
  }
  let result = ""; for (const byte of bytes) { if (byte !== 0) break; result += alphabet[0]; }
  for (let index = digits.length - 1; index >= 0; index -= 1) result += alphabet[digits[index]];
  return result;
}
function didFromPublicJwk(jwk: JsonWebKey) {
  if (!jwk.x) throw new Error("The Ed25519 public key is missing its x coordinate.");
  const raw = base64UrlToBytes(jwk.x); const multicodec = new Uint8Array(raw.length + 2);
  multicodec.set([0xed, 0x01]); multicodec.set(raw, 2);
  return `did:key:z${base58Encode(multicodec)}`;
}
async function importJwk(privateJwk: JsonWebKey, publicJwk?: JsonWebKey): Promise<Identity> {
  if (privateJwk.kty !== "OKP" || privateJwk.crv !== "Ed25519" || !privateJwk.d || !privateJwk.x) throw new Error("Expected an Ed25519 private JWK (OKP / Ed25519).");
  const normalizedPublic = publicJwk ?? { kty: "OKP", crv: "Ed25519", x: privateJwk.x, ext: true, key_ops: ["verify"] };
  const privateKey = await crypto.subtle.importKey("jwk", privateJwk, { name: "Ed25519" }, true, ["sign"]);
  return { did: didFromPublicJwk(normalizedPublic), privateKey, publicJwk: normalizedPublic, privateJwk };
}
export async function generateIdentity(): Promise<Identity> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const [privateJwk, publicJwk] = await Promise.all([crypto.subtle.exportKey("jwk", pair.privateKey), crypto.subtle.exportKey("jwk", pair.publicKey)]);
  return { did: didFromPublicJwk(publicJwk), privateKey: pair.privateKey, publicJwk, privateJwk };
}
async function deriveVaultKey(passphrase: string, salt: BufferSource, iterations: number) {
  const material = await crypto.subtle.importKey("raw", encoder.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations, hash: "SHA-256" }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
export async function createVault(identity: Identity, passphrase: string): Promise<Vault> {
  const salt = crypto.getRandomValues(new Uint8Array(16)); const iv = crypto.getRandomValues(new Uint8Array(12)); const iterations = 250_000;
  const key = await deriveVaultKey(passphrase, salt, iterations);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(JSON.stringify({ privateKeyJwk: identity.privateJwk })));
  return { format: "pact-vault-v1", did: identity.did, publicJwk: identity.publicJwk, salt: bytesToBase64Url(salt), iv: bytesToBase64Url(iv), ciphertext: bytesToBase64Url(new Uint8Array(ciphertext)), iterations, createdAt: new Date().toISOString() };
}
export async function unlockVault(vault: Vault, passphrase: string) {
  if (vault.format !== "pact-vault-v1") throw new Error("Unsupported vault format.");
  const key = await deriveVaultKey(passphrase, base64UrlToBytes(vault.salt), vault.iterations);
  const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64UrlToBytes(vault.iv) }, key, base64UrlToBytes(vault.ciphertext));
  const payload = JSON.parse(decoder.decode(decrypted)) as { privateKeyJwk: JsonWebKey };
  const identity = await importJwk(payload.privateKeyJwk, vault.publicJwk);
  if (identity.did !== vault.did) throw new Error("Vault DID mismatch.");
  return identity;
}
export async function importIdentityFile(raw: string): Promise<Identity> {
  const payload = JSON.parse(raw) as Vault | JsonWebKey | { privateKeyJwk?: JsonWebKey };
  if ((payload as Vault).format === "pact-vault-v1") throw new Error("PACT vault files are already encrypted. Restore them as a device vault instead.");
  const jwk = (payload as { privateKeyJwk?: JsonWebKey }).privateKeyJwk ?? (payload as JsonWebKey);
  return importJwk(jwk);
}
export async function signRoomMessage(privateKey: CryptoKey, room: string, nonce: string, text: string) {
  const signature = await crypto.subtle.sign("Ed25519", privateKey, encoder.encode(`${room}|${nonce}|${sweepSingleLine(text)}`));
  return bytesToBase64Url(new Uint8Array(signature));
}
export async function signText(privateKey: CryptoKey, text: string) {
  const signature = await crypto.subtle.sign("Ed25519", privateKey, encoder.encode(text));
  return bytesToBase64Url(new Uint8Array(signature));
}
export function exportVaultFile(vault: Vault, prefix = "pact-vault") {
  const url = URL.createObjectURL(new Blob([JSON.stringify(vault, null, 2)], { type: "application/json" }));
  const anchor = document.createElement("a"); anchor.href = url; anchor.download = `${prefix}-${vault.did.slice(-8)}.json`; anchor.click(); URL.revokeObjectURL(url);
}
