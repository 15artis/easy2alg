import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Elibz2Connector } from "../src/main/connectors/elibz2-connector";
import { autoLibraryPath, inspectLibraryPart } from "../src/main/connectors/capture-writer";
import { buildCaptureLibraryXml } from "../src/main/conversion/capture-olb";
import { applySymbolEdits, setTextHidden, symbolShapeKey } from "../src/shared/symbol-edit";
import {
  bodyBoxOf,
  estimateLabelWidth,
  pinIsVertical,
  pinSideOf,
  symbolFontHeight,
} from "../src/shared/symbol-labels";
import type { NormalizedSymbol } from "../src/shared/schemas";

const fixturePath = fileURLToPath(new URL("./fixtures/pex8748.elibz2", import.meta.url));
const deviceUuid = "fc36ffe4397f472eb9c124285f536c2c";

const singleSection = (): NormalizedSymbol => ({
  name: "TESTPART",
  refdesPrefix: "U",
  pcbFootprint: "TESTPART_FOOTPRINT",
  sections: [
    {
      name: "TESTPART",
      bounds: { minX: 0, minY: 0, maxX: 20, maxY: 20 },
      pins: [
        {
          name: "1",
          number: "1",
          connection: { x: 30, y: 10 },
          body: { x: 20, y: 10 },
          length: 10,
          type: "passive",
          visible: true,
        },
        {
          name: "GND",
          number: "2",
          connection: { x: -10, y: 10 },
          body: { x: 0, y: 10 },
          length: 10,
          type: "power",
          visible: true,
        },
      ],
      shapes: [
        { kind: "rect", min: { x: 0, y: 0 }, max: { x: 20, y: 20 }, cornerRadius: 0, filled: false },
        {
          kind: "text",
          text: "TEST",
          at: { x: 2, y: 25 },
          rotation: 0,
          height: 12,
        },
      ],
    },
  ],
  sourceJson: "{}",
});

