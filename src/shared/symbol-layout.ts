import type {
  NormalizedSymbol,
  NormalizedSymbolPin,
  NormalizedSymbolSection,
  NormalizedSymbolShape,
} from "./schemas";
import {
  SYMBOL_LABEL_CLEARANCE,
  SYMBOL_LABEL_HALF,
  SYMBOL_LABEL_OFFSET,
  bodyBoxOf,
  boxesOverlap,
  commentTextBox,
  estimateLabelWidth,
  pinIsVertical,
  pinNameBox,
  pinNumberBox,
  pinSideOf,
  type SymbolBox,
} from "./symbol-labels";
import { transformSymbolPrimitive } from "./symbol-edit";

/**
 * 引脚标签避让 —— 用几何手段消除标签重叠（用户 2026-10-16 反馈"标签叠到一起"）。
 *
 * 为什么不能逐脚指定标签位置：orcad-package-autogen 走的是 PinDisplayProp。
 * 实测把现网库里 **Cadence 自己导出**的 PinDisplayProp 原样喂给
 * `XMATIC_XML2OLB`，导入后再导出，元素数为 0 —— 这条导入路径**静默丢弃**
 * PinDisplayProp（本工具链第三次遇到"报 ok 但掉料"）。所以只能改几何。
 *
 * 重叠成因（见 shared/symbol-labels.ts 的实测规则）：竖排名字从本体上/下边往
 * **本体内部**长、横排名字从左/右边往**本体内部**长，两者在**四角**必相交。
 * 立创EDA 的本体是按比 Capture 小得多的字宽设计的，于是上/下引脚常常一整排
 * 都落在左右名字占的竖带里（PEX8748 的 6 段里有 5 段如此）。
 *
 * 解法（最小改动、不改引脚顺序、不改引脚间距）：
 *  1. 算出左右两条竖带的深度（各自最长名字宽）；
 *  2. 中段（两带之间）放不下上/下引脚时就**把本体加宽** —— 右边缘右移，
 *     右侧引脚跟着右移，其余不动；
 *  3. 把上/下引脚**整体平移**到中段居中（同一段内所有竖脚位移一致，
 *     相对间距与顺序原样保留）。
 *
 * 位移取 5 的整数倍：源数据本来就是 10 单位网格，落在 5 的倍数上不破坏
 * 对齐手感（Capture 符号编辑器默认网格 10，半格仍然好拖）。
 */

/** 用来吸收 5 单位取整误差的额外余量。 */
const GRID = 5;

/** 某一侧名字占的竖带深度（该侧最长名字宽）。 */
const sideDepth = (pins: readonly NormalizedSymbolPin[], side: "left" | "right"): number =>
  pins.reduce(
    (depth, pin) => (pinSideOf(pin) === side ? Math.max(depth, estimateLabelWidth(pin.name)) : depth),
    0,
  );

/** 竖带的内缩量：名字从本体边内缩 OFFSET 起排，再留 CLEARANCE 与文字半宽。 */
const bandInset = (depth: number): number =>
  depth > 0
    ? SYMBOL_LABEL_OFFSET + depth + SYMBOL_LABEL_CLEARANCE + SYMBOL_LABEL_HALF
    : SYMBOL_LABEL_HALF;

const shiftPin = (pin: NormalizedSymbolPin, dx: number, dy: number): NormalizedSymbolPin => ({
  ...pin,
  connection: { x: pin.connection.x + dx, y: pin.connection.y + dy },
  body: { x: pin.body.x + dx, y: pin.body.y + dy },
});

const spanOf = (pins: readonly NormalizedSymbolPin[]): number => {
  if (pins.length === 0) {
    return 0;
  }
  const xs = pins.map((pin) => pin.connection.x);
  return Math.max(...xs) - Math.min(...xs);
};

const roundGrid = (value: number): number => Math.round(value / GRID) * GRID;

/** 判定"贴住本体右边缘"的容差。 */
const EDGE_TOLERANCE = 1;

/**
 * 本体加宽时，右端贴住本体右边缘的图元必须跟着外推 —— 否则本体变宽了，
 * 那条横贯本体的分隔线（Station0 的 `poly (0,200)-(180,200)`）会比本体短一截。
 * 只推"正好落在右边缘上"的端点，伸到本体外面的引线不动。
 */
