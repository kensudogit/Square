import { describe, expect, test, vi } from "vitest";
import { SquareEnvironment } from "square";

/**
 * SDK クライアントの組み立て。
 *
 * ★ 環境の取り違えは「テストのつもりで本番課金」に直結する。
 *   sandbox 以外なら production、ではなく production のときだけ production を
 *   選んでいることを確かめる。
 */

const h = vi.hoisted(() => ({
  options: [] as { token?: string; environment?: string }[],
  config: {
    square: {
      accessToken: "EAAA_test_token",
      environment: "sandbox",
      locationId: "LTESTLOCATION",
    },
  },
}));

vi.mock("../src/config.js", () => ({ config: h.config }));

vi.mock("square", async (importOriginal) => {
  const actual = await importOriginal<typeof import("square")>();
  return {
    ...actual,
    SquareClient: class {
      constructor(options: { token?: string; environment?: string }) {
        h.options.push(options);
      }
    },
  };
});

/** 設定を差し替えてクライアントを組み直す */
async function buildClient(environment: string) {
  h.config.square.environment = environment;
  vi.resetModules();
  return import("../src/square/client.js");
}

describe("square クライアント", () => {
  test("sandbox 設定では Sandbox を向く", async () => {
    const { square, SQUARE_LOCATION_ID } = await buildClient("sandbox");

    expect(square).toBeDefined();
    expect(SQUARE_LOCATION_ID).toBe("LTESTLOCATION");
    expect(h.options.at(-1)).toEqual({
      token: "EAAA_test_token",
      environment: SquareEnvironment.Sandbox,
    });
  });

  test("production 設定でのみ Production を向く", async () => {
    await buildClient("production");
    expect(h.options.at(-1)).toMatchObject({ environment: SquareEnvironment.Production });
  });

  test("想定外の値は Sandbox 側に倒す（誤って本番に課金しない）", async () => {
    await buildClient("staging");
    expect(h.options.at(-1)).toMatchObject({ environment: SquareEnvironment.Sandbox });
  });
});