describe("capture library XML", () => {
  /**
   * 坐标必须是整数：XMATIC_XML2OLB 的 XSD 对 x1/x2/y1/y2/hotpt/start/locX/locY
   * 都有 `[+\-]?[0-9]+` 的 facet，出现 "6.449" 会整库导入失败。
   * 实测案例：C2866150 的极性圆点（半径 1.5，按 24 边形近似）→ 整个符号写不进去。
   */
  it("把所有坐标吸附到符号网格（小数会让整库导入失败）", () => {
    const symbol = singleSection();
    const section = symbol.sections[0];
    const fractional: NormalizedSymbol = {
      ...symbol,
      sections: [
        {
          ...section,
          pins: section.pins.map((pin) => ({
            ...pin,
            connection: { x: pin.connection.x + 0.449, y: pin.connection.y + 0.5 },
            body: { x: pin.body.x - 0.449, y: pin.body.y + 0.388 },
          })),
          shapes: [
            { kind: "rect", min: { x: 0.4, y: 0.2 }, max: { x: 190.6, y: 260.2 }, cornerRadius: 0, filled: false },
            {
              kind: "polyline",
              closed: false,
              points: [{ x: 6.5, y: 15 }, { x: 6.449, y: 15.388 }, { x: 6.299, y: 15.75 }],
            },
            { kind: "text", text: "T", at: { x: 2.449, y: 25.5 }, rotation: 0, height: 12 },
          ],
        },
      ],
    };
    const xml = buildCaptureLibraryXml(fractional, "C:/libs/target.OLB");
    const coordinates = [...xml.matchAll(/\b(x1|x2|y1|y2|hotptX|hotptY|startX|startY|locX|locY)="([^"]*)"/g)];
    expect(coordinates.length).toBeGreaterThan(10);
    const offenders = coordinates.filter((match) => !/^-?\d+$/.test(match[2]));
    expect(offenders.map((match) => `${match[1]}=${match[2]}`)).toEqual([]);
  });

  it("emits the Package/LibPart/NormalView/PhysicalPart chain a real .olb export uses", () => {
    const xml = buildCaptureLibraryXml(singleSection(), "C:/libs/target.OLB");
    // 根 <Defn> 必须写成目标 .olb 的实际路径：导入器按它定位要写入的库。
    expect(xml).toContain('<Defn name="C:/libs/target.OLB" />');
    expect(xml).toContain('xsi:noNamespaceSchemaLocation="olb.xsd"');
    // 单段器件：字母编号关（2）、同质器件（1）、CellName 与 Package 同名。
    expect(xml).toMatch(
      /<Defn alphabeticNumbering="2" isHomogeneous="1" name="TESTPART" pcbFootprint="TESTPART_FOOTPRINT" pcbLib="" refdesPrefix="U"/,
    );
    expect(xml).toContain('<Defn CellName="TESTPART" />');
  });

  it("nests PhysicalPart INSIDE LibPart, after NormalView", () => {
    // 回归防护：把 PhysicalPart 挂到 <Package> 下面时导入器报
    // ERROR(SPSMI-1) no declaration found for element 'PhysicalPart'。
    const xml = buildCaptureLibraryXml(singleSection(), "C:/libs/target.OLB");
    const libPartStart = xml.indexOf("<LibPart>");
    const normalViewEnd = xml.indexOf("</NormalView>");
    const physicalStart = xml.indexOf("<PhysicalPart>");
    const libPartEnd = xml.indexOf("</LibPart>");
    expect(libPartStart).toBeGreaterThan(-1);
    expect(normalViewEnd).toBeGreaterThan(libPartStart);
    expect(physicalStart).toBeGreaterThan(normalViewEnd);
    expect(libPartEnd).toBeGreaterThan(physicalStart);
    // 不能出现"PhysicalPart 在 Package 直属子级"的形态
    expect(xml).not.toMatch(/<\/LibPart>\s*<PhysicalPart>/);
  });

  it("writes pin geometry as hotpt=connection and start=body with the Capture type code", () => {
    const xml = buildCaptureLibraryXml(singleSection(), "C:/libs/target.OLB");
    // name 与 number 同为 "1" → 关掉脚号，只由 Capture 画一次 name（否则同一个字出现两遍）
    expect(xml).toContain('<Defn hotptX="30" hotptY="10" name="1" position="0" startX="20" startY="10" type="4" visible="1" />');
    expect(xml).toMatch(
      /<IsNumberVisible>\s*<Defn val="0" \/>\s*<\/IsNumberVisible>/,
    );
    // power(7) 与 passive(4) 不同码；name≠number 的脚保留脚号
    expect(xml).toContain(
      '<Defn hotptX="-10" hotptY="10" name="GND" position="1" startX="0" startY="10" type="7" visible="1" />',
    );
    expect(xml).toMatch(
      /<IsNumberVisible>\s*<Defn val="1" \/>\s*<\/IsNumberVisible>/,
    );
    expect(xml).toContain('<Defn number="1" position="0" />');
    expect(xml).toContain('<Defn number="2" position="1" />');
  });

  /**
   * 用户 2026-11-10 第二次报障：SMA-KWE 在 Capture 里每个脚画两遍（name 在
   * 本体内侧、number 贴在引脚旁）。逐脚 `IsNumberVisible=0` 在实机上不生效，
   * 只能整段关 `<IsPinNamesVisible>`；关掉时脚号必须补上，否则一个字都不剩。
   */
  it("name 全等于 number 时整段关引脚名，同时保留脚号", () => {
    const numbered: NormalizedSymbol = {
      ...singleSection(),
      sections: [
        {
          ...singleSection().sections[0],
          pins: [
            {
              name: "1",
              number: "1",
              connection: { x: 30, y: 10 },
              body: { x: 20, y: 10 },
              length: 10,
              type: "passive",
              visible: true,
            },
            {
              name: "2",
              number: "2",
              connection: { x: -10, y: 10 },
              body: { x: 0, y: 10 },
              length: 10,
              type: "passive",
              visible: true,
            },
          ],
        },
      ],
    };
    const xml = buildCaptureLibraryXml(numbered, "C:/libs/target.OLB");
    expect(xml).toMatch(/<IsPinNamesVisible>\s*<Defn val="0" \/>\s*<\/IsPinNamesVisible>/);
    expect(xml.match(/<IsNumberVisible>\s*<Defn val="1" \/>/g)).toHaveLength(2);

    // 有语义名字（GND）的段不关
    const xml2 = buildCaptureLibraryXml(singleSection(), "C:/libs/target.OLB");
    expect(xml2).toMatch(/<IsPinNamesVisible>\s*<Defn val="1" \/>\s*<\/IsPinNamesVisible>/);
  });

  it("uses letter-suffixed CellName for multi-section packages", async () => {
    const connector = new Elibz2Connector();
    const symbol = await connector.loadSymbol(fixturePath, deviceUuid);
    const xml = buildCaptureLibraryXml(symbol!, "C:/libs/target.OLB");
    expect(xml).toContain('alphabeticNumbering="1" isHomogeneous="0"');
    // 器件名取属性里的真实型号（Manufacturer/LCSC Part），不再是 display_title
    expect(xml).toContain('<Defn CellName="PEX8748-CA80BC_GA" />');
    expect(xml).toContain('<Defn CellName="PEX8748-CA80BC_GF" />');
    expect(xml.match(/<LibPart>/g)).toHaveLength(6);
    // 676 个引脚，每脚一个 SymbolPinScalar + 一个 PinNumber
    expect(xml.match(/<SymbolPinScalar>/g)).toHaveLength(676);
    expect(xml.match(/<PinNumber>/g)).toHaveLength(676);
  });

  it("rotates pin names per pin direction and pins every name to an explicit spot", async () => {
    // 回归防护（用户 2026-10-16 截图）：Capture 默认把上下引脚名竖着画进本体，
    // 与左右引脚的横排名字在四角重叠。
    //
    // 曾经以为「逐脚 PinDisplayProp 会被 XMATIC_XML2OLB 静默丢弃」，据此只留全局的
    // IsPinNamesRotated、靠几何避让硬撑。2026-11-10 复测推翻了这个结论：把带
    // PinDisplayProp 的 XML 导入再导出，元素与 locX/locY/rotation/val 逐字保留
    // （`build/olbtest/PROP0_back.xml`）。所以上下引脚现在都写死落点 ——
    // 小本体里 Capture 自己"估价"会把两排名字摆到本体正中叠成一团。
    const connector = new Elibz2Connector();
    const symbol = await connector.loadSymbol(fixturePath, deviceUuid);
    const xml = buildCaptureLibraryXml(symbol!, "C:/libs/target.OLB");
    // 六段都有上下边引脚 → 六段都置 1
    expect(xml.match(/<IsPinNamesRotated>\s*<Defn val="1" \/>/g)).toHaveLength(6);
    expect(xml).not.toMatch(/<IsPinNamesRotated>\s*<Defn val="0" \/>/);

    // 竖排引脚名逐个给坐标：水平方向退到引脚轴线左侧 5，竖直方向贴本体上/下边
    const names = [...xml.matchAll(
      /<PinDisplayProp>\s*<Defn locX="(-?\d+)" locY="(-?\d+)" name="Name" rotation="1" textJustification="0" \/>/g,
    )];
    const verticalPins = symbol!.sections
      .flatMap((section) => section.pins)
      .filter((pin) => pin.name.trim() !== "" && (pinSideOf(pin) === "top" || pinSideOf(pin) === "bottom"));
    expect(names.length).toBe(verticalPins.length);
    // 写库出口会按脚号重排，位置集合一致即可：locX = 引脚本体端 x − 5
    const expectedX = verticalPins.map((pin) => Math.round(pin.body.x) - 5).sort((a, b) => a - b);
    const actualX = names.map((match) => Number(match[1])).sort((a, b) => a - b);
    expect(actualX).toEqual(expectedX);
  });

  it("writes the de-collided geometry, not the raw source positions", async () => {
    const connector = new Elibz2Connector();
    const symbol = await connector.loadSymbol(fixturePath, deviceUuid);
    const xml = buildCaptureLibraryXml(symbol!, "C:/libs/target.OLB");
    // 第一段源本体只有 380×310，避让后加宽到 510（还对齐了 10 单位格点）
    expect(bodyBoxOf(symbol!.sections[0])).toEqual({
      minX: 0,
      minY: 0,
      maxX: 510,
      maxY: 310,
    });
    expect(xml).toContain('<Defn x1="0" x2="510" y1="0" y2="310" />');
    // 每个上下边引脚的连接端 x 都落在左右两条名字竖带之间的中段里
    for (const section of symbol!.sections) {
      const body = bodyBoxOf(section);
      const leftDepth = section.pins
        .filter((pin) => pinSideOf(pin) === "left")
        .reduce((depth, pin) => Math.max(depth, estimateLabelWidth(pin.name)), 0);
      const rightDepth = section.pins
        .filter((pin) => pinSideOf(pin) === "right")
        .reduce((depth, pin) => Math.max(depth, estimateLabelWidth(pin.name)), 0);
      for (const pin of section.pins.filter(pinIsVertical)) {
        expect(pin.connection.x).toBeGreaterThanOrEqual(body.minX + leftDepth);
        expect(pin.connection.x).toBeLessThanOrEqual(body.maxX - rightDepth);
      }
    }
  });

  it("writes SymbolBBox from the body rect, not the pin-inclusive bounds", async () => {
    // 真实库里 SymbolBBox 就是本体矩形（UD: 0,0–110,210，而左侧引脚伸到 x=-30）。
    const connector = new Elibz2Connector();
    const symbol = await connector.loadSymbol(fixturePath, deviceUuid);
    const xml = buildCaptureLibraryXml(symbol!, "C:/libs/target.OLB");
    const boxes = [...xml.matchAll(/<SymbolBBox>\s*<Defn x1="([-\d.]+)" x2="([-\d.]+)" y1="([-\d.]+)" y2="([-\d.]+)" \/>/g)];
    expect(boxes).toHaveLength(6);
    // 每段本体都以 (0,0) 起算（见连接器里的锚点约定）
    for (const box of boxes) {
      expect(box[1]).toBe("0");
      expect(box[3]).toBe("0");
    }
    const sectionA = symbol!.sections[0];
    expect([boxes[0][1], boxes[0][2], boxes[0][3], boxes[0][4]]).toEqual(["0", "510", "0", "310"]);
    expect(sectionA.name).toBe("PEX8748_CS_I2C_SPI");
  });

  it("carries the user's manual shape adjustments into the written library", async () => {
    // 预览里拖动的位移必须原样落进 .olb —— 预览与写入走的是同一个 applySymbolEdits。
    const connector = new Elibz2Connector();
    const symbol = await connector.loadSymbol(fixturePath, deviceUuid);
    const textIndex = symbol!.sections[0].shapes.findIndex((shape) => shape.kind === "text");
    expect(textIndex).toBeGreaterThanOrEqual(0);
    const before = symbol!.sections[0].shapes[textIndex];
    expect(before.kind).toBe("text");
    const moved = applySymbolEdits(symbol!, {
      [symbolShapeKey(0, textIndex)]: { offset: { dx: 25, dy: -40 } },
    });
    const after = moved.sections[0].shapes[textIndex];
    expect(after.kind).toBe("text");
    if (after.kind !== "text" || before.kind !== "text") return;
    expect(after.at).toEqual({ x: before.at.x + 25, y: before.at.y - 40 });
    // 同一段里其它元素原地不动
    expect(moved.sections[0].shapes[0]).toEqual(symbol!.sections[0].shapes[0]);

    const xml = buildCaptureLibraryXml(moved, "C:/libs/target.OLB");
    // CommentText 的锚点与包围盒都跟着走
    expect(xml).toContain(
      `locX="${after.at.x}" locY="${after.at.y}" name="${after.text}"`,
    );
    // 未编辑的段落不受影响
    const untouched = buildCaptureLibraryXml(symbol!, "C:/libs/target.OLB");
    expect(xml.match(/<SymbolPinScalar>/g)).toHaveLength(
      untouched.match(/<SymbolPinScalar>/g)!.length,
    );
  });

  it("writes rotated comment text as rotated (tall box + orientation + loc at min corner)", () => {
    // 用户 2026-10-19：预览里竖排的区域标注，生成到 Capture 全变成横排。
    // 实验结论：orientation 只是陪衬，**竖不竖看包围盒**；而且 loc 必须落在框的最小角，
    // 否则 XMATIC 导入时会按横排把框重算一遍（竖排就没了）。
    const symbol = singleSection();
    const section = symbol.sections[0];
    const rotated: NormalizedSymbol = {
      ...symbol,
      sections: [
        {
          ...section,
          shapes: section.shapes.map((shape) =>
            shape.kind === "text" ? { ...shape, rotation: 90 } : shape,
          ),
        },
      ],
    };
    const xml = buildCaptureLibraryXml(rotated, "C:/libs/target.OLB");
    // Capture 的竖排真正靠 escapement（0.1° 为单位）：手改样本里 90° 就是 escapement="900"。
    // 只写 orientation 的话 Capture 仍然画横排（0.1.29~0.1.32 三次踩坑）。
    expect(xml).toContain('escapement="900"');
    expect(xml).toContain('orientation="90"');
    expect(xml).toContain('orientation="0"');
    // 90° 的框绕锚点旋转：宽度变成纵向高度，y 向上铺开
    const comment = /<CommentText>\s*<Defn locX="(-?\d+)" locY="(-?\d+)"[^>]*x1="(-?\d+)" x2="(-?\d+)" y1="(-?\d+)" y2="(-?\d+)" \/>/.exec(xml)!;
    const [locX, locY, x1, x2, y1, y2] = comment.slice(1).map(Number);
    // loc = 框的最小角（Capture 自己保存竖排文本时就是这个约定）
    expect(locX).toBe(Math.min(x1, x2));
    expect(locY).toBe(Math.min(y1, y2));
    // 竖框：高比宽大，且不再从锚点往右铺
    expect(x2 - x1).toBeLessThan(y2 - y1);
    expect(x1).toBe(rotated.sections[0].shapes[1].kind === "text" ? rotated.sections[0].shapes[1].at.x : NaN);

    // 未旋转的文本仍然是横框
    const horizontal = buildCaptureLibraryXml(symbol, "C:/libs/target.OLB");
    const flat = /<CommentText>\s*<Defn locX="(-?\d+)" locY="(-?\d+)"[^>]*x1="(-?\d+)" x2="(-?\d+)" y1="(-?\d+)" y2="(-?\d+)" \/>/.exec(horizontal)!;
    expect(Number(flat[4]) - Number(flat[3])).toBeGreaterThan(Number(flat[6]) - Number(flat[5]));
  });

  /**
   * 用户 2026-11-09 要求"文本支持换行"：Capture 的 CommentText 没有换行概念，
   * 一行必须是一条独立文本对象 —— 写库时按行拆开、按行距逐条往下错开。
   */
  it("多行注释文本拆成多条 CommentText，行距 = 字高 × 1.556", () => {
    const symbol = singleSection();
    const section = symbol.sections[0];
    const multiline: NormalizedSymbol = {
      ...symbol,
      sections: [
        {
          ...section,
          shapes: section.shapes.map((shape) =>
            shape.kind === "text" ? { ...shape, text: "AA\nBB" } : shape,
          ),
        },
      ],
    };
    const xml = buildCaptureLibraryXml(multiline, "C:/libs/target.OLB");
    expect(xml.match(/<CommentText>/g)).toHaveLength(2);
    expect(xml).toContain('name="AA"');
    expect(xml).toContain('name="BB"');

    const boxes = [...xml.matchAll(/<CommentText>\s*<Defn locX="(-?\d+)" locY="(-?\d+)"/g)].map(
      (match) => ({ x: Number(match[1]), y: Number(match[2]) }),
    );
    expect(boxes).toHaveLength(2);
    const step = Math.round(symbolFontHeight(12) * 1.556);
    expect(boxes[1].y - boxes[0].y).toBe(step);
    expect(boxes[1].x).toBe(boxes[0].x);
  });

  it("keeps every attribute value XML-escaped", () => {
    const symbol = singleSection();
    const withSpecialText: NormalizedSymbol = {
      ...symbol,
      name: 'A&B<C>"D"',
      sections: [
        {
          ...symbol.sections[0],
          name: "SEC",
          shapes: [
            ...symbol.sections[0].shapes,
            {
              kind: "text",
              text: 'R1 <"two">',
              at: { x: 1, y: 1 },
              rotation: 0,
              height: 12,
            },
          ],
        },
      ],
    };
    const xml = buildCaptureLibraryXml(withSpecialText, "C:/libs/target.OLB");
    expect(xml).toContain('name="A&amp;B&lt;C&gt;&quot;D&quot;"');
    expect(xml).toContain('name="R1 &lt;&quot;two&quot;&gt;"');
    expect(xml).not.toMatch(/<Defn[^>]*name="[^"]*[<>][^"]*"/);
  });

  it("produces a balanced element tree (every opened tag is closed)", () => {
    const xml = buildCaptureLibraryXml(singleSection(), "C:/libs/target.OLB");
    const opens: string[] = [];
    const closes: string[] = [];
    for (const match of xml.matchAll(/<(\/?)([A-Za-z][A-Za-z0-9_]*)([^>]*?)(\/?)>/g)) {
      const [, slash, name, , selfClose] = match;
      if (selfClose === "/") {
        continue;
      }
      if (slash === "/") {
        closes.push(name);
      } else {
        opens.push(name);
      }
    }
    expect(opens.sort()).toEqual(closes.sort());
  });
});

