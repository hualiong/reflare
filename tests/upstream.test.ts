import useReflare, { cloneRequest, isPathMatch, isUrlMatch } from "../src";

const fetchMock = getMiniflareFetchMock();
fetchMock.disableNetConnect();

const origin = fetchMock.get("https://test-domain.com");
const httpOrigin = fetchMock.get("http://test-domain.com:8080");

describe("Reflare", () => {
  let reflare: Awaited<ReturnType<typeof useReflare>>;

  beforeEach(async () => {
    reflare = await useReflare();
  });

  // ── 路由匹配 ──────────────────────────────────────────

  test("forwards request to upstream", async () => {
    origin.intercept({ path: "/get" }).reply(200);

    reflare.push({
      path: "/*",
      upstream: { domain: "test-domain.com" },
    });

    const response = await reflare.handle(new Request("https://localhost/get"));
    expect(response.status).toBe(200);
    expect(response.url).toBe("https://test-domain.com/get");
  });

  test("matches first matching path in array", async () => {
    origin.intercept({ path: "/status/200" }).reply(200);

    reflare.push({
      path: ["/no-match", "/also/no-match", "/status*"],
      upstream: { domain: "test-domain.com" },
    });

    const response = await reflare.handle(new Request("https://localhost/status/200"));
    expect(response.status).toBe(200);
    expect(response.url).toBe("https://test-domain.com/status/200");
  });

  test("returns 404 when no route matches", async () => {
    const response = await reflare.handle(new Request("https://localhost/nowhere"));
    expect(response.status).toBe(404);
  });

  test("respects method restrictions", async () => {
    origin.intercept({ path: "/data" }).reply(200);

    reflare.push({
      path: "/data",
      methods: ["GET"],
      upstream: { domain: "test-domain.com" },
    });

    const ok = await reflare.handle(new Request("https://localhost/data", { method: "GET" }));
    expect(ok.status).toBe(200);

    const fail = await reflare.handle(new Request("https://localhost/data", { method: "POST" }));
    expect(fail.status).toBe(404);
  });

  test("unshift gives route higher priority than push", async () => {
    origin.intercept({ path: "/v2/data" }).reply(200);

    reflare.push({
      path: "/*",
      upstream: { domain: "other-domain.com" },
    });
    reflare.unshift({
      path: "/v2/*",
      upstream: { domain: "test-domain.com" },
    });

    const response = await reflare.handle(new Request("https://localhost/v2/data"));
    expect(response.url).toBe("https://test-domain.com/v2/data");
  });

  // ── URL 转换 ──────────────────────────────────────────

  test("stripPrefix removes wildcard prefix from upstream path", async () => {
    origin.intercept({ path: "/api/books" }).reply(200);

    reflare.push({
      path: "/prefix/*",
      upstream: { domain: "test-domain.com", stripPrefix: true },
    });

    const response = await reflare.handle(new Request("https://localhost/prefix/api/books"));
    expect(response.status).toBe(200);
    expect(response.url).toBe("https://test-domain.com/api/books");
  });

  test("stripPrefix is no-op when pattern has no wildcard", async () => {
    origin.intercept({ path: "/health" }).reply(200);

    reflare.push({
      path: "/health",
      upstream: { domain: "test-domain.com", stripPrefix: true },
    });

    const response = await reflare.handle(new Request("https://localhost/health"));
    expect(response.url).toBe("https://test-domain.com/health");
  });

  test("preserves full path when stripPrefix is not set", async () => {
    origin.intercept({ path: "/prefix/api/books" }).reply(200);

    reflare.push({
      path: "/prefix/*",
      upstream: { domain: "test-domain.com" },
    });

    const response = await reflare.handle(new Request("https://localhost/prefix/api/books"));
    expect(response.url).toBe("https://test-domain.com/prefix/api/books");
  });

  test("applies custom protocol and port to upstream URL", async () => {
    httpOrigin.intercept({ path: "/data" }).reply(200);

    reflare.push({
      path: "/data",
      upstream: { domain: "test-domain.com", protocol: "http", port: 8080 },
    });

    const response = await reflare.handle(new Request("https://localhost/data"));
    expect(response.url).toBe("http://test-domain.com:8080/data");
  });

  // ── 请求转换 (onRequest) ─────────────────────────────

  test("transforms request URL via onRequest callback", async () => {
    origin.intercept({ path: "/get" }).reply(200);

    reflare.push({
      path: "/foo*",
      upstream: {
        domain: "test-domain.com",
        onRequest: (_req: Request, url: string) => new Request(url.replace("foo/bar/baz", "get")),
      },
    });

    const response = await reflare.handle(new Request("https://localhost/foo/bar/baz"));
    expect(response.url).toBe("https://test-domain.com/get");
  });

  test("chains multiple onRequest callbacks and progressively transforms URL", async () => {
    origin.intercept({ path: "/final" }).reply(200);

    reflare.push({
      path: "/start",
      upstream: {
        domain: "test-domain.com",
        onRequest: [
          (_req: Request, url: string) => new Request(url.replace("start", "middle")),
          (req: Request, _url: string) => new Request(req.url.replace("middle", "final")),
        ],
      },
    });

    const response = await reflare.handle(new Request("https://localhost/start"));
    // 最终 URL 包含 "final" 证明两个回调都执行了且顺序正确
    expect(response.url).toBe("https://test-domain.com/final");
  });

  // ── 响应转换 (onResponse) ─────────────────────────────

  test("transforms response via single onResponse callback", async () => {
    origin.intercept({ path: "/data" }).reply(200);

    reflare.push({
      path: "/data",
      upstream: {
        domain: "test-domain.com",
        onResponse: (res: Response) => {
          res.headers.set("x-custom", "yes");
          return res;
        },
      },
    });

    const response = await reflare.handle(new Request("https://localhost/data"));
    expect(response.headers.get("x-custom")).toBe("yes");
  });

  test("chains multiple onResponse callbacks (sync)", async () => {
    origin.intercept({ path: "/data" }).reply(200);

    reflare.push({
      path: "/data",
      upstream: {
        domain: "test-domain.com",
        onResponse: [
          (res: Response): Response => {
            res.headers.set("x-first", "1");
            return res;
          },
          (res: Response): Response => {
            res.headers.set("x-second", "2");
            return res;
          },
        ],
      },
    });

    const response = await reflare.handle(new Request("https://localhost/data"));
    expect(response.headers.get("x-first")).toBe("1");
    expect(response.headers.get("x-second")).toBe("2");
  });

  test("supports async onResponse callbacks", async () => {
    origin.intercept({ path: "/data" }).reply(200);

    reflare.push({
      path: "/data",
      upstream: {
        domain: "test-domain.com",
        onResponse: async (res: Response) => {
          await new Promise((r) => setTimeout(r, 10));
          res.headers.set("x-async", "done");
          return res;
        },
      },
    });

    const response = await reflare.handle(new Request("https://localhost/data"));
    expect(response.headers.get("x-async")).toBe("done");
  });

  // ── 错误处理 ──────────────────────────────────────────

  test("returns 500 when middleware throws an error", async () => {
    reflare.push({
      path: "/boom",
      upstream: {
        domain: "test-domain.com",
        onRequest: () => {
          throw new Error("something broke");
        },
      },
    });

    const response = await reflare.handle(new Request("https://localhost/boom"));
    expect(response.status).toBe(500);
  });

  // ── 导出工具函数 ──────────────────────────────────────

  test("isUrlMatch checks request against path matchers", () => {
    const req = new Request("https://localhost/api/users");

    expect(isUrlMatch(req, [{ path: "/api/*" }])).toBeTruthy();
    expect(isUrlMatch(req, [{ path: "/other/*" }])).toBeUndefined();
  });

  test("isPathMatch wraps string paths into matchers", () => {
    const req = new Request("https://localhost/api/users");

    expect(isPathMatch(req, ["/api/*"])).toBeTruthy();
    expect(isPathMatch(req, ["/other/*"])).toBeUndefined();
  });

  test("cloneRequest preserves redirect and applies overrides", () => {
    const original = new Request("https://example.com", { redirect: "manual" });

    const cloned = cloneRequest("https://new.com/path", original, { method: "POST" });

    expect(cloned.url).toBe("https://new.com/path");
    expect(cloned.redirect).toBe("manual");
    expect(cloned.method).toBe("POST");
  });
});

