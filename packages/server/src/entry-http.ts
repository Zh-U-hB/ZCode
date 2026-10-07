import { randomUUID } from "node:crypto";
import { createLocalServices, getAppConfigDir } from "@zcode/services/node";
import {
  IZCodeAgentService,
  IZCodeTaskService,
  IWindowControllerService,
  createWindowHostControllerRuntime,
} from "@zcode/services";
import {
  materializeBundledZCodeBuiltinProviderConfig,
  readBundledZCodeBuiltinProviderConfig,
} from "./bundledZCodeBuiltinProviderConfig.js";
import { createHttpServer } from "./http.js";

async function main(): Promise<void> {
  const zcodeBuiltinProviderConfigFilePath = await materializeBundledZCodeBuiltinProviderConfig({
    environmentConfigRoot: getAppConfigDir(),
    content: readBundledZCodeBuiltinProviderConfig(),
  });
  const port = Number(process.env["PORT"]) || 3030;
  const host = process.env["ZCODE_SERVER_HOST"]?.trim() || process.env["HOST"]?.trim() || undefined;
  const staticRoot = process.env["ZCODE_WEB_STATIC_ROOT"]?.trim() || undefined;
  const authToken = process.env["ZCODE_SERVER_AUTH_TOKEN"]?.trim() || undefined;
  const services = createLocalServices({
    zcodeBuiltinProviderConfigFilePath,
    providerProvisioningTargetEnabled: Boolean(authToken),
  });

  // Web 前端侧栏任务列表经 windowController 通道聚合读取（与桌面 Host 同一 runtime）。
  // headless HTTP 场景只有本地 source：直接把 services 集合里的 task/agent 服务接上。
  // 缺了这个注册，浏览器端 useGlobalTaskList 的查询全部落空，表现为侧栏永远“还没有任务”。
  services.register(
    IWindowControllerService,
    createWindowHostControllerRuntime({
      createId: randomUUID,
      resolveSource: (scope) => {
        const taskService = services.getOptional(IZCodeTaskService);
        if (!taskService) {
          return null;
        }
        return {
          scope: {
            kind: "local" as const,
            workspacePath: scope.workspacePath,
            ...(scope.workspaceIdentity
              ? { workspaceIdentity: scope.workspaceIdentity }
              : {}),
          },
          taskService,
          agentService: services.getOptional(IZCodeAgentService),
          sourceAvailability: "online" as const,
        };
      },
    }).service,
  );

  createHttpServer(services, port, {
    ...(host ? { host } : {}),
    ...(staticRoot ? { staticRoot, spaFallback: true } : {}),
    ...(authToken ? { authToken, authRequired: true } : {}),
  });
}

void main().catch((error: unknown) => {
  console.error("[zcode-server:http] startup failed", error);
  process.exitCode = 1;
});