/**
 * 回读解析（inspectLibraryPart）—— 写入前探测同名器件、写入后校验内容都靠它。
 *
 * 样例照抄 Cadence `XMATIC_OLB2XML` 的真实导出结构（2026-10-16 用现网库导出的
 * XML 核对过）：`<Package>` 里先是一个带 name/refdesPrefix 的器件 Defn，
 * 后面每段一个 `<LibPart>`；**引脚 Defn 同样带 name 属性**（当年就是被它骗了，
 * 按名字扫 `<Defn name=...>` 扫到了第一个引脚，段数/脚数全读成 1/0，
 * 于是"写对了也报内容不一致"）。
 */
describe("inspectLibraryPart（回读解析）", () => {
  const pin = (name: string, x: number): string =>
    [
      "        <SymbolPinScalar>",
      `          <Defn hotptX="${x}" hotptY="0" name="${name}" position="5" startX="0" startY="0" type="0" visible="1" />`,
      "        </SymbolPinScalar>",
    ].join("\n");
  const libPart = (section: string, bodyWidth: number, pins: string): string =>
    [
      "    <LibPart>",
      `      <Defn CellName="${section}" />`,
      "      <NormalView>",
      `        <Rect><Defn fillStyle="1" hatchStyle="-1" lineStyle="0" lineWidth="0" x1="0" x2="${bodyWidth}" y1="0" y2="310"/></Rect>`,
      "        <CommentText>",
      '          <Defn locX="216" locY="132" name="PART" textJustification="0" x1="216" x2="278" y1="132" y2="148" />',
      "        </CommentText>",
      '        <SymbolBBox><Defn x1="0" x2="' + (bodyWidth + 4) + '" y1="0" y2="310"/></SymbolBBox>',
      '        <IsPinNamesRotated><Defn val="1"/></IsPinNamesRotated>',
      pins,
      "      </NormalView>",
      "      <PhysicalPart>",
      '        <Defn />',
      '        <PinNumber><Defn number="A1" position="0"/></PinNumber>',
      "      </PhysicalPart>",
      "    </LibPart>",
    ].join("\n");
  const library = (): string =>
    [
      '<?xml version="1.0" encoding="UTF-8" standalone="no" ?>',
      '<Lib xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="olb.xsd">',
      '  <Defn name="D:/libs/target.OLB" />',
      "  <Package>",
      '    <Defn alphabeticNumbering="1" isHomogeneous="0" name="BIGPART" pcbFootprint="BIGPART" pcbLib="" refdesPrefix="U" timestamp="1" timezone="0800" />',
      libPart("BIGPARTA", 506, pin("FATAL_ERR#", -10) + "\n" + pin("PEX_INTA#", -10)),
      libPart("BIGPARTB", 506, pin("VDD09", -10)),
      "  </Package>",
      "  <Package>",
      '    <Defn alphabeticNumbering="2" isHomogeneous="1" name="SMALLPART" pcbFootprint="SMALLPART" pcbLib="" refdesPrefix="R" timestamp="2" timezone="0800" />',
      libPart("SMALLPART", 120, pin("1", -10) + "\n" + pin("2", -10) + "\n" + pin("3", -10)),
      "  </Package>",
      "</Lib>",
      "",
    ].join("\n");

  it("读多段器件的段数/脚数/本体宽度（引脚 Defn 的 name 不会骗到解析）", () => {
    expect(inspectLibraryPart(library(), "BIGPART")).toEqual({
      sectionCount: 2,
      pinCount: 3,
      bodyWidth: 506,
    });
  });

  it("本体宽度取面积最大的 Rect，不是 SymbolBBox（后者含外伸引脚）", () => {
    const parsed = inspectLibraryPart(library(), "BIGPART");
    // SymbolBBox 写的是 510，本体 RECT 是 506 —— 必须报 506，否则校验恒判不一致
    expect(parsed?.bodyWidth).toBe(506);
  });

  it("单段器件同样读得出来（不因只有一个 LibPart 而退化）", () => {
    expect(inspectLibraryPart(library(), "SMALLPART")).toEqual({
      sectionCount: 1,
      pinCount: 3,
      bodyWidth: 120,
    });
  });

  it("库里没有这个器件时返回 null", () => {
    expect(inspectLibraryPart(library(), "NOT_THERE")).toBeNull();
    expect(inspectLibraryPart("", "BIGPART")).toBeNull();
  });

  it("只为某个器件统计，不把邻居的段/脚算进来", () => {
    const parsed = inspectLibraryPart(library(), "SMALLPART");
    expect(parsed?.sectionCount).toBe(1);
    expect(parsed?.pinCount).toBe(3);
  });
});