const pushRightEdge = (
  shape: NormalizedSymbolShape,
  bodyMaxX: number,
  widen: number,
): NormalizedSymbolShape => {
  if (widen === 0) {
    return shape;
  }
  if (shape.kind === "rect") {
    if (Math.abs(Math.max(shape.min.x, shape.max.x) - bodyMaxX) > EDGE_TOLERANCE) {
      return shape;
    }
    // 保持 RECT 原本的角点顺序，只把"右边缘"那条边推出去。
    return shape.max.x >= shape.min.x
      ? { ...shape, max: { x: shape.max.x + widen, y: shape.max.y } }
      : { ...shape, min: { x: shape.min.x + widen, y: shape.min.y } };
  }
  if (shape.kind === "polyline") {
    if (!shape.points.some((point) => Math.abs(point.x - bodyMaxX) <= EDGE_TOLERANCE)) {
      return shape;
    }
    return {
      ...shape,
      points: shape.points.map((point) =>
        Math.abs(point.x - bodyMaxX) <= EDGE_TOLERANCE ? { ...point, x: point.x + widen } : point,
      ),
      // 端点被逐个挪动后已经不再是同一条椭圆/圆弧，原生图元必须丢掉（退回折线）
      primitive: undefined,
    };
  }
  return shape;
};

/**
 * 居中标题跟着新本体重新居中。
 *
 * 本体只往右加宽，居中的标题（PEX8748 / VDD / VSS …）不挪就会明显偏左。
 * 判据很窄，只动"原本就居中"的那些（横向中心落在本体中心 ±6% 以内），
 * 区域标注（JTAG / EEPROM / Configuration Strap pins）不会被误伤；
 * 挪完还会再查一遍会不会压到引脚标签 —— 会压就宁可不挪（偏一点总比重叠好）。
 */
const CENTER_TOLERANCE = 0.06;

const recenterTitles = (
  shapes: readonly NormalizedSymbolShape[],
  body: SymbolBox,
  grownMaxX: number,
  widen: number,
  pins: readonly NormalizedSymbolPin[],
): NormalizedSymbolShape[] => {
  const oldWidth = body.maxX - body.minX;
  if (widen === 0 || oldWidth <= 0) {
    return [...shapes];
  }
  const oldCenter = (body.minX + body.maxX) / 2;
  const grownBody: SymbolBox = { ...body, maxX: grownMaxX };
  const labels: SymbolBox[] = pins.flatMap((pin) => [
    pinNameBox(pin, grownBody),
    pinNumberBox(pin, grownBody),
  ]);
  const dx = roundGrid(widen / 2);

  return shapes.map((shape) => {
    if (shape.kind !== "text" || dx === 0) {
      return shape;
    }
    const box = commentTextBox(shape);
    const center = (box.minX + box.maxX) / 2;
    if (Math.abs(center - oldCenter) > oldWidth * CENTER_TOLERANCE) {
      return shape;
    }
    const moved = { ...shape, at: { x: shape.at.x + dx, y: shape.at.y } };
    const movedBox = commentTextBox(moved);
    return labels.some((label) => boxesOverlap(movedBox, label)) ? shape : moved;
  });
};

export const avoidLabelOverlap = (symbol: NormalizedSymbol): NormalizedSymbol => ({
  ...symbol,
  sections: symbol.sections.map(avoidLabelOverlapInSection),
});

/**
 * 区域标注（CommentText）与引脚标签避让。
 *
 * Capture 的引脚名字宽比立创EDA 大得多，源符号里"刚好不挨着"的区域标注会压到
 * 引脚名上（用户截图里的 `JTAG` 压 `JTAG_TDO`、`Configuration Strap pins` 压一片
 * `STRAP_*`）。这里在 5 单位网格上按"位移从小到大"找一个不冲突的落点，
 * 找不到就把原位置留着 —— 预览里可以手动拖，硬塞反而更糟。
 */
const NUDGE_LIMIT = 80;

