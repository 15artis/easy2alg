import type { NormalizedFootprint } from "./schemas";

/**
 * PCB 预览的图层模型。
 *
 * 图层名刻意用 Allegro 的实际叫法（PIN / PACKAGE GEOMETRY/SILKSCREEN_TOP /
 * SOLDERMASK_TOP …），右侧勾选框与预览共用这一份定义 —— 之前勾选框是写死的
 * 展示项，勾了不影响画布（用户 2026-10-16 反馈"没有实际功能"）。
 *
 * 阻焊/钢网在源数据里不是独立几何：它们由焊盘 + 外扩/内缩推导（与生成 .dra 时
 * 用到的 plan.solderMaskExpansionMm 同一套规则），所以这里只在有焊盘时才列出。
 */
export type FootprintLayerId =
  | "solderMask"
  | "pasteMask"
  | "pads"
  | "pinNumbers"
  | "holes"
  | "silkscreen"
  | "assembly"
  | "courtyard"
  | "documentation";

export type FootprintLayer = {
  readonly id: FootprintLayerId;
  readonly label: string;
  readonly allegro: string;
  readonly color: string;
  readonly dashed: boolean;
  readonly count: number;
  readonly defaultVisible: boolean;
};

const countShapesOn = (footprint: NormalizedFootprint, layer: string): number =>
  footprint.lines.filter((line) => line.layer === layer).length +
  footprint.circles.filter((circle) => circle.layer === layer).length;

export const footprintLayers = (
  footprint: NormalizedFootprint,
): readonly FootprintLayer[] => {
  const smdPads = footprint.pads.filter((pad) => pad.holeWidth === 0).length;
  const drilled =
    footprint.pads.filter((pad) => pad.holeWidth > 0).length + footprint.holes.length;
  const layers: readonly FootprintLayer[] = [
    {
      id: "pads",
      label: "铜焊盘",
      allegro: "PIN",
      color: "#d4a73f",
      dashed: false,
      count: footprint.pads.length,
      defaultVisible: true,
    },
    {
      id: "pinNumbers",
      label: "焊盘编号",
      allegro: "PACKAGE GEOMETRY / PIN_NUMBER",
      color: "#5e4d25",
      dashed: false,
      count: footprint.pads.length,
      defaultVisible: true,
    },
    {
      id: "solderMask",
      label: "阻焊开窗",
      allegro: "SOLDERMASK_TOP",
      color: "#4f9d6a",
      dashed: true,
      count: footprint.pads.length,
      defaultVisible: true,
    },
    {
      id: "pasteMask",
      label: "钢网开口",
      allegro: "PASTEMASK_TOP",
      color: "#9aa4b0",
      dashed: true,
      count: smdPads,
      defaultVisible: false,
    },
    {
      id: "holes",
      label: "钻孔",
      allegro: "DRILL",
      color: "#687481",
      dashed: false,
      count: drilled,
      defaultVisible: true,
    },
    {
      id: "silkscreen",
      label: "顶层丝印",
      allegro: "PACKAGE GEOMETRY / SILKSCREEN_TOP",
      color: "#f4a31a",
      dashed: false,
      count: countShapesOn(footprint, "silkscreen"),
      defaultVisible: true,
    },
    {
      id: "assembly",
      label: "装配外形",
      allegro: "PACKAGE GEOMETRY / ASSEMBLY_TOP",
      color: "#8f9ba8",
      dashed: false,
      count: countShapesOn(footprint, "assembly"),
      defaultVisible: true,
    },
    {
      id: "courtyard",
      label: "禁布区",
      allegro: "PACKAGE GEOMETRY / PLACE_BOUND_TOP",
      color: "#7d8794",
      dashed: true,
      count: countShapesOn(footprint, "courtyard"),
      defaultVisible: false,
    },
    {
      id: "documentation",
      label: "文档层",
      allegro: "PACKAGE GEOMETRY / DOCUMENTATION",
      color: "#b0b8c2",
      dashed: true,
      count: countShapesOn(footprint, "documentation"),
      defaultVisible: false,
    },
  ];
  // 源数据里没有的层不列出来，免得勾了也看不到东西。
  return layers.filter((layer) => layer.count > 0);
};

export const defaultVisibleLayers = (
  layers: readonly FootprintLayer[],
): ReadonlySet<FootprintLayerId> =>
  new Set(layers.filter((layer) => layer.defaultVisible).map((layer) => layer.id));

/** 只保留当前确实存在的图层，避免换器件后残留上一次的勾选。 */
export const normalizeVisibleLayers = (
  layers: readonly FootprintLayer[],
  visible: ReadonlySet<FootprintLayerId>,
): ReadonlySet<FootprintLayerId> => {
  const existing = new Set(layers.map((layer) => layer.id));
  const kept = new Set([...visible].filter((id) => existing.has(id)));
  if (kept.size === 0 && layers.length > 0) {
    return defaultVisibleLayers(layers);
  }
  return kept;
};
