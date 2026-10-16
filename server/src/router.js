'use strict';
// Method + path pattern -> handler. A pattern looks like /api/pair/:id. Path parameters are
// decoded and checked against a strict pattern before a handler sees them. HEAD is answered by
// the GET handler (Node leaves out the body by itself).

const { HttpError } = require('./http-util');

class Router {
  constructor() {
    this.routes = [];
  }

  // opts.params: { name: RegExp } that every decoded parameter must match. A parameter that
  // does not decode or match answers 404 with opts.notFound, as if the thing did not exist.
  add(method, pattern, handler, opts = {}) {
    const names = [];
    const source = pattern
      .split('/')
      .map((seg) => {
        if (!seg.startsWith(':')) return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        names.push(seg.slice(1));
        return '([^/]+)';
      })
      .join('/');
    this.routes.push({
      method,
      pattern,
      re: new RegExp(`^${source}$`),
      names,
      handler,
      params: opts.params || {},
      notFound: opts.notFound || 'Not found.',
    });
  }

  // The route for this request and its checked parameters. Throws a 404 when no route has this
  // path, and a 405 with Allow when routes have it for other methods.
  find(method, path) {
    const allow = [];
    for (const route of this.routes) {
      const m = route.re.exec(path);
      if (!m) continue;
      if (route.method === method || (method === 'HEAD' && route.method === 'GET')) {
        return { route, params: decodeParams(route, m.slice(1)) };
      }
      allow.push(route.method);
      if (route.method === 'GET') allow.push('HEAD');
    }
    if (allow.length) throw new HttpError(405, 'This method is not allowed here.', { Allow: [...new Set(allow)].join(', ') });
    throw new HttpError(404, 'Not found.');
  }
}

function decodeParams(route, values) {
  const params = {};
  route.names.forEach((name, i) => {
    let v;
    try {
      v = decodeURIComponent(values[i]);
    } catch (e) {
      throw new HttpError(404, route.notFound);
    }
    const re = route.params[name];
    if (re && !re.test(v)) throw new HttpError(404, route.notFound);
    params[name] = v;
  });
  return params;
}

module.exports = { Router };
