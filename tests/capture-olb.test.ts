import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Elibz2Connector } from "../src/main/connectors/elibz2-connector";
import { buildCaptureLibraryXml } from "../src/main/conversion/capture-olb";
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
    expect(xml).toContain(
      '<Defn hotptX="30" hotptY="10" name="1" position="0" startX="20" startY="10" type="4" visible="1" />',
    );
    // power(7) 与 passive(4) 不同码，且每脚都带 PinNumber 序号
    expect(xml).toContain(
      '<Defn hotptX="-10" hotptY="10" name="GND" position="1" startX="0" startY="10" type="7" visible="1" />',
    );
    expect(xml).toContain('<Defn number="1" position="0" />');
    expect(xml).toContain('<Defn number="2" position="1" />');
  });

  it("uses letter-suffixed CellName for multi-section packages", async () => {
    const connector = new Elibz2Connector();
    const symbol = await connector.loadSymbol(fixturePath, deviceUuid);
    const xml = buildCaptureLibraryXml(symbol!, "C:/libs/target.OLB");
    expect(xml).toContain('alphabeticNumbering="1" isHomogeneous="0"');
    expect(xml).toContain('<Defn CellName="PEX8748_BACAA" />');
    expect(xml).toContain('<Defn CellName="PEX8748_BACAF" />');
    expect(xml.match(/<LibPart>/g)).toHaveLength(6);
    // 676 个引脚，每脚一个 SymbolPinScalar + 一个 PinNumber
    expect(xml.match(/<SymbolPinScalar>/g)).toHaveLength(676);
    expect(xml.match(/<PinNumber>/g)).toHaveLength(676);
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
