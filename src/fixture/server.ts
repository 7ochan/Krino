import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const loginPage = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Krino Fixture Sign in</title></head>
<body>
  <main>
    <h1>Sign in</h1>
    <form method="post" action="/login">
      <label>Email <input name="email" type="email" autocomplete="username" required></label>
      <label>Password <input name="password" type="password" autocomplete="current-password" required></label>
      <button type="submit">Sign in</button>
    </form>
    <p role="alert">{{ERROR}}</p>
  </main>
</body>
</html>`;

const dashboardPage = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Krino Fixture Dashboard</title></head>
<body>
  <main>
    <h1>Dashboard</h1>
    <p>Welcome, qa@example.test</p>
  </main>
</body>
</html>`;

function sendHtml(response: import("node:http").ServerResponse, status: number, html: string): void {
  response.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  response.end(html);
}

export interface FixtureServer {
  url: string;
  close(): Promise<void>;
}

export async function startFixtureServer(port = 0): Promise<FixtureServer> {
  const server: Server = createServer(async (request, response) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (request.method === "GET" && (pathname === "/" || pathname === "/login")) {
      sendHtml(response, 200, loginPage.replace("{{ERROR}}", ""));
      return;
    }
    if (request.method === "GET" && pathname === "/inspect") {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const autoSelect = url.searchParams.get("select");
      const autoScript = autoSelect ? `<script>setTimeout(() => document.getElementById(${JSON.stringify(autoSelect)})?.click(), 400)</script>` : "";
      sendHtml(response, 200, `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Inspector fixture</title></head><body><form action="/submitted" method="get"><label>Email <input id="email" name="email" type="email" placeholder="Enter email" data-testid="email"></label><button id="save" type="submit">Save changes</button></form>${autoScript}</body></html>`);
      return;
    }
    if (request.method === "GET" && pathname === "/submitted") { sendHtml(response, 200, "<!doctype html><title>Submitted</title><h1>Submitted</h1>"); return; }
    if (request.method === "POST" && pathname === "/login") {
      let body = "";
      for await (const chunk of request) body += chunk.toString();
      const values = new URLSearchParams(body);
      if (values.get("email") === "qa@example.test" && values.get("password") === "correct-horse") {
        sendHtml(response, 200, dashboardPage);
      } else {
        sendHtml(response, 401, loginPage.replace("{{ERROR}}", "Invalid email or password"));
      }
      return;
    }
    sendHtml(response, 404, "<!doctype html><title>Not found</title><h1>Not found</h1>");
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture server did not bind to a TCP port");

  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose())),
  };
}

async function main(): Promise<void> {
  const rawPort = process.env.PORT ?? "4173";
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error(`Invalid PORT: ${rawPort}`);
  const fixture = await startFixtureServer(port);
  process.stdout.write(`Fixture listening at ${fixture.url}\n`);
  const close = () => void fixture.close().finally(() => process.exit(0));
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
