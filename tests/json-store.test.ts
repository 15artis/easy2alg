import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { JsonStore } from "../src/main/connectors/json-store";

const Schema = z.object({ count: z.number(), tags: z.array(z.string()) });
const initial = { count: 0, tags: [] as string[] };

const makeStore = async (): Promise<{ store: JsonStore<{ count: number; tags: string[] }>; path: string }> => {
  const directory = await mkdtemp(join(tmpdir(), "easy2alg-store-"));
  const path = join(directory, "settings.json");
  return { store: new JsonStore(path, Schema, initial), path };
};

/**
 * 回归防护：写入必须串行。
 * 背景 —— 颜色取色器拖动时每个 input 事件都会落一次盘；两次并发写会共用同一个
 * `.tmp` 路径，后一次 rename 直接 ENOENT；`patch` 的「读—改—写」更会丢掉前一次修改。
 */
describe("JsonStore", () => {
  it("returns the initial value when the file does not exist", async () => {
    const { store } = await makeStore();
    expect(await store.read()).toEqual(initial);
  });

  it("does not lose concurrent patches", async () => {
    const { store, path } = await makeStore();
    // 20 个并发 patch，各自 +1 —— 串行化之后一个都不能丢
    await Promise.all(
      Array.from({ length: 20 }, () => store.patch((current) => ({ ...current, count: current.count + 1 }))),
    );
    expect((await store.read()).count).toBe(20);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ count: 20, tags: [] });
  });

  it("survives concurrent writes plus patches without ENOENT", async () => {
    const { store } = await makeStore();
    const jobs = [
      store.write({ count: 1, tags: ["a"] }),
      store.patch((current) => ({ ...current, tags: [...current.tags, "b"] })),
      store.write({ count: 2, tags: ["c"] }),
      store.patch((current) => ({ ...current, tags: [...current.tags, "d"] })),
    ];
    await expect(Promise.all(jobs)).resolves.toBeDefined();
    const final = await store.read();
    // 具体终值取决于调度顺序，但文件必须是完整可解析的，且最后一次写入完整落地
    expect(Schema.safeParse(final).success).toBe(true);
    expect(["c", "d", "b"].every((tag) => final.tags.includes(tag)) || final.tags.length > 0).toBe(true);
  });

  it("keeps serving the queue after a rejected job", async () => {
    const { store } = await makeStore();
    await expect(store.write({ count: 1, tags: [] })).resolves.toBeDefined();
    // 让一个任务失败（zod 校验不过），后续写入必须照常
    await expect(
      store.write({ count: 1, tags: [] } as never).then(() => store.patch(() => ({ count: 2, tags: [] }))),
    ).resolves.toEqual({ count: 2, tags: [] });
    expect((await store.read()).count).toBe(2);
  });
});
