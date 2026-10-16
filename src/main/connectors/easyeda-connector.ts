import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { ExternalServiceError } from "../../shared/errors";
import type { NormalizedFootprint, NormalizedSymbol } from "../../shared/schemas";
import { NormalizedFootprintSchema } from "../../shared/schemas";
import { parseEasyEdaSymbol } from "../conversion/easyeda-symbol";
import { normalizeEasyEdaResponse, RawEasyEdaResponseSchema } from "../conversion/normalize";
import { writeLog } from "../logging";

const LcscIdSchema = z.string().trim().toUpperCase().regex(/^C\d+$/);
const API_TEMPLATE = "https://easyeda.com/api/products/{lcsc_id}/components?version=6.4.19.5";
const RETRY_DELAYS_MS = [0, 450, 1_250] as const;

const delay = async (milliseconds: number): Promise<void> => {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
};

const responseSnippet = (body: string): string => body.slice(0, 2_000);

export class EasyEdaConnector {
  readonly #cacheDirectory: string;

  constructor(cacheDirectory: string) {
    this.#cacheDirectory = cacheDirectory;
  }

  async fetchFootprint(lcscIdInput: string): Promise<NormalizedFootprint> {
    const lcscId = LcscIdSchema.parse(lcscIdInput);
    const cached = await this.#readCache(lcscId);
    if (cached !== null) {
      await writeLog("info", "easyeda_cache_hit", { lcscId });
      return cached;
    }

    const raw = await this.#loadRaw(lcscId);
    try {
      const footprint = normalizeEasyEdaResponse(raw, lcscId);
      await this.#writeCache(lcscId, footprint);
      return footprint;
    } catch (error) {
      const cause = error instanceof Error ? error : new Error(String(error));
      throw new ExternalServiceError(
        `EasyEDA data validation failed for ${lcscId}: ${cause.message}`,
        {
          operation: "validate_component",
          requestUrl: API_TEMPLATE.replace("{lcsc_id}", lcscId),
          statusCode: null,
          responseBody: "",
          parameters: { lcscId },
        },
        cause,
      );
    }
  }

  /**
   * 原理图符号：与封装同一次接口响应的 `result.dataStr`。
   *
   * 立创编号链路过去只用 `packageDetail`（封装），把符号整段丢掉了 —— 用户
   * 2026-10-16 反馈"搜索的器件没出现原理图符号，实际是有符号的"。
   * 这里复用同一份原始响应缓存，不额外发请求。
   */
  async fetchSymbol(lcscIdInput: string): Promise<NormalizedSymbol | null> {
    const lcscId = LcscIdSchema.parse(lcscIdInput);
    const raw = await this.#loadRaw(lcscId);
    const parsed = RawEasyEdaResponseSchema.safeParse(raw);
    if (!parsed.success) {
      return null;
    }
    const result = parsed.data.result;
    const cPara = result.dataStr?.head.c_para ?? {};
    // OLB 里的 PCB Footprint 字段必须与实际生成的 .dra 同名 → 复用封装通道的推导结果；
    // 封装读不出来时退化成源封装名（不阻塞符号生成）。
    let pcbFootprint = cPara.package ?? result.packageDetail.title;
    try {
      pcbFootprint = (await this.fetchFootprint(lcscId)).info.targetPackageName;
    } catch (error) {
      await writeLog("warn", "easyeda_symbol_footprint_link_failed", {
        lcscId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    const symbol = parseEasyEdaSymbol(result.dataStr, {
      lcscId,
      fallbackName: result.title ?? lcscId,
      pcbFootprint,
    });
    if (symbol === null) {
      await writeLog("info", "easyeda_symbol_absent", { lcscId });
    }
    return symbol;
  }

  /** 原始响应（含封装与符号两段），落盘缓存避免同一器件请求两次。 */
  async #loadRaw(lcscId: string): Promise<unknown> {
    const cachePath = join(this.#cacheDirectory, `${lcscId}.raw.json`);
    try {
      return JSON.parse(await readFile(cachePath, "utf8")) as unknown;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
        throw error;
      }
    }

    const requestUrl = API_TEMPLATE.replace("{lcsc_id}", lcscId);
    let lastError: ExternalServiceError | null = null;
    for (const [attemptIndex, waitMilliseconds] of RETRY_DELAYS_MS.entries()) {
      if (waitMilliseconds > 0) {
        await writeLog("warn", "easyeda_request_retry", {
          lcscId,
          attempt: attemptIndex + 1,
          waitMilliseconds,
        });
        await delay(waitMilliseconds);
      }
      try {
        const raw = await this.#requestRaw(requestUrl, lcscId);
        await mkdir(this.#cacheDirectory, { recursive: true });
        const temporaryPath = `${cachePath}.tmp`;
        await writeFile(temporaryPath, `${JSON.stringify(raw)}\n`, "utf8");
        await rename(temporaryPath, cachePath);
        return raw;
      } catch (error) {
        if (!(error instanceof ExternalServiceError)) {
          throw error;
        }
        lastError = error;
      }
    }

    if (lastError === null) {
      throw new Error(`EasyEDA request failed for ${lcscId} without an error result`);
    }
    throw lastError;
  }

  async #requestRaw(requestUrl: string, lcscId: string): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(requestUrl, {
        headers: {
          Accept: "application/json, text/javascript, */*; q=0.01",
          "Accept-Encoding": "gzip, deflate",
          Referer: "https://easyeda.com/",
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/132.0 Easy2ALG/0.1",
        },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      const cause = error instanceof Error ? error : new Error(String(error));
      throw new ExternalServiceError(
        `EasyEDA request failed for ${lcscId}: ${cause.message}`,
        {
          operation: "fetch_component",
          requestUrl,
          statusCode: null,
          responseBody: "",
          parameters: { lcscId },
        },
        cause,
      );
    }

    const body = await response.text();
    if (!response.ok) {
      throw new ExternalServiceError(
        `EasyEDA request failed for ${lcscId}: HTTP ${response.status}`,
        {
          operation: "fetch_component",
          requestUrl,
          statusCode: response.status,
          responseBody: responseSnippet(body),
          parameters: { lcscId },
        },
        null,
      );
    }

    try {
      return JSON.parse(body) as unknown;
    } catch (error) {
      const cause = error instanceof Error ? error : new Error(String(error));
      throw new ExternalServiceError(
        `EasyEDA returned invalid JSON for ${lcscId}`,
        {
          operation: "fetch_component",
          requestUrl,
          statusCode: response.status,
          responseBody: responseSnippet(body),
          parameters: { lcscId },
        },
        cause,
      );
    }
  }

  async #readCache(lcscId: string): Promise<NormalizedFootprint | null> {
    const cachePath = join(this.#cacheDirectory, `${lcscId}.json`);
    try {
      const content = await readFile(cachePath, "utf8");
      const parsed: unknown = JSON.parse(content);
      return NormalizedFootprintSchema.parse(parsed);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  async #writeCache(lcscId: string, footprint: NormalizedFootprint): Promise<void> {
    const cachePath = join(this.#cacheDirectory, `${lcscId}.json`);
    const temporaryPath = `${cachePath}.tmp`;
    await mkdir(this.#cacheDirectory, { recursive: true });
    await writeFile(temporaryPath, `${JSON.stringify(footprint)}\n`, "utf8");
    await rename(temporaryPath, cachePath);
  }
}
