import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseEasyEdaSymbol } from "../src/main/conversion/easyeda-symbol";
import { buildCaptureLibraryXml } from "../src/main/conversion/capture-olb";

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/easyeda-c2866150.json", import.meta.url)), "utf8"),
) as { title: string; dataStr: unknown };

describe("导出真机写入用的 XML（临时）", () => {
  it("写 lmk-final.xml", () => {
    const symbol = parseEasyEdaSymbol(fixture.dataStr, {
      lcscId: "C2866150",
      fallbackName: fixture.title,
      pcbFootprint: "WQFN-48_L7.0-W7.0-P0.50-BL-EP5.1",
    })!;
    writeFileSync(
      "C:/Users/artis5/AppData/Local/Temp/e2a-olbinspect/lmk-final.xml",
      buildCaptureLibraryXml(symbol, "lmk-final.olb"),
    );
    expect(true).toBe(true);
  });
});
