import { Sha256 } from "@aws-crypto/sha256-js";

const EMPTY_SHA256_BASE64 = "47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=";

function base64(input: ArrayBuffer | Uint8Array): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export async function sha256Base64(
  input: ArrayBuffer,
  subtle: Pick<SubtleCrypto, "digest"> | null | undefined = globalThis.crypto?.subtle,
): Promise<string> {
  if (subtle) return base64(await subtle.digest("SHA-256", input));
  const sha256 = new Sha256();
  sha256.update(new Uint8Array(input));
  return base64(await sha256.digest());
}

/** 在创建服务端批次前验证当前上下文确实可生成兼容的分片校验和。 */
export async function prepareUploadChecksum(): Promise<void> {
  if (await sha256Base64(new ArrayBuffer(0)) !== EMPTY_SHA256_BASE64) throw new Error("当前浏览器无法生成上传校验和");
}