const NUDGE_CANDIDATES: readonly (readonly [number, number])[] = (() => {
  const list: [number, number][] = [[0, 0]];
  for (let step = GRID; step <= NUDGE_LIMIT; step += GRID) {
    list.push([step, 0], [-step, 0], [0, -step], [0, step]);
  }
  for (let step = GRID; step <= NUDGE_LIMIT; step += GRID) {
    list.push([step, -step], [step, step], [-step, -step], [-step, step]);
  }
  return list;
})();

const resolveTextCollisions = (section: NormalizedSymbolSection): NormalizedSymbolSection => {
  if (!section.shapes.some((shape) => shape.kind === "text")) {
    return section;
  }
  const body = bodyBoxOf(section);
  const labels: SymbolBox[] = section.pins.flatMap((pin) => [
    pinNameBox(pin, body),
    pinNumberBox(pin, body),
  ]);
  const placed: SymbolBox[] = [];
  let changed = false;

  const shapes = section.shapes.map((shape) => {
    if (shape.kind !== "text") {
      return shape;
    }
    const boxes = [...labels, ...placed];
    const home = commentTextBox(shape);
    for (const [dx, dy] of NUDGE_CANDIDATES) {
      const candidate =
        dx === 0 && dy === 0
          ? shape
          : { ...shape, at: { x: shape.at.x + dx, y: shape.at.y + dy } };
      const box = commentTextBox(candidate);
      if (boxes.some((other) => boxesOverlap(box, other))) {
        continue;
      }
      placed.push(box);
      changed = changed || candidate !== shape;
      return candidate;
    }
    placed.push(home);
    return shape;
  });

  return changed ? { ...section, shapes } : section;
};

export const avoidLabelOverlapInSection = (
  section: NormalizedSymbolSection,
): NormalizedSymbolSection => resolveTextCollisions(widenForVerticalLabels(section));

const widenForVerticalLabels = (
  section: NormalizedSymbolSection,
): NormalizedSymbolSection => {
  const vertical = section.pins.filter(pinIsVertical);
  if (vertical.length === 0) {
    return section;
  }
  /**
   * 没有矩形本体（三极管 / MOSFET / 二极管 / 用折线画的连接器）：本体就是图形本身，
   * 没有"中段"可以让竖脚居中。硬挪只会把引脚从图形上推走 —— C18221391 的漏/源脚
   * 被推到右边缘、和源数据的接点差一格（用户 2026-10-23 截图）。
   * 这类符号优先保"引脚端点落在图元上"，标签重叠交给文字避让。
   */
  if (!section.shapes.some((shape) => shape.kind === "rect")) {
    return section;
  }
  const body = bodyBoxOf(section);
  const leftDepth = sideDepth(section.pins, "left");
  const rightDepth = sideDepth(section.pins, "right");
  const leftInset = bandInset(leftDepth);
  const rightInset = bandInset(rightDepth);
  const span = spanOf(vertical);

  // ① 中段要容得下整排竖脚 + 一格取整余量，不够就把本体加宽（只右移右边缘）。
  const requiredWidth = leftInset + span + GRID + rightInset;
  const bodyWidth = body.maxX - body.minX;
  const needed = Math.max(0, Math.ceil(requiredWidth - bodyWidth));
  // 加宽时把右边缘也推到 10 单位格点上：右列引脚的连接端 = 右边缘 + 引脚长，
  // 边缘落在半格上时整排引脚都接不上线（PEX8748 右侧 182 脚实测）。
  const widen =
    needed === 0
      ? 0
      : Math.ceil((body.maxX + needed) / PIN_GRID) * PIN_GRID - body.maxX;
  const grownMaxX = body.maxX + widen;

  // ② 竖脚整体平移到中段正中；并夹回带内。
  //    步长看这一排本身：整排已经落在 10 单位格点上时按 10 挪，别把它推到半格
  //    （半格的引脚在 Capture 原理图里接不上线，用户 2026-10-19 反馈）。
  const bandStart = body.minX + leftInset;
  const bandEnd = grownMaxX - rightInset;
  const xs = vertical.map((pin) => pin.connection.x);
  const groupMin = Math.min(...xs);
  const groupMax = Math.max(...xs);
  const onTenGrid = new Set(xs.map((x) => ((Math.round(x) % PIN_GRID) + PIN_GRID) % PIN_GRID)).size === 1;
  const step = onTenGrid ? PIN_GRID : GRID;
  let shift = Math.round(
    ((bandStart + bandEnd) / 2 - (groupMin + groupMax) / 2) / step,
  ) * step;
  if (groupMin + shift < bandStart) {
    shift = Math.ceil((bandStart - groupMin) / step) * step;
  }
  if (groupMax + shift > bandEnd) {
    shift = Math.floor((bandEnd - groupMax) / step) * step;
  }

  if (widen === 0 && shift === 0) {
    return section;
  }

  // 本体矩形与贴住右边缘的分隔线一起外推，其余图元不动。
  const shapes: NormalizedSymbolShape[] = section.shapes.map((shape) =>
    pushRightEdge(shape, body.maxX, widen),
  );

  // ③ 竖脚整排平移（只动相对间距的起点，不重排）
  const pins = section.pins.map((pin) => {
    const widened = pinSideOf(pin) === "right" && widen > 0 ? shiftPin(pin, widen, 0) : pin;
    return pinIsVertical(widened) && shift !== 0 ? shiftPin(widened, shift, 0) : widened;
  });

  return {
    ...section,
    bounds: { ...section.bounds, maxX: section.bounds.maxX + widen },
    shapes: recenterTitles(shapes, body, grownMaxX, widen, pins),
    pins,
  };
};