/**
 * 两个可配置项（用户 2026-10-19 要求）：
 *  - .olb 里的 PCB Footprint 字段可关（关掉就留空）；
 *  - 输出目录可以合成一个文件夹（自动库路径不再进 schlib 子目录）。
 */
describe("输出可配置项", () => {
  it("fillPcbFootprint=false 时 PCB Footprint 字段为空，其余不变", () => {
    const filled = buildCaptureLibraryXml(singleSection(), "C:/libs/t.olb");
    expect(filled).toContain('pcbFootprint="TESTPART_FOOTPRINT"');
    const blank = buildCaptureLibraryXml(singleSection(), "C:/libs/t.olb", {
      fillPcbFootprint: false,
    });
    expect(blank).toContain('pcbFootprint=""');
    expect(blank).not.toContain("TESTPART_FOOTPRINT");
    // 器件名/位号前缀不受影响
    expect(blank).toContain('name="TESTPART"');
    expect(blank).toContain('refdesPrefix="U"');
  });

  it("单文件夹模式下 .olb 直接落在库目录，不再建 schlib", () => {
    expect(autoLibraryPath("D:/lib", "MyLib")).toBe("D:\\lib\\schlib\\MyLib.olb");
    expect(autoLibraryPath("D:/lib", "MyLib", "unified")).toBe("D:\\lib\\MyLib.olb");
  });

  it("每封装独立文件夹：.olb 落在 <库>/<封装名>/<封装名>.olb", () => {
    expect(autoLibraryPath("D:/lib", "QFN-32_L5.0-W5.0", "perFootprint")).toBe(
      "D:\\lib\\QFN-32_L5.0-W5.0\\QFN-32_L5.0-W5.0.olb",
    );
  });
});

