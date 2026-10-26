import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";

test("Charles adapter goes through the proxy, verifies selection, and restores disabled state", async () => {
  await build({
    entryPoints: ["src/server/evaluation/charles.ts"],
    outfile: "dist/test/charles.cjs",
    bundle: true,
    platform: "node",
    packages: "external",
  });
  const { CharlesController } = createRequire(import.meta.url)(
    "../dist/test/charles.cjs",
  );
  let state = { enabled: false, speed: 200 };
  const paths = [];
  const server = http.createServer((req, res) => {
    paths.push(req.url);
    const url = new URL(req.url);
    if (url.pathname === "/select")
      state = { enabled: true, speed: Number(url.searchParams.get("speed")) };
    if (url.pathname === "/disable") state.enabled = false;
    res.end(`enabled=${state.enabled};selected=${state.speed};`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const config = {
      proxyHost: "127.0.0.1",
      proxyPort: server.address().port,
      status: { method: "GET", path: "/status" },
      enabledPattern: "enabled=true;",
      disabledPattern: "enabled=false;",
      disable: { method: "POST", path: "/disable" },
      presets: Object.fromEntries(
        [128, 200, 300, 1024].map((speed) => [
          speed,
          {
            select: { method: "POST", path: `/select?speed=${speed}` },
            selectedPattern: `selected=${speed};`,
          },
        ]),
      ),
    };
    const controller = new CharlesController(config);
    const before = await controller.status();
    await controller.select(1024);
    assert.deepEqual(state, { enabled: true, speed: 1024 });
    await controller.restore(before);
    assert.deepEqual(state, { enabled: false, speed: 200 });
    assert.ok(
      paths.every((value) => value.startsWith("http://control.charles/")),
    );
    const broken = new CharlesController({
      ...config,
      enabledPattern: "enabled=",
      disabledPattern: "enabled=",
    });
    await assert.rejects(broken.status(), /一意/);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
