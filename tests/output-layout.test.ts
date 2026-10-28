import { describe, expect, it } from "vitest";
import {
  autoLibraryPath,
  outputLayoutOf,
  padstackDirectoryFor,
  safeFolderName,
  symbolDirectoryFor,
} from "../src/main/conversion/output-layout";

const LIB = "D:/lib";

describe("输出布局：三种模式", () => {
  it("默认 split：焊盘进 padstacks，封装进 symbols，.olb 进 schlib", () => {
    const layout = outputLayoutOf({ unifiedLibraryFolder: false, perFootprintFolder: false });
    expect(layout).toBe("split");
    expect(padstackDirectoryFor(layout, LIB, "QFN-32")).toBe("D:\\lib\\padstacks");
    expect(symbolDirectoryFor(layout, LIB, "QFN-32")).toBe("D:\\lib\\symbols");
    expect(autoLibraryPath(LIB, "QFN-32", layout)).toBe("D:\\lib\\schlib\\QFN-32.olb");
  });

  it("unified：全部直接放库目录", () => {
    const layout = outputLayoutOf({ unifiedLibraryFolder: true, perFootprintFolder: false });
    expect(layout).toBe("unified");
    expect(padstackDirectoryFor(layout, LIB, "QFN-32")).toBe("D:\\lib");
    expect(symbolDirectoryFor(layout, LIB, "QFN-32")).toBe("D:\\lib");
    expect(autoLibraryPath(LIB, "QFN-32", layout)).toBe("D:\\lib\\QFN-32.olb");
  });

  it("perFootprint：焊盘、封装、.olb 都进 <库>/<封装名>/", () => {
    const layout = outputLayoutOf({ unifiedLibraryFolder: false, perFootprintFolder: true });
    expect(layout).toBe("perFootprint");
    expect(padstackDirectoryFor(layout, LIB, "QFN-32")).toBe("D:\\lib\\QFN-32");
    expect(symbolDirectoryFor(layout, LIB, "QFN-32")).toBe("D:\\lib\\QFN-32");
    expect(autoLibraryPath(LIB, "QFN-32", layout)).toBe("D:\\lib\\QFN-32\\QFN-32.olb");
  });

  it("两个开关同时打开时以「独立文件夹」为准", () => {
    expect(outputLayoutOf({ unifiedLibraryFolder: true, perFootprintFolder: true })).toBe(
      "perFootprint",
    );
  });
});

describe("封装名 → 文件夹名", () => {
  it("保留字母数字与 - _ .", () => {
    expect(safeFolderName("TFBGA-100_L8.0-W8.0-P0.80-R10-C10-TL")).toBe(
      "TFBGA-100_L8.0-W8.0-P0.80-R10-C10-TL",
    );
  });

  it("路径分隔符与中文替换成下划线", () => {
    expect(safeFolderName("SOIC/8 窄体")).toBe("SOIC_8");
  });

  it("全是非法字符时退回 easy2alg，避免算出空目录名", () => {
    expect(safeFolderName("中文名")).toBe("easy2alg");
  });
});