describe("deleted comment text", () => {
  it("隐藏的文本不写进 .olb（其它内容照常）", () => {
    const symbol = singleSection();
    const before = buildCaptureLibraryXml(symbol, "C:/libs/test.OLB");
    expect(before).toContain("TEST");

    const hidden = applySymbolEdits(symbol, setTextHidden({}, symbolShapeKey(0, 1), true));
    const after = buildCaptureLibraryXml(hidden, "C:/libs/test.OLB");
    expect(after).not.toContain(">TEST<");
    // 引脚与本体还在
    expect(after).toContain("hotptX");
  });
});

/**
 * 用户 2026-11-10：「预览与实际生成有差异，这个圆生成有问题」。
 *
 * 立创的圆/椭圆是 `E` 图元、圆角是 `A` 圆弧，而 OLB XML 的坐标只收整数
 * （`xs:long`）。半径 3 的圆按 24 边形采样再逐点取整，顶点大量重合 →
 * Capture 里画出来是"带台阶的八边形"，四角圆弧则变成斜面。
 *
 * 真实库（Gate.olb）证明 Capture 有 `<Ellipse>` / `<Arc>` 原生图元：
 *   与门本体右侧半圆 = 两段 90° `<Arc>`，`x1..y2` 是**整条椭圆**的包围盒，
 *   start→end 没有 large-arc 标志（固定按屏幕上逆时针画）。
 */
