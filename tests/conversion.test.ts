import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { allegroVersionFromText } from "../src/main/connectors/allegro-detector";
import {
  AllegroRunner,
  verifyPinReport,
} from "../src/main/connectors/allegro-runner";
import { createAllegroSourceBundle } from "../src/main/conversion/allegro-skill";
import { derivePadstackName, deriveTargetPackageName } from "../src/main/conversion/naming";
import { createConversionPlan } from "../src/main/conversion/validate";
import { getDemoFootprint } from "../src/shared/demo-fixtures";
import { AppSettingsSchema, type GenerationProgress } from "../src/shared/schemas";
import { lastWindowCloseAction } from "../src/main/lifecycle";

const requiredFixture = (lcscId: string) => {
  const footprint = getDemoFootprint(lcscId);
  if (footprint === null) {
    throw new Error(`Missing required test fixture ${lcscId}`);
  }
  return footprint;
};

describe("industry naming", () => {
  it("derives stable names for common SOIC and QFN packages", () => {
    const soic = requiredFixture("C7593");
    const qfn = requiredFixture("C163691");
    expect(deriveTargetPackageName(soic.info.sourcePackageName, soic.pads)).toBe(
      "SOIC127P600X175-8N",
    );
    expect(deriveTargetPackageName(qfn.info.sourcePackageName, qfn.pads)).toBe(
      "QFN50P500X500X100-33N",
    );
  });

  it("includes drill dimensions in through-hole padstack names", () => {
    const pad = {
      ...requiredFixture("C2040").pads[0]!,
      holeWidth: 0.8,
      holeHeight: 1.4,
    };
    expect(derivePadstackName(pad)).toContain("_H80X140");
  });
});

