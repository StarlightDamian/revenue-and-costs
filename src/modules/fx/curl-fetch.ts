import { spawn } from "node:child_process";

const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

export async function curlFetch(input: string | URL | Request): Promise<Response> {
  const url = input instanceof Request ? input.url : String(input);
  const command = process.platform === "win32" ? "curl.exe" : "curl";
  const args = [
    "--silent", "--show-error", "--fail", "--max-time", "30", "--max-filesize", String(MAX_RESPONSE_BYTES),
    "--proto", "=https", "--user-agent", "Mozilla/5.0", "--referer", "https://www.chinamoney.com.cn/chinese/bkccpr/index.html?tab=2", "--", url,
  ];
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    let size = 0;
    let rejected = false;
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        rejected = true;
        child.kill();
        reject(new Error("CHINAMONEY_XLSX_SIZE_INVALID"));
        return;
      }
      chunks.push(chunk);
    });
    child.once("error", () => {
      rejected = true;
      reject(new Error("CHINAMONEY_XLSX_CURL_UNAVAILABLE"));
    });
    child.once("close", (code) => {
      if (rejected) return;
      if (code === 0) resolve();
      else reject(new Error(`CHINAMONEY_XLSX_CURL_EXIT_${code ?? "UNKNOWN"}`));
    });
  });
  return new Response(Uint8Array.from(Buffer.concat(chunks)).buffer, {
    status: 200,
    headers: { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
  });
}