/**
 * 引脚坐标吸附到 Capture 的 100 mil 网格（10 单位）。
 *
 * 立创的符号常用 **5 单位**（50 mil）半格：PEX8748 有 247/676 个引脚落在 x=145/155…
 * 这种半格位置上。放进 Capture 原理图（默认 100 mil 吸附网格）后，这些引脚**接不上线**
 * （用户 2026-10-19 反馈"引脚没落在网格上导致线连不上"）。
 *
 * 做法：**按侧分组整排平移**，不逐脚取整 —— 逐脚 round 会把 145/155 挤成 140/150
 * 甚至撞到一起；整排平移只改起点、相对间距与顺序原样保留。
 * 前提是该侧所有引脚在变化方向上的余数一致（间距本身是 10 的整数倍）；
 * 0.5mm 间距这种本来就对不齐的器件直接跳过，不做破坏性调整。
 */
export const SYMBOL_PIN_GRID = 10;
const PIN_GRID = SYMBOL_PIN_GRID;

const gridRemainder = (value: number): number =>
  ((Math.round(value) % PIN_GRID) + PIN_GRID) % PIN_GRID;

/** 余数 → 位移：往前挪 remainder，或往后挪 10-remainder，取位移小的那个。 */
const gridDelta = (remainder: number): number => {
  if (remainder === 0) {
    return 0;
  }
  return remainder <= PIN_GRID / 2 ? -remainder : PIN_GRID - remainder;
};

const shiftShape = (
  shape: NormalizedSymbolShape,
  dx: number,
  dy: number,
): NormalizedSymbolShape => {
  if (shape.kind === "rect") {
    return {
      ...shape,
      min: { x: shape.min.x + dx, y: shape.min.y + dy },
      max: { x: shape.max.x + dx, y: shape.max.y + dy },
    };
  }
  if (shape.kind === "polyline") {
    return {
      ...shape,
      points: shape.points.map((point) => ({ x: point.x + dx, y: point.y + dy })),
      primitive:
        shape.primitive === undefined
          ? undefined
          : transformSymbolPrimitive(shape.primitive, dx, dy),
    };
  }
  return { ...shape, at: { x: shape.at.x + dx, y: shape.at.y + dy } };
};

/** 整段平移（引脚 + 图元 + 包围盒），保证引脚与图形不会相对错位。 */
const shiftSection = (
  section: NormalizedSymbolSection,
  dx: number,
  dy: number,
): NormalizedSymbolSection => {
  if (dx === 0 && dy === 0) {
    return section;
  }
  return {
    ...section,
    bounds: {
      minX: section.bounds.minX + dx,
      minY: section.bounds.minY + dy,
      maxX: section.bounds.maxX + dx,
      maxY: section.bounds.maxY + dy,
    },
    pins: section.pins.map((pin) => shiftPin(pin, dx, dy)),
    shapes: section.shapes.map((shape) => shiftShape(shape, dx, dy)),
  };
};