describe("Allegro source generation", () => {
  it("emits symbol, padstack, solder mask, paste mask, and verification commands", () => {
    const plan = createConversionPlan(requiredFixture("C163691"));
    const bundle = createAllegroSourceBundle(plan, "C:\\Temp\\e2a-job");
    const skill = bundle.sources.find((source) => source.relativePath === "build.il");
    expect(skill).toBeDefined();
    expect(skill!.content).toContain("axlDBCreatePadStack");
    expect(skill!.content).toContain("SOLDERMASK_TOP");
    expect(skill!.content).toContain("PASTEMASK_TOP");
    expect(skill!.content).toContain("e2a_verify");
    expect(skill!.content).toContain("?layer \"TOP\" ?type 'REGULAR");
    expect(skill!.content).toContain("axlPadstackToDisk");
    // axlPadstackToDisk 按设计内 padstack 名写盘（P8 实测），.pad 落在作业目录根且小写
    expect(skill!.content).toContain(
      `axlPadstackToDisk("${derivePadstackName(requiredFixture("C163691").pads[0]!)}")`,
    );
    expect(skill!.content).not.toMatch(/axlPadstackToDisk\("[^"]*\/[^"]*"\)/);
    expect(bundle.expectedOutputs).toContain(
      `${derivePadstackName(requiredFixture("C163691").pads[0]!).toLowerCase()}.pad`,
    );
    expect(skill!.content).toContain(
      "axlDBCreatePin(padName location pinText rotation)",
    );
    expect(skill!.content).toContain("?mirrored nil");
    expect(skill!.content).not.toContain("?mirror nil");
    expect(skill!.content).toContain('"REF DES/SILKSCREEN_TOP"');
    expect(skill!.content).toContain('"REF DES/ASSEMBLY_TOP"');
    // 标签合成（对照用户手工件 r0603.dra 真机 dump）：位号 + 器件名，各出丝印/装配两份。
    expect(skill!.content).toContain('"COMPONENT VALUE/SILKSCREEN_TOP"');
    expect(skill!.content).toContain('"COMPONENT VALUE/ASSEMBLY_TOP"');
    // REF DES 类文本取值校验（P17 实测）："REF**" 触发 SPMHUT-1 并使
    // create symbol 报 "Symbol is missing a refdes"；必须使用纯文本占位。
    expect(skill!.content).toContain('axlDBCreateText("REF" ');
    expect(skill!.content).not.toContain('axlDBCreateText("REF**"');
    // axlDBRefresh 在 17.4 未定义（E2E5 实测会中断 e2a_build），必须带守卫
    expect(skill!.content).toContain(
      "when(isCallable('axlDBRefresh) axlDBRefresh())",
    );
    expect(skill!.content).toContain('fprintf(statusPort "status=ok\\n")');
    expect(skill!.content).toContain("axlDBChangeDesignUnits(\"millimeters\" 4)");
    // 空 drawing 的 extents 为 nil 时 axlDBCreatePin 必失败（P9-P12 实测），
    // 必须先设置绘制范围
    expect(skill!.content).toContain("axlDBChangeDesignExtents(list(");
    expect(skill!.content.indexOf("axlDBChangeDesignExtents")).toBeLessThan(
      skill!.content.indexOf("e2a_create_pin(\""),
    );
    expect(skill!.content).toContain("axlExtractMap(");
    expect(skill!.content).not.toContain("axlDBGetDesign()->pins");
    expect(bundle.expectedOutputs).toContain(`${plan.footprint.info.targetPackageName}.psm`);
  });

  it("creates and verifies all 57 pads in the C2040-sized case", () => {
    const base = requiredFixture("C163691");
    const sourcePad = base.pads[0]!;
    const pads = Array.from({ length: 57 }, (_, index) => ({
      ...sourcePad,
      number: String(index + 1),
      center: {
        x: (index % 10) * 0.5,
        y: Math.floor(index / 10) * 0.5,
      },
    }));
    const plan = createConversionPlan({
      ...base,
      info: {
        ...base.info,
        lcscId: "C2040",
        name: "RP2040",
        manufacturerPartNumber: "RP2040",
        sourcePackageName: "LQFN-56_L7.0-W7.0-P0.4-EP",
        targetPackageName: "QFN40P700X700X100-57N",
      },
      pads,
    });
    const bundle = createAllegroSourceBundle(plan, "C:\\Temp\\e2a-c2040");
    const skill = bundle.sources.find((source) => source.relativePath === "build.il");
    expect(skill).toBeDefined();
    expect(skill!.content.match(/^  e2a_create_pin\(/gm)).toHaveLength(57);
    expect(skill!.content).toContain('fprintf(port "pins=%d\\n" length(pins))');
  });

  it("derives the assembly outline from silkscreen only when the source has none", () => {
    const base = requiredFixture("C7593");
    const withoutAssembly = {
      ...base,
      lines: base.lines.filter((line) => line.layer !== "assembly"),
    };
    const geometry = (content: string, layer: string) =>
      (content.match(new RegExp(`axlDBCreate(?:Line|Circle)\\([^\\n]*"${layer}"`, "g")) ?? [])
        .length;

    // 源数据带 assembly 几何 → 原样输出，不复制丝印（demo fixture 全部属于这种）
    const withSource = createAllegroSourceBundle(
      createConversionPlan(requiredFixture("C7593")),
      "C:\\Temp\\e2a-asm-a",
    ).sources.find((source) => source.relativePath === "build.il")!;
    expect(geometry(withSource.content, "PACKAGE GEOMETRY/ASSEMBLY_TOP")).toBe(4);

    // 源数据只有丝印（elibz2 / 立创 C 编号接口都是这种）→ 把丝印几何复制到 ASSEMBLY_TOP
    const derived = createAllegroSourceBundle(
      createConversionPlan(withoutAssembly),
      "C:\\Temp\\e2a-asm-b",
    ).sources.find((source) => source.relativePath === "build.il")!;
    expect(geometry(derived.content, "PACKAGE GEOMETRY/SILKSCREEN_TOP")).toBe(
      geometry(derived.content, "PACKAGE GEOMETRY/ASSEMBLY_TOP"),
    );
    expect(geometry(derived.content, "PACKAGE GEOMETRY/ASSEMBLY_TOP")).toBeGreaterThan(0);
  });

  it("keeps label text inside the design extents", () => {
    const plan = createConversionPlan(requiredFixture("C163691"));
    const bundle = createAllegroSourceBundle(plan, "C:\\Temp\\e2a-extents");
    const skill = bundle.sources.find((source) => source.relativePath === "build.il")!;
    const match = skill!.content.match(
      /axlDBChangeDesignExtents\(list\((-?[\d.]+):(-?[\d.]+) (-?[\d.]+):(-?[\d.]+)\)\)/,
    );
    expect(match).not.toBeNull();
    const [minX, minY, maxX, maxY] = match!.slice(1).map(Number) as [
      number,
      number,
      number,
      number,
    ];
    // E2E9 真机实测回归：extents 不覆盖标签包围盒时，axlDBCreateText 报
    // ERROR(SPMHA1-73): Text line is outside of the extents 并静默丢弃文本，
    // 而 build-status 仍写 status=ok。21 字符封装名居中后半宽 6.3mm，必须落在范围内。
    const nameHalfWidth = (plan.footprint.info.targetPackageName.length * 0.6) / 2;
    expect(nameHalfWidth).toBeGreaterThan(Math.max(Math.abs(minX), maxX) * 0.5);
    expect(maxX).toBeGreaterThan(nameHalfWidth);
    expect(minX).toBeLessThan(-nameHalfWidth);
    expect(maxY).toBeGreaterThan(plan.footprint.bounds.maxY + 1 + 0.7);
    expect(minY).toBeLessThan(plan.footprint.bounds.minY - 1 - 0.3);
  });

  it("fails instead of reporting completion when Allegro is unavailable", async () => {
    const libraryDirectory = await mkdtemp(join(tmpdir(), "e2a-library-"));
    const plan = createConversionPlan(requiredFixture("C2040"));
    const runner = new AllegroRunner();
    const progress: GenerationProgress[] = [];
    await expect(
      runner.generate(
        plan,
        {
          allegroVersion: "17.2",
          libraryDirectory,
          setupCompleted: true,
          allegroExecutablePath: null,
        },
        null,
        (item) => progress.push(item),
      ),
    ).rejects.toThrow("Cadence Allegro 17.2 was not found");
    expect(progress.some((item) => item.stage === "completed")).toBe(false);
  });
});

describe("Allegro installation detection", () => {
  it("recognizes common 16.6 and 17.2 install paths and product versions", () => {
    expect(
      allegroVersionFromText("C:\\Cadence\\SPB_16.6\\tools\\pcb\\bin\\allegro.exe"),
    ).toBe("16.6");
    expect(
      allegroVersionFromText("C:\\Cadence\\SPB_17.2\\tools\\bin\\allegro.exe"),
    ).toBe("17.2");
    expect(allegroVersionFromText("17.20.060")).toBe("17.2");
    expect(allegroVersionFromText("16.60.069")).toBe("16.6");
    expect(allegroVersionFromText("15.7")).toBeNull();
  });

  it("loads existing settings that predate executable-path detection", () => {
    expect(
      AppSettingsSchema.parse({
        allegroVersion: "17.2",
        libraryDirectory: "D:\\AllegroLibrary",
        setupCompleted: true,
      }),
    ).toEqual(
      expect.objectContaining({
        allegroVersion: "17.2",
        allegroExecutablePath: null,
      }),
    );
  });
});

describe("Allegro verification report", () => {
  it("accepts the Windows CRLF line ending used by Allegro", async () => {
    const reportDirectory = await mkdtemp(join(tmpdir(), "e2a-report-"));
    const reportPath = join(reportDirectory, "verification.txt");
    await writeFile(reportPath, "symbol=SOIC127P600X175-8N\r\npins=8\r\n", "utf8");
    await expect(verifyPinReport(reportPath, 8)).resolves.toBeUndefined();
  });

  it("reports both expected and actual pin counts on a real mismatch", async () => {
    const reportDirectory = await mkdtemp(join(tmpdir(), "e2a-report-"));
    const reportPath = join(reportDirectory, "verification.txt");
    await writeFile(reportPath, "symbol=SOIC127P600X175-8N\r\npins=7\r\n", "utf8");
    await expect(verifyPinReport(reportPath, 8)).rejects.toThrow(
      "expected 8 pins but reported 7",
    );
  });
});

describe("application shutdown", () => {
  it("exits immediately on Windows after the last window closes", () => {
    expect(lastWindowCloseAction("win32")).toBe("exit");
    expect(lastWindowCloseAction("linux")).toBe("quit");
    expect(lastWindowCloseAction("darwin")).toBe("stay");
  });
});
