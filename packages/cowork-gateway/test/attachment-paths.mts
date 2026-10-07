/**
 * web 上传附件 → agent 可读路径 回归测试。
 *
 * 背景：web 端上传走 zcode-artifact:// URI ref；非媒体附件 >64KiB 时旧逻辑降级成
 * 纯元数据占位符，模型既拿不到内容也拿不到路径。修复后 commit 时在
 * {cli}/uploads/<sessionId>/ 落原始文件，映射层解析出真实路径时按 desktop
 * localPath 语义处理。本文件直接深链 bootstrap 源码（其运行时 import 全为
 * type-only，tsx 可无依赖加载），用假 app 验证映射行为。
 */
import { mapAttachmentRefsToTurnAttachments } from "../../../apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands/attachment-refs.js";

const results: Array<{ name: string; status: "PASS" | "FAIL" }> = [];
function record(name: string, ok: boolean, detail?: string): void {
  results.push({ name, status: ok ? "PASS" : "FAIL" });
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
}

const KNOWN_REF = "zcode-artifact://s1/known-artifact";
const KNOWN_PATH = "/home/u/.zcode/cli/uploads/s1/tool-result-known-artifact-report.zip";

const fakeApp = {
  resolvePromptAttachmentFilePath: async (ref: string): Promise<string | null> =>
    ref === KNOWN_REF ? KNOWN_PATH : null,
  readToolResultArtifact: async (): Promise<{ content: string }> => ({
    content: "data:text/plain;base64,aGVsbG8=",
  }),
} as unknown as Parameters<typeof mapAttachmentRefsToTurnAttachments>[0];

async function main(): Promise<void> {
  // 1. 非媒体 + 可解析路径 + 超 64KiB：必须映射为真实路径引用（旧行为是纯元数据占位符）。
  const bigFile = await mapAttachmentRefsToTurnAttachments(fakeApp, [
    { ref: KNOWN_REF, fileName: "report.zip", mime: "application/zip", bytes: 5 * 1024 * 1024 },
  ]);
  record(
    "非媒体超限附件携带真实路径",
    bigFile?.length === 1 && bigFile[0].path === KNOWN_PATH && bigFile[0].type === "file",
    JSON.stringify(bigFile?.[0] ?? {}),
  );

  // 2. 非媒体 + 可解析路径 + 小文本：同样走路径分支（core 按阈值内联）。
  const smallFile = await mapAttachmentRefsToTurnAttachments(fakeApp, [
    { ref: KNOWN_REF, fileName: "notes.txt", mime: "text/plain", bytes: 128 },
  ]);
  record(
    "非媒体小文件走路径分支",
    smallFile?.length === 1 && smallFile[0].path === KNOWN_PATH,
    JSON.stringify(smallFile?.[0] ?? {}),
  );

  // 3. 图片：content 保留 artifact URI（vision 内联链不回退），path 升级为真实路径。
  const image = await mapAttachmentRefsToTurnAttachments(fakeApp, [
    { ref: KNOWN_REF, fileName: "shot.png", mime: "image/png", bytes: 900_000 },
  ]);
  record(
    "图片附件 path 升级为真实路径且保留 URI 内容",
    image?.length === 1 &&
      image[0].content === KNOWN_REF &&
      image[0].path === KNOWN_PATH &&
      image[0].type === "image",
    JSON.stringify(image?.[0] ?? {}),
  );

  // 4. PDF：content 保留 durable URI，path 升级。
  const pdf = await mapAttachmentRefsToTurnAttachments(fakeApp, [
    { ref: KNOWN_REF, fileName: "doc.pdf", mime: "application/pdf", bytes: 300_000 },
  ]);
  record(
    "PDF 保留 URI 内容且 path 升级",
    pdf?.length === 1 && pdf?.[0].content === KNOWN_REF && pdf?.[0].path === KNOWN_PATH,
    JSON.stringify(pdf?.[0] ?? {}),
  );

  // 5. 兼容回落：路径解析不到时，≤64KiB 非媒体仍内联文本（旧语义）。
  const inlineFallback = await mapAttachmentRefsToTurnAttachments(fakeApp, [
    { ref: "zcode-artifact://s2/gone-artifact", fileName: "a.txt", mime: "text/plain", bytes: 12 },
  ]);
  record(
    "无路径回落：小文本仍内联",
    inlineFallback?.length === 1 && inlineFallback[0].content === "hello",
    JSON.stringify(inlineFallback?.[0] ?? {}),
  );

  // 6. 兼容回落：无路径 + 超 64KiB → 仅元数据（不伪造内容）。
  const metaFallback = await mapAttachmentRefsToTurnAttachments(fakeApp, [
    {
      ref: "zcode-artifact://s2/gone-artifact",
      fileName: "b.zip",
      mime: "application/zip",
      bytes: 5 * 1024 * 1024,
    },
  ]);
  record(
    "无路径回落：超限仅保留元数据",
    metaFallback?.length === 1 &&
      metaFallback[0].type === "file" &&
      metaFallback[0].content === undefined &&
      metaFallback[0].path === undefined,
    JSON.stringify(metaFallback?.[0] ?? {}),
  );

  // 7. desktop 本地路径引用行为不变。
  const localPath = await mapAttachmentRefsToTurnAttachments(fakeApp, [
    { ref: "D:\\data\\report.zip", fileName: "report.zip", mime: "application/zip", bytes: 1024 },
  ]);
  record(
    "本地路径引用行为不变",
    localPath?.length === 1 && localPath[0].path === "D:\\data\\report.zip",
    JSON.stringify(localPath?.[0] ?? {}),
  );

  const failed = results.filter((r) => r.status === "FAIL").length;
  console.log(`\n=== 附件路径回归总结: ${results.length} 项 | PASS ${results.length - failed} | FAIL ${failed} ===`);
  if (failed > 0) process.exit(1);
}

await main();
