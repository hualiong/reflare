import useReflare from "../src";

const fetchMock = getMiniflareFetchMock();

fetchMock.disableNetConnect();

const origin = fetchMock.get("https://test-domain.com");

describe("upstream", () => {
  let reflare: Awaited<ReturnType<typeof useReflare>>;

  beforeEach(async () => {
    reflare = await useReflare();
  });

  test("basic", async () => {
    origin.intercept({ path: "/get" }).reply(200);

    reflare.push({
      path: "/*",
      upstream: { domain: "test-domain.com" },
    });

    const response = await reflare.handle(new Request("https://localhost/get"));

    expect(response.status).toBe(200);
    expect(response.url).toBe("https://test-domain.com/get");
  });

  test("path array", async () => {
    origin.intercept({ path: "/status/200" }).reply(200);

    reflare.push({
      path: ["/wont/match", "/also/wont/match", "/status*"],
      upstream: { domain: "test-domain.com" },
    });

    const response = await reflare.handle(new Request("https://localhost/status/200"));

    expect(response.status).toBe(200);
    expect(response.url).toBe("https://test-domain.com/status/200");
  });

  test("onRequest", async () => {
    origin.intercept({ path: "/get" }).reply(200);

    reflare.push({
      path: "/foo*",
      upstream: {
        domain: "test-domain.com",
        onRequest: (_req: Request, url: string) => {
          return new Request(url.replace("foo/bar/baz", "get"));
        },
      },
    });

    const response = await reflare.handle(new Request("https://localhost/foo/bar/baz"));

    expect(response.status).toBe(200);
    expect(response.url).toBe("https://test-domain.com/get");
  });

  test("onResponse (sync)", async () => {
    origin.intercept({ path: "/foo/bar/baz" }).reply(200);

    reflare.push({
      path: "/foo*",
      upstream: {
        domain: "test-domain.com",
        onResponse: [
          (res: Response): Response => {
            res.headers.set("x-foo", (1 + 1).toString());
            return res;
          },
          (res: Response): Response => {
            res.headers.set("x-bar", "foo");
            return res;
          },
        ],
      },
    });

    const response = await reflare.handle(new Request("https://localhost/foo/bar/baz"));

    expect(response.headers.get("x-foo")).toEqual("2");
    expect(response.headers.get("x-bar")).toEqual("foo");
  });

  test("onResponse (async)", async () => {
    origin.intercept({ path: "/foo/bar/baz" }).reply(200);

    reflare.push({
      path: "/foo*",
      upstream: {
        domain: "test-domain.com",
        onResponse: [
          async (res: Response): Promise<Response> => {
            // Simulate async work like reading body or doing KV lookup
            await new Promise((resolve) => setTimeout(resolve, 10));
            res.headers.set("x-async-1", "yes");
            return res;
          },
          async (res: Response): Promise<Response> => {
            res.headers.set("x-async-2", "yes");
            return res;
          },
        ],
      },
    });

    const response = await reflare.handle(new Request("https://localhost/foo/bar/baz"));

    expect(response.headers.get("x-async-1")).toEqual("yes");
    expect(response.headers.get("x-async-2")).toEqual("yes");
  });
});
