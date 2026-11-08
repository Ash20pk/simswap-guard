// Bridges node:http to (Request) -> Response handlers, so the same handlers
// run locally and as Vercel functions.

export function serve(handler) {
  return async (req, res) => {
    let response;
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks);
      const request = new Request(`http://${req.headers.host ?? 'localhost'}${req.url}`, {
        method: req.method,
        headers: req.headers,
        body,
      });
      response = await handler(request);
    } catch (err) {
      console.error(err);
      response = Response.json({ error: 'Internal error' }, { status: 500 });
    }
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  };
}
