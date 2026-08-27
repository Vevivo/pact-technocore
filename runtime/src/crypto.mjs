import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign as nodeSign,
  timingSafeEqual,
  verify as nodeVerify,
} from "node:crypto";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58Encode(bytes) {
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let index = 0; index < digits.length; index += 1) {
      const value = digits[index] * 256 + carry;
      digits[index] = value % 58;
      carry = Math.floor(value / 58);
    }
    while (carry) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let result = "";
  for (const byte of bytes) {
    if (byte !== 0) break;
    result += "1";
  }
  for (let index = digits.length - 1; index >= 0; index -= 1) result += B58[digits[index]];
  return result;
}

export function base58Decode(value) {
  if (!value || [...value].some((char) => !B58.includes(char))) throw new Error("Invalid base58 value.");
  const bytes = [0];
  for (const char of value) {
    let carry = B58.indexOf(char);
    for (let index = 0; index < bytes.length; index += 1) {
      const next = bytes[index] * 58 + carry;
      bytes[index] = next & 0xff;
      carry = next >> 8;
    }
    while (carry) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  let leading = 0;
  while (value[leading] === "1") leading += 1;
  return Buffer.concat([Buffer.alloc(leading), Buffer.from(bytes.reverse())]);
}

export function didFromPublicJwk(jwk) {
  if (jwk?.kty !== "OKP" || jwk?.crv !== "Ed25519" || typeof jwk.x !== "string") {
    throw new Error("Expected an Ed25519 public JWK.");
  }
  const raw = Buffer.from(jwk.x, "base64url");
  if (raw.length !== 32) throw new Error("Invalid Ed25519 public key length.");
  return `did:key:z${base58Encode(Buffer.concat([Buffer.from([0xed, 0x01]), raw]))}`;
}

export function publicJwkFromDid(did) {
  if (typeof did !== "string" || !did.startsWith("did:key:z")) throw new Error("Expected did:key identity.");
  const decoded = base58Decode(did.slice("did:key:z".length));
  if (decoded.length !== 34 || decoded[0] !== 0xed || decoded[1] !== 0x01) {
    throw new Error("Only Ed25519 did:key identities are supported.");
  }
  return { kty: "OKP", crv: "Ed25519", x: decoded.subarray(2).toString("base64url") };
}

export function generateIdentity() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privateJwk = privateKey.export({ format: "jwk" });
  const publicJwk = publicKey.export({ format: "jwk" });
  return { did: didFromPublicJwk(publicJwk), privateJwk, publicJwk };
}

export function verifyDidSignature(did, payload, signature) {
  try {
    const publicKey = createPublicKey({ key: publicJwkFromDid(did), format: "jwk" });
    const decoded = Buffer.from(signature, "base64url");
    return decoded.length === 64 && nodeVerify(null, Buffer.from(payload, "utf8"), publicKey, decoded);
  } catch {
    return false;
  }
}

export function signWithJwk(privateJwk, payload) {
  const key = createPrivateKey({ key: privateJwk, format: "jwk" });
  return nodeSign(null, Buffer.from(payload, "utf8"), key).toString("base64url");
}

export function seal(masterKey, value, purpose) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey, iv);
  cipher.setAAD(Buffer.from(`pact:${purpose}:v1`, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString("base64url")}.${tag.toString("base64url")}.${ciphertext.toString("base64url")}`;
}

export function open(masterKey, envelope, purpose) {
  const [version, ivValue, tagValue, ciphertextValue] = String(envelope).split(".");
  if (version !== "v1" || !ivValue || !tagValue || ciphertextValue === undefined) throw new Error("Invalid encrypted envelope.");
  const decipher = createDecipheriv("aes-256-gcm", masterKey, Buffer.from(ivValue, "base64url"));
  decipher.setAAD(Buffer.from(`pact:${purpose}:v1`, "utf8"));
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertextValue, "base64url")), decipher.final()]).toString("utf8");
}

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function safeTokenEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}
