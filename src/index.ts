export type OnResponseCallback = (k: Response, url: string) => Response | Promise<Response>;
export type OnRequestCallback = (k: Request, url: string) => Request | Promise<Request>;

export interface UpstreamOptions {
  domain: string;
  protocol?: "http" | "https";
  port?: number;
  stripPrefix?: boolean;
  onResponse?: OnResponseCallback | OnResponseCallback[];
  onRequest?: OnRequestCallback | OnRequestCallback[];
}

export interface PathMatcher {
  path: string | string[];
  methods?: string[];
}

export interface Route extends PathMatcher {
  upstream: UpstreamOptions;
}

export interface Context {
  route: Route;
  request: Request;
  response: Response;
  upstream: UpstreamOptions | null;
  pattern: string;
}

export interface Reflare {
  handle: (request: Request) => Promise<Response>;
  unshift: (route: Route) => void;
  push: (route: Route) => void;
}

export type Middleware = (context: Context, next: () => Promise<void>) => Promise<void> | void;

export interface Pipeline {
  push: (...middlewares: Middleware[]) => void;
  execute: (context: Context) => Promise<void>;
}

interface RouteMatch<P extends PathMatcher> {
  route: P;
  pattern: string;
}

const patternCache = new Map<string, URLPattern>();

function getPattern(path: string): URLPattern {
  if (!patternCache.has(path)) {
    patternCache.set(path, new URLPattern({ pathname: path }));
  }
  return patternCache.get(path)!;
}

function matchRoute<P extends PathMatcher>(request: Request, matchers: P[]): RouteMatch<P> | void {
  const url = new URL(request.url);

  for (const route of matchers) {
    if (route.methods === undefined || route.methods.includes(request.method)) {
      for (const path of convertToArray<string>(route.path)) {
        if (getPattern(path).test(url)) {
          return { route, pattern: path };
        }
      }
    }
  }

  return undefined;
}

export function isUrlMatch<P extends PathMatcher>(request: Request, matchers: P[]): P | void {
  const match = matchRoute(request, matchers);
  return match?.route;
}

export default async function useReflare(): Promise<Reflare> {
  const pipeline = usePipeline(useUpstream);

  const routeList: Route[] = [];

  async function handle(request: Request): Promise<Response> {
    const match = matchRoute(request, routeList);

    if (match === undefined) {
      return createResponse("Route not found!", 404);
    }

    const context: Context = {
      request,
      route: match.route,
      response: new Response("Unhandled response"),
      upstream: match.route.upstream,
      pattern: match.pattern,
    };

    try {
      await pipeline.execute(context);
    } catch (error) {
      if (error instanceof Error) {
        context.response = createResponse(error.message, 500);
      }
    }

    return context.response;
  }

  const unshift = (route: Route) => routeList.unshift(route);
  const push = (route: Route) => routeList.push(route);

  return { handle, unshift, push };
}

function usePipeline(...initMiddlewares: Middleware[]): Pipeline {
  const stack: Middleware[] = [...initMiddlewares];

  const push: Pipeline["push"] = (...middlewares: Middleware[]) => {
    stack.push(...middlewares);
  };

  const execute: Pipeline["execute"] = async (context) => {
    const runner = async (prevIndex: number, index: number): Promise<void> => {
      if (index === prevIndex) throw new Error("next() called multiple times");
      if (index >= stack.length) return;

      const middleware = stack[index];
      const next = async () => runner(index, index + 1);
      await middleware(context, next);
    };

    await runner(-1, 0);
  };

  return { push, execute };
}

const createResponse = (body: string, status: number): Response => new Response(body, { status });

export function isPathMatch(request: Request, paths: string[]): ReturnType<typeof isUrlMatch> {
  const pathMatchers = paths.map((path) => ({ path }));
  return isUrlMatch(request, pathMatchers);
}

export function cloneRequest(
  // string for outgoing request
  url: string,
  // outgoing request object, an extension of the original Cloudflare request object
  request: Request,
  // properties we want override on the original request object
  overrides?: RequestInit,
): Request {
  if (!request.redirect) {
    console.error(
      'Request#redirect property not passed into cloneRequest()!, it will be reset to {redirect:"follow"} which may break 30x redirects downstream!',
    );
  }

  const requestInit: RequestInit = {
    // Ensure outgoing.redirect is copied over, otherwise it'll default
    // to redirect: "follow", which breaks 30x redirect's downstream
    // Workers by redirect: "manual", this keep's that (desired) behavior
    redirect: request.redirect,
    body: request.body,
    method: request.method,
    headers: request.headers,
    cf: (request as any).cf,
    ...overrides,
  };

  return new Request(url, requestInit);
}

function getURL(url: string, upstream: UpstreamOptions, matchedPattern?: string): string {
  const cloneURL = new URL(url);
  const { domain, port, protocol } = upstream;

  cloneURL.hostname = domain;

  if (protocol !== undefined) cloneURL.protocol = `${protocol}:`;

  cloneURL.port = port === undefined ? "" : port.toString();

  if (upstream.stripPrefix && matchedPattern) {
    const starIndex = matchedPattern.indexOf("*");
    if (starIndex !== -1) {
      const prefix = matchedPattern.slice(0, starIndex);
      if (cloneURL.pathname.startsWith(prefix)) {
        const remaining = cloneURL.pathname.slice(prefix.length);
        cloneURL.pathname = remaining ? "/" + remaining.split("/").filter(Boolean).join("/") : "/";
      }
    }
  }

  return cloneURL.href;
}

const useUpstream: Middleware = async (context: Context, next: () => Promise<void>) => {
  const { request, upstream } = context;

  if (upstream === null) {
    await next();
    return;
  }

  const onRequest = upstream.onRequest ? convertToArray<OnRequestCallback>(upstream.onRequest) : null;

  const onResponse = upstream.onResponse ? convertToArray<OnResponseCallback>(upstream.onResponse) : null;

  const url = getURL(request.url, upstream, context.pattern);

  let upstreamRequest = cloneRequest(url, request);

  if (onRequest) {
    upstreamRequest = await processChain(upstreamRequest, onRequest, url, (req) => cloneRequest(req.url, req));
  }

  context.response = await fetch(upstreamRequest);

  if (onResponse) {
    context.response = await processChain(
      new Response(context.response.body, context.response),
      onResponse,
      url,
      (res) => new Response(res.body, res),
    );
  }

  await next();
};

async function processChain<T>(
  initial: T,
  fns: Array<(item: T, url: string) => T | Promise<T>>,
  url: string,
  clone: (item: T) => T,
): Promise<T> {
  let result: T = initial;
  for (const fn of fns) {
    result = await fn(clone(result), url);
  }
  return result;
}

const convertToArray = <T>(maybeArray: T | T[]): T[] => (Array.isArray(maybeArray) ? maybeArray : [maybeArray]);
