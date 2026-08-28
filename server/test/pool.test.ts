import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * トランザクションの境界。
 *
 * ★ 決済の入口は SELECT ... FOR UPDATE で注文行をロックする。commit / rollback /
 *   release のどれかを落とすと、接続が枯れるかロックが残って決済が全部止まる。
 *   実 DB を立てずにここだけ検証するため pg をモックする。
 */

const h = vi.hoisted(() => {
  const client = { query: vi.fn(), release: vi.fn() };
  // モジュール読み込み時に一度だけ登録されるハンドラは、モックの呼び出し履歴ではなく
  // 素のオブジェクトに退避しておく（履歴はテストごとにクリアされうる）
  const handlers: Record<string, (...args: never[]) => void> = {};
  const poolInstance = {
    on: vi.fn((event: string, handler: (...args: never[]) => void) => {
      handlers[event] = handler;
    }),
    connect: vi.fn(),
    end: vi.fn(),
    query: vi.fn(),
  };
  return { client, poolInstance, handlers, poolOptions: [] as unknown[] };
});

vi.mock("pg", () => ({
  default: {
    Pool: class {
      constructor(options: unknown) {
        h.poolOptions.push(options);
        return h.poolInstance as unknown as object;
      }
    },
  },
}));

const { pool, withTransaction, closePool } = await import("../src/db/pool.js");

beforeEach(() => {
  h.client.query.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
  h.client.release.mockReset();
  h.poolInstance.connect.mockReset().mockResolvedValue(h.client);
  h.poolInstance.end.mockReset().mockResolvedValue(undefined);
});

describe("pool", () => {
  test("接続文字列とプール上限が設定から渡されている", () => {
    expect(h.poolOptions[0]).toMatchObject({
      connectionString: process.env.DATABASE_URL,
      max: 10,
    });
  });

  test("プールのエラーはログに出るだけでプロセスを落とさない", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const handler = h.handlers.error as unknown as (e: Error) => void;

    expect(handler).toBeTypeOf("function");
    expect(() => handler(new Error("connection terminated"))).not.toThrow();
    expect(String(error.mock.calls.at(-1)?.[0])).toContain("database pool error");
  });

  test("pool は export されている（リポジトリ層から使う）", () => {
    expect(pool).toBe(h.poolInstance);
  });
});

describe("withTransaction", () => {
  test("成功したら commit して結果を返す", async () => {
    const result = await withTransaction(async (client) => {
      await client.query("select 1");
      return "ok";
    });

    expect(result).toBe("ok");
    expect(h.client.query.mock.calls.map((c) => c[0])).toEqual(["begin", "select 1", "commit"]);
    expect(h.client.release).toHaveBeenCalledTimes(1);
  });

  test("例外なら rollback して投げ直す", async () => {
    await expect(
      withTransaction(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(h.client.query.mock.calls.map((c) => c[0])).toEqual(["begin", "rollback"]);
    expect(h.client.release).toHaveBeenCalledTimes(1);
  });

  // ★ rollback 自体が失敗しても元の例外を握り潰さない。
  //   握り潰すと「決済が失敗した本当の理由」が消える
  test("rollback に失敗しても元の例外を投げる", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    h.client.query.mockImplementation((sql: string) => {
      if (sql === "rollback") return Promise.reject(new Error("connection lost"));
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    await expect(
      withTransaction(async () => {
        throw new Error("original failure");
      }),
    ).rejects.toThrow("original failure");

    expect(String(error.mock.calls.at(-1)?.[0])).toContain("rollback");
    expect(h.client.release).toHaveBeenCalledTimes(1);
  });

  test("commit が失敗しても接続は必ず返す（枯渇させない）", async () => {
    h.client.query.mockImplementation((sql: string) => {
      if (sql === "commit") return Promise.reject(new Error("commit failed"));
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    await expect(withTransaction(async () => "x")).rejects.toThrow("commit failed");
    expect(h.client.release).toHaveBeenCalledTimes(1);
  });
});

describe("closePool", () => {
  test("プールを閉じる", async () => {
    await closePool();
    expect(h.poolInstance.end).toHaveBeenCalledTimes(1);
  });
});
