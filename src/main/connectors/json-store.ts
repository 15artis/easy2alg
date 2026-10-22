import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { z } from "zod";

export class JsonStore<T> {
  readonly #path: string;
  readonly #schema: z.ZodType<T>;
  readonly #initialValue: T;
  /**
   * 写入串行队列。
   *
   * 必须有：`write` 走的是 "写 .tmp → rename" 两步，两次并发写会共用同一个 .tmp
   * 路径，后一次 rename 会因为文件已被搬走而报 ENOENT；`patch` 的
   * 「读—改—写」更是会直接丢掉前一次的修改。
   * 触发场景很现实：颜色取色器拖动时每个 input 事件都会落一次盘。
   */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(path: string, schema: z.ZodType<T>, initialValue: T) {
    this.#path = path;
    this.#schema = schema;
    this.#initialValue = initialValue;
  }

  async read(): Promise<T> {
    try {
      const content = await readFile(this.#path, "utf8");
      const parsed: unknown = JSON.parse(content);
      return this.#schema.parse(parsed);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return structuredClone(this.#initialValue);
      }
      throw error;
    }
  }

  async write(value: T): Promise<T> {
    const validated = this.#schema.parse(value);
    return this.#enqueue(async () => {
      await this.#writeFile(validated);
      return validated;
    });
  }

  /** 在队列内做「读—改—写」，并发调用不会互相覆盖。 */
  async patch(mutate: (current: T) => T): Promise<T> {
    return this.#enqueue(async () => {
      const current = await this.read();
      const updated = this.#schema.parse(mutate(current));
      await this.#writeFile(updated);
      return updated;
    });
  }

  async #enqueue<R>(job: () => Promise<R>): Promise<R> {
    // 前一个任务失败不能让后面全部雪崩：两条分支都继续跑。
    const run = this.#queue.then(job, job);
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async #writeFile(value: T): Promise<void> {
    const temporaryPath = `${this.#path}.tmp`;
    await mkdir(dirname(this.#path), { recursive: true });
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(temporaryPath, this.#path);
  }
}
