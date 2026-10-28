import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { ExternalServiceError } from "../../shared/errors";
import type { NormalizedFootprint, NormalizedSymbol, ProductSearchResult } from "../../shared/schemas";
import { NormalizedFootprintSchema } from "../../shared/schemas";
import { parseEasyEdaSymbol } from "../conversion/easyeda-symbol";
import { normalizeEasyEdaResponse, RawEasyEdaResponseSchema } from "../conversion/normalize";
import { writeLog } from "../logging";

const LcscIdSchema = z.string().trim().toUpperCase().regex(/^C\d+$/);
const API_TEMPLATE = "https://easyeda.com/api/products/{lcsc_id}/components?version=6.4.19.5";
/**
 * 关键字搜索（用户 2026-10-19 要求"输入元件名模糊搜索"）。
 * 实测可用端点：`/api/eda/product/search?keyword=...`（参数名必须是 keyword，
 * 用 wd/q/page 等会返回 resultCode 0004）。响应里 productList 的 number 即 C 编号。
 * **必须带 Accept: application/json** —— 只带 UA 会被 CloudFront 403。
 */
const SEARCH_TEMPLATE = "https://easyeda.com/api/eda/product/search?keyword={keyword}";
const RETRY_DELAYS_MS = [0, 450, 1_250] as const;

/** 搜索响应只取我们需要的字段，其余结构变化不让界面崩。 */
const SearchResponseSchema = z.object({
  code: z.number().optional(),
  result: z
    .object({
      productList: z
        .array(
          z.object({
            number: z.string().regex(/^C\d+$/),
            mpn: z.string().default(""),
            package: z.string().default(""),
            manufacturer: z.string().default(""),
            stock: z.number().int().nonnegative().default(0),
          }),
        )
        .default([]),
    })
    .nullable()
    .optional(),
});

const delay = async (milliseconds: number): Promise<void> => {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
};

const responseSnippet = (body: string): string => body.slice(0, 2_000);

/**
 * 接口的业务性失败（HTTP 200 但 `success:false`）。
 *
 * 2026-10-28 实测：不存在的编号（用户输入的 C55586821）返回
 * `{"success":false,"code":404,"message":"Component not found"}`，HTTP 状态却是 200。
 * 过去直接丢给 zod 校验，界面上显示成
 * `EasyEDA data validation failed ... expected object, received undefined` ——
 * 用户完全看不出是「编号不存在」。这里提前识别，给一句能照做的提示，
 * 并且标记为不可重试（重试也不会变成存在）。
 */
const apiFailure = (
  payload: unknown,
): { readonly message: string; readonly retryable: boolean } | null => {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const record = payload as { success?: unknown; code?: unknown; message?: unknown; result?: unknown };
  const serverMessage = typeof record.message === "string" ? record.message.trim() : "";
  const succeeded = record.success !== false && record.result !== null && record.result !== undefined;
  if (succeeded) {
    return null;
  }
  const detail = serverMessage.length > 0 ? serverMessage : "response has no result payload";
  // 5xx 属于服务端临时故障，值得重试；4xx 与"没有 result"都是确定性结果。
  const code = typeof record.code === "number" ? record.code : null;
  return {
    message: detail,
    retryable: code !== null && code >= 500,
  };
};

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
      // 多子部件器件（双 MOSFET / 双运放等）的真实符号在 subparts 里，
      // dataStr 只是空壳 —— 不传进去就会误判成"没有原理图符号"。
      subparts: result.subparts ?? [],
    });
    if (symbol === null) {
      await writeLog("info", "easyeda_symbol_absent", { lcscId });
    } else if (symbol.sections.length > 1) {
      await writeLog("info", "easyeda_symbol_multi_section", {
        lcscId,
        sectionCount: symbol.sections.length,
        sectionNames: symbol.sections.map((section) => section.name).join("|"),
      });
    }
    return symbol;
  }

  /**
   * 关键字模糊搜索（厂商型号 / 描述 / 关键词）。返回 C 编号等摘要信息，
   * 用户选中后再走正常的 fetchFootprint / fetchSymbol 流程。
   *
   * 接口要点（实测）：参数名必须是 keyword；必须带 `Accept: application/json`，
   * 只带 UA 会被 CloudFront 拦成 403。stock 为 0 也照常返回（缺货件同样可生成）。
   */
  async searchProducts(keywordInput: string): Promise<ProductSearchResult> {
    const keyword = keywordInput.trim();
    if (keyword.length === 0) {
      return { keyword, hits: [] };
    }
    const requestUrl = SEARCH_TEMPLATE.replace("{keyword}", encodeURIComponent(keyword));
    let response: Response;
    try {
      response = await fetch(requestUrl, {
        headers: {
          Accept: "application/json",
          "Accept-Encoding": "gzip, deflate",
          Referer: "https://easyeda.com/",
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/132.0 Easy2ALG/0.1",
        },
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      const cause = error instanceof Error ? error : new Error(String(error));
      throw new ExternalServiceError(
        `元件搜索失败（${keyword}）：${cause.message}`,
        {
          operation: "search_products",
          requestUrl,
          statusCode: null,
          responseBody: "",
          parameters: { keyword },
        },
        cause,
      );
    }
    const body = await response.text();
    if (!response.ok) {
      throw new ExternalServiceError(
        `元件搜索失败（${keyword}）：HTTP ${response.status}`,
        {
          operation: "search_products",
          requestUrl,
          statusCode: response.status,
          responseBody: responseSnippet(body),
          parameters: { keyword },
        },
        null,
      );
    }
    const parsed = SearchResponseSchema.safeParse(JSON.parse(body) as unknown);
    if (!parsed.success) {
      throw new ExternalServiceError(
        `元件搜索返回了无法识别的数据（${keyword}）`,
        {
          operation: "search_products",
          requestUrl,
          statusCode: response.status,
          responseBody: responseSnippet(body),
          parameters: { keyword },
        },
        null,
      );
    }
    await writeLog("info", "easyeda_search", {
      keyword,
      total: parsed.data.result?.productList.length ?? 0,
    });
    return {
      keyword,
      hits: (parsed.data.result?.productList ?? []).map((item) => ({
        lcscId: item.number,
        mpn: item.mpn,
        package: item.package,
        manufacturer: item.manufacturer,
        stock: item.stock,
      })),
    };
  }

  /** 原始响应（含封装与符号两段），落盘缓存避免同一器件请求两次。 */
  async #loadRaw(lcscId: string): Promise<unknown> {    const cachePath = join(this.#cacheDirectory, `${lcscId}.raw.json`);
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
        // 确定性失败（元件不存在等）重试也不会有结果，直接抛给用户
        if (error.details.retryable === false) {
          throw error;
        }
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
      const payload = JSON.parse(body) as unknown;
      const failure = apiFailure(payload);
      if (failure !== null) {
        throw new ExternalServiceError(
          failure.retryable
            ? `EasyEDA 服务暂时不可用（${lcscId}）：${failure.message}`
            : `未找到元件 ${lcscId}：EasyEDA 返回「${failure.message}」，请核对立创编号是否正确、该器件是否已下架`,
          {
            operation: "fetch_component",
            requestUrl,
            statusCode: response.status,
            responseBody: responseSnippet(body),
            parameters: { lcscId },
            retryable: failure.retryable,
          },
          null,
        );
      }
      return payload;
    } catch (error) {
      if (error instanceof ExternalServiceError) {
        throw error;
      }
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
