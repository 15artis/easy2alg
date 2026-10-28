import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EasyEdaConnector } from "../src/main/connectors/easyeda-connector";
import { ExternalServiceError } from "../src/shared/errors";

/**
 * 立创接口的「业务性失败」。
 *
 * 用户 2026-10-28 截图：C55586821 报
 * `EasyEDA data validation failed ... Invalid input: expected object, received undefined`。
 * 真实响应是 HTTP 200 + `{"success":false,"code":404,"message":"Component not found"}` ——
 * 元件编号不存在。原来的实现把它丢给 zod，报错完全看不出病因；
 * 而且会被当成可重试错误白等 1.7 秒、重试 3 次。
 */

const freshCache = (): Promise<string> => mkdtemp(join(tmpdir(), "e2a-cache-"));

const stubJson = (payload: unknown): (() => number) => {
  let calls = 0;
  vi.stubGlobal("fetch", async () => {
    calls += 1;
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  return () => calls;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("立创接口的业务性失败", () => {
  it("元件不存在：给出可照做的提示，且只请求一次", async () => {
    const calls = stubJson({ success: false, code: 404, message: "Component not found" });
    const connector = new EasyEdaConnector(await freshCache());

    const error = await connector.fetchFootprint("C55586821").catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ExternalServiceError);
    const serviceError = error as ExternalServiceError;
    expect(serviceError.message).toContain("未找到元件 C55586821");
    expect(serviceError.message).toContain("Component not found");
    expect(serviceError.details.retryable).toBe(false);
    expect(calls()).toBe(1);
  });

  it("result 缺失（success 为真但没有 result）同样按确定性失败处理", async () => {
    const calls = stubJson({ code: 0, result: null });
    const connector = new EasyEdaConnector(await freshCache());

    const error = await connector.fetchFootprint("C41355184").catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ExternalServiceError);
    expect((error as ExternalServiceError).details.retryable).toBe(false);
    expect(calls()).toBe(1);
  });

  it("5xx 业务码仍然可重试（不改变原有的抖动重试行为）", async () => {
    const calls = stubJson({ success: false, code: 502, message: "Bad Gateway" });
    const connector = new EasyEdaConnector(await freshCache());

    const error = await connector.fetchFootprint("C2040").catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ExternalServiceError);
    expect((error as ExternalServiceError).details.retryable).toBe(true);
    // RETRY_DELAYS_MS 共 3 次
    expect(calls()).toBe(3);
  }, 20_000);
});