export const alignPinsToGrid = (section: NormalizedSymbolSection): NormalizedSymbolSection => {
  const sides: readonly ("left" | "right" | "top" | "bottom")[] = ["left", "right", "top", "bottom"];
  const shifts = new Map<NormalizedSymbolPin, { dx: number; dy: number }>();

  for (const side of sides) {
    const group = section.pins.filter((pin) => pinSideOf(pin) === side);
    if (group.length === 0) {
      continue;
    }
    const vertical = side === "left" || side === "right";
    const values = group.map((pin) => (vertical ? pin.connection.y : pin.connection.x));
    const remainders = new Set(values.map(gridRemainder));
    // 间距不是 10 的整数倍（如 0.5mm 间距）→ 整体挪也救不了，跳过
    if (remainders.size !== 1) {
      continue;
    }
    const delta = gridDelta([...remainders][0]);
    if (delta === 0) {
      continue;
    }
    for (const pin of group) {
      shifts.set(pin, vertical ? { dx: 0, dy: delta } : { dx: delta, dy: 0 });
    }
  }

  if (shifts.size === 0) {
    return section;
  }

  /**
   * 整段平移优先：引脚和图形必须一起挪。
   *
   * 只挪引脚会在引脚与图元之间留一道缝 —— C18221391（MOSFET）的栅极线、漏/源引线
   * 在预览和导出的 OLB 里都看起来"断开 1 个单位"（用户 2026-10-23 反馈）。
   * 前提是同一轴上**所有**引脚余数一致：否则整段挪会把本来落在格点上的引脚推歪。
   */
  const axisRemainders = (axis: "x" | "y"): Set<number> => {
    const pins = section.pins.filter((pin) => {
      const side = pinSideOf(pin);
      const vertical = side === "top" || side === "bottom";
      return axis === "x" ? vertical : !vertical;
    });
    return new Set(pins.map((pin) => gridRemainder(pin.connection[axis])));
  };
  const xRemainders = axisRemainders("x");
  const yRemainders = axisRemainders("y");
  if (xRemainders.size <= 1 && yRemainders.size <= 1) {
    return shiftSection(
      section,
      gridDelta([...xRemainders][0] ?? 0),
      gridDelta([...yRemainders][0] ?? 0),
    );
  }

  // 各排余数不一致：只能逐排挪引脚（图形不动），保引脚落格优先
  return {
    ...section,
    pins: section.pins.map((pin) => {
      const shift = shifts.get(pin);
      return shift === undefined ? pin : shiftPin(pin, shift.dx, shift.dy);
    }),
  };
};

/** 引脚长度取到最近的 10 的整数倍，最小一格。 */
const pinLengthOnGrid = (length: number): number =>
  Math.max(SYMBOL_PIN_GRID, Math.round(length / SYMBOL_PIN_GRID) * SYMBOL_PIN_GRID);

/**
 * 让每个引脚的**两端都落在 100 mil 网格**上 —— 用户 2026-11-10 明确要求
 * 「生成的图 OrCAD 尺寸需要满足引脚落在网格上，也就是 100 mil」。
 *
 * 依据：本机 Cadence 自带库导出件里 51109/51414（Connector.olb）引脚两端都是
 * 10 的整数倍，长度只有 0 / 10 / 30。立创的符号常用 15 单位引脚、本体端点还落在
 * 半格上（SACB5.0：startY=4、长 15），直接照抄进 .olb，Capture 里就是歪的 ——
 * 预览按自己的坐标画得很准，实物对不上，正是这个差异。
 *
 * 三步，只在必要时动，尽量保持图形与引脚的相对关系：
 *  1. **整段平移**：所有引脚的「本体端」在同一轴上余数一致时，把**图元 + 引脚一起**
 *     挪到格点（只挪引脚会跟图元裂开一道缝）。SACB5.0 的 -4 就是这一步。
 *  2. **排方向补格**：余数不一致（整段挪不动，例如被标签避让推过的右脚、或预览里
 *     拖过的脚）时，沿**垂直于引脚轴**的方向整脚平移；再把本体端沿引脚轴推到最近格点。
 *  3. **长度取整**：连接端推到 10 的整数倍处，本体端继续贴图元（15 → 20 这类）。
 */