describe("原生曲线图元（Ellipse / Arc）", () => {
  const withShapes = (shapes: NormalizedSymbol["sections"][number]["shapes"]): string =>
    buildCaptureLibraryXml(
      {
        ...singleSection(),
        sections: [{ ...singleSection().sections[0], shapes }],
      },
      "C:/libs/curve.OLB",
    );

  it("椭圆写成一个 <Ellipse>，不再拆成 24 条 <Line>", () => {
    const xml = withShapes([
      {
        kind: "polyline",
        points: [
          { x: 13, y: 10 },
          { x: 10, y: 13 },
          { x: 7, y: 10 },
          { x: 10, y: 7 },
        ],
        closed: true,
        primitive: { type: "ellipse", center: { x: 10, y: 10 }, rx: 3, ry: 3 },
      },
    ]);
    expect(xml).toContain("<Ellipse>");
    expect(xml).not.toContain("<Line>");
    // 包围盒 = 圆心 ± 半径，且必须是整数（半径 1.5 这类小数会被 XSD 拒掉）
    expect(xml).toMatch(/<Defn [^/]*x1="7" x2="13" y1="7" y2="13" \/>/);
    // 空心：与真实库的椭圆一致（fillStyle=1 hatchStyle=0）
    expect(xml).toContain('fillStyle="1" hatchStyle="0"');
  });

  it("逆时针弧（delta<0）首尾原样写入", () => {
    // y 轴向下：角度增大 = 屏幕上顺时针，所以 delta<0 是从 (15,10) 往上弧到 (10,5)
    const xml = withShapes([
      {
        kind: "polyline",
        points: [
          { x: 15, y: 10 },
          { x: 10, y: 5 },
        ],
        closed: false,
        primitive: {
          type: "arc",
          center: { x: 10, y: 10 },
          rx: 5,
          ry: 5,
          startAngle: 0,
          deltaAngle: -Math.PI / 2,
        },
      },
    ]);
    expect(xml).toContain("<Arc>");
    expect(xml).not.toContain("<Line>");
    expect(xml).toMatch(/startX="15" startY="10"/);
    expect(xml).toMatch(/endX="10" endY="5"/);
    expect(xml).toMatch(/x1="5" x2="15" y1="5" y2="15"/);
  });

  it("顺时针弧（delta>0）要交换首尾：Capture 只会逆时针画", () => {
    const xml = withShapes([
      {
        kind: "polyline",
        points: [
          { x: 15, y: 10 },
          { x: 10, y: 15 },
        ],
        closed: false,
        primitive: {
          type: "arc",
          center: { x: 10, y: 10 },
          rx: 5,
          ry: 5,
          startAngle: 0,
          deltaAngle: Math.PI / 2,
        },
      },
    ]);
    expect(xml).toMatch(/startX="10" startY="15"/);
    expect(xml).toMatch(/endX="15" endY="10"/);
  });

  it("超过 180° 的弧拆成两段（一段表达不了）", () => {
    const xml = withShapes([
      {
        kind: "polyline",
        points: [
          { x: 15, y: 10 },
          { x: 10, y: 15 },
        ],
        closed: false,
        primitive: {
          type: "arc",
          center: { x: 10, y: 10 },
          rx: 5,
          ry: 5,
          startAngle: 0,
          deltaAngle: -1.5 * Math.PI,
        },
      },
    ]);
    expect(xml.match(/<Arc>/g)?.length).toBe(2);
  });

  it("没有原生参数的折线仍然逐段写 <Line>", () => {
    const xml = withShapes([
      {
        kind: "polyline",
        points: [
          { x: 0, y: 5 },
          { x: 10, y: 5 },
          { x: 10, y: 15 },
        ],
        closed: false,
      },
    ]);
    expect(xml.match(/<Line>/g)?.length).toBe(2);
    expect(xml).not.toContain("<Arc>");
  });
});
