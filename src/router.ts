export type Method = "GET" | "POST" | "PUT" | "DELETE";

export type Handler<Env> = (
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  params: Record<string, string>
) => Promise<Response>;

type RouteRadixTree<Env> = {
  end?: Map<Method, Handler<Env>>;
  more: {
    [k: string]: RouteRadixTree<Env>;
  };
};

function mergeRouteRadixTree<Env>(
  base: RouteRadixTree<Env>,
  incoming: RouteRadixTree<Env>
): void {
  if (incoming.end) {
    if (!base.end) {
      base.end = incoming.end;
    } else {
      for (let [method, handler] of incoming.end.entries()) {
        base.end.set(method, handler);
      }
    }
  }
  for (let [key, routeTree] of Object.entries(incoming.more)) {
    if (!base.more[key]) {
      base.more[key] = routeTree;
    } else {
      mergeRouteRadixTree(base.more[key], routeTree);
    }
  }
}

class Router<Env> {
  private routeTree: RouteRadixTree<Env> = { more: {} };
  private notFoundHandler: Handler<Env>;
  private constructor() {
    this.notFoundHandler = async () => {
      return new Response("404 page not found", {
        status: 404,
        headers: { "Content-Type": "text/plain" },
      });
    };
  }
  static create<Env>(
    setupfn: (
      handle: (method: Method, path: string, handler: Handler<Env>) => void
    ) => void
  ): Router<Env> {
    const r = new Router<Env>();
    setupfn((method, path, handler) => {
      const pathParts = parsePathParts(path);
      let tree: RouteRadixTree<Env> = {
        end: new Map<Method, Handler<Env>>([[method, handler]]),
        more: {},
      };
      const treeRoot = tree; // save original reference to root of tree
      const dynamicIndexes: [string, number][] = [];
      for (let i = pathParts.length - 1; i >= 0; i--) {
        const [paramName, isDynamic] = r.isDynamicPathPart(pathParts[i]);
        if (isDynamic) {
          tree = {
            more: {
              "*": tree,
            },
          };
          dynamicIndexes.push([paramName, i]);
        } else {
          tree = {
            more: {
              [pathParts[i]]: tree,
            },
          };
        }
      }
      const originalHandler = (
        treeRoot.end as Required<RouteRadixTree<Env>>["end"]
      ).get(method) as Handler<Env>;
      (treeRoot.end as Required<RouteRadixTree<Env>>["end"]).set(
        method,
        (request, env, ctx) => {
          const u = new URL(request.url);
          const pathParts = parsePathParts(u.pathname);
          const params: Record<string, string> = {};
          for (let [name, idx] of dynamicIndexes) {
            params[name] = pathParts[idx];
          }
          return originalHandler(request, env, ctx, params);
        }
      );
      r.mergeInTree(tree);
    });
    return r;
  }

  private mergeInTree(incoming: RouteRadixTree<Env>): void {
    mergeRouteRadixTree(this.routeTree, incoming);
  }

  private isDynamicPathPart(s: string): [null, false] | [string, true] {
    const result = /^:(?<param_name>.+)$/i.exec(s);
    if (!result || !result.groups) {
      return [null, false];
    }
    return [result.groups["param_name"], true];
  }

  async handle(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const u = new URL(request.url);
    const pathParts = parsePathParts(u.pathname);

    let currentTree = this.routeTree;
    while (pathParts.length > 0) {
      const currentPart = pathParts.shift();
      if (!currentPart) {
        break;
      }
      if (currentPart in currentTree.more) {
        currentTree = currentTree.more[currentPart];
        continue;
      }
      if ("*" in currentTree.more) {
        currentTree = currentTree.more["*"];
        continue;
      }
      return this.notFoundHandler(request, env, ctx, {});
    }
    if (!currentTree.end) {
      return this.notFoundHandler(request, env, ctx, {});
    }
    const handler = currentTree.end.get(request.method as Method);
    if (!handler) {
      return this.notFoundHandler(request, env, ctx, {});
    }
    return handler(request, env, ctx, {
      /* will be populated */
    });
  }
}

function parsePathParts(path: string): string[] {
  return path.split("/").filter((p) => p.length > 0);
}

export { Router };