export const alignPinEndsToGrid = (section: NormalizedSymbolSection): NormalizedSymbolSection => {
  if (section.pins.length === 0) {
    return section;
  }
  const bodyX = new Set(section.pins.map((pin) => gridRemainder(pin.body.x)));
  const bodyY = new Set(section.pins.map((pin) => gridRemainder(pin.body.y)));
  const dx = bodyX.size === 1 ? gridDelta([...bodyX][0]) : 0;
  const dy = bodyY.size === 1 ? gridDelta([...bodyY][0]) : 0;
  const aligned = dx === 0 && dy === 0 ? section : shiftSection(section, dx, dy);

  let changed = aligned !== section;
  const pins = aligned.pins.map((pin) => {
    let body = pin.body;
    let connection = pin.connection;
    let length = Math.hypot(connection.x - body.x, connection.y - body.y);
    // 零长度引脚（贴在体边的隐藏电源脚）无从判断方向，原样保留
    if (length < 1e-6) {
      return pin;
    }
    const horizontal = Math.abs(connection.x - body.x) >= Math.abs(connection.y - body.y);
    // ① 排方向（垂直于引脚轴）整脚平移：拖动过的手动坐标可能停在半格上
    const rowValue = horizontal ? body.y : body.x;
    const rowDelta = Math.round(rowValue / SYMBOL_PIN_GRID) * SYMBOL_PIN_GRID - rowValue;
    if (rowDelta !== 0) {
      body = horizontal ? { x: body.x, y: body.y + rowDelta } : { x: body.x + rowDelta, y: body.y };
      connection = horizontal
        ? { x: connection.x, y: connection.y + rowDelta }
        : { x: connection.x + rowDelta, y: connection.y };
      changed = true;
    }
    // ② 引脚轴方向：本体端推到最近格点（一般正好落在本体边缘上）
    const axisValue = horizontal ? body.x : body.y;
    const axisDelta = Math.round(axisValue / SYMBOL_PIN_GRID) * SYMBOL_PIN_GRID - axisValue;
    if (axisDelta !== 0) {
      body = horizontal ? { x: body.x + axisDelta, y: body.y } : { x: body.x, y: body.y + axisDelta };
      changed = true;
    }
    // ③ 长度取 10 的整数倍：只挪连接端，本体端继续贴图元
    const vx = connection.x - body.x;
    const vy = connection.y - body.y;
    const raw = Math.hypot(vx, vy);
    const target = pinLengthOnGrid(raw);
    const snapped = {
      x: body.x + (vx / raw) * target,
      y: body.y + (vy / raw) * target,
    };
    if (Math.abs(target - length) > 1e-6) {
      changed = true;
    }
    return { ...pin, body, connection: snapped, length: target };
  });

  return changed ? { ...aligned, pins } : aligned;
};

/**
 * 按引脚号自然序重排（1、2、3…9、10）。
 *
 * 立创的 `shape` 数组不按焊盘号排列 —— SMA-KWE 是 5、4、3、2、1。OLB 的
 * `position` 是数组下标，Capture 用它对齐名字与脚号，照原顺序写就整体错位：
 * 每个脚内侧一个名字、外侧一个编号，数值还不同（用户 2026-11-10 报的
 * "41 / 32 / 35" 就是这个）。手动在 Capture 里画的同类器件都是 1..N 顺序，
 * 这里对齐它：排序后 position 与脚号一致，两个标签落在同一处、同一个数字。
 */
export const sortPinsByNumber = (
  section: NormalizedSymbolSection,
): NormalizedSymbolSection => {
  // 纯数字按数值比，其他（A1、GND_2）退回自然序；两侧等价时保持原顺序（稳定排序）。
  const sorted = [...section.pins].sort((a, b) =>
    a.number.localeCompare(b.number, "en", { numeric: true, sensitivity: "base" }),
  );
  const same = sorted.every((pin, index) => pin === section.pins[index]);
  return same ? section : { ...section, pins: sorted };
};
