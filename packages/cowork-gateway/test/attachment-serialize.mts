/**
 * 二进制附件序列化回归：web 端 xlsx 等二进制文件（无 localPath、非文本类）
 * 必须携带 dataBase64 字节进入上传链，否则 V4 命令面无内容可发，
 * 浏览器侧报「附件缺少可读取内容」。
 *
 * 运行：tsx packages/cowork-gateway/test/attachment-serialize.mts
 * 依赖 Node 24 内置 File；FileReader 是浏览器 API，这里 shim。
 */

// FileReader shim：readFileAsDataUrl 只用 onload + result(string)。
class FakeFileReader {
  result: string | null = null;
  error: unknown = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readAsDataURL(file: File): void {
    void file.arrayBuffer().then((buf) => {
      this.result = `data:${file.type || "application/octet-stream"};base64,${Buffer.from(buf).toString("base64")}`;
      this.onload?.();
    });
  }
}
(globalThis as Record<string, unknown>).FileReader = FakeFileReader;

const { serializeChatComposerAttachment } = await import(
  "../../ui/src/lib/chatAttachments.js"
);

let failures = 0;
function check(name: string, ok: boolean, detail?: string): void {
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

// 1. 二进制（xlsx = zip 容器，PK 头）→ dataBase64 携带全部字节
{
  const payload = Buffer.concat([Buffer.from("PK\x03\x04", "latin1"), Buffer.alloc(4096, 7)]);
  const file = new File([new Uint8Array(payload)], "预测wk42.xlsx", {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const serialized = await serializeChatComposerAttachment({
    id: "a1",
    filename: "预测wk42.xlsx",
    mimeType: file.type,
    sizeBytes: payload.length,
    file,
  });
  const data = "dataBase64" in serialized ? serialized.dataBase64 : undefined;
  check("xlsx 序列化携带 dataBase64", typeof data === "string" && data.length > 0);
  if (data) {
    const roundtrip = Buffer.from(data, "base64");
    check("base64 往返字节一致", roundtrip.equals(payload), `len=${roundtrip.length}`);
  }
  check("kind=file", serialized.kind === "file");
}

// 2. 文本类文件仍走 textContent（既有行为不变）
{
  const file = new File(["你好，世界"], "notes.txt", { type: "text/plain" });
  const serialized = await serializeChatComposerAttachment({
    id: "a2",
    filename: "notes.txt",
    mimeType: "text/plain",
    sizeBytes: 15,
    file,
  });
  check(
    "文本附件仍走 textContent",
    "textContent" in serialized && serialized.textContent === "你好，世界",
  );
}

// 3. 超 20MiB 二进制附件 → 结构化超限错误（不是裸协议报错）
{
  const big = new File([new Uint8Array(21 * 1024 * 1024)], "big.bin", {
    type: "application/octet-stream",
  });
  let caught: unknown = null;
  try {
    await serializeChatComposerAttachment({
      id: "a3",
      filename: "big.bin",
      mimeType: "application/octet-stream",
      sizeBytes: 21 * 1024 * 1024,
      file: big,
    });
  } catch (error) {
    caught = error;
  }
  const { OversizedInlineFileAttachmentError } = await import(
    "../../ui/src/lib/chatAttachmentErrors.js"
  );
  check(
    "超限二进制附件抛结构化错误",
    caught instanceof OversizedInlineFileAttachmentError,
    caught instanceof Error ? caught.name : String(caught),
  );
}

// 4. 无 file 且无 localPath（异常态）→ 保持旧行为：不带内容字段
{
  const serialized = await serializeChatComposerAttachment({
    id: "a4",
    filename: "ghost.bin",
    mimeType: "application/octet-stream",
    sizeBytes: 10,
  });
  check(
    "无 file 无 localPath 仍无内容字段",
    !("dataBase64" in serialized) && !("textContent" in serialized),
  );
}

console.log(failures === 0 ? "=== 附件序列化回归：全部通过 ===" : `=== FAIL ${failures} 项 ===`);
process.exit(failures === 0 ? 0 : 1);
