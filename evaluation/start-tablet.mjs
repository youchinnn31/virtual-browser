import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { configureNetwork, networkOptions } from "./configure-wsl.mjs";

function existingServer() {
  return new Promise((resolve, reject) => {
    const request = http.get(
      "http://127.0.0.1:3000/evaluation/config",
      (response) => {
        let body = "";
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          try {
            const config = JSON.parse(body);
            if (
              response.statusCode !== 200 ||
              !Array.isArray(config.urls) ||
              !config.speedMode
            )
              throw new Error();
            resolve(true);
          } catch {
            reject(new Error("ポート3000を別のサービスが使用しています。"));
          }
        });
      },
    );
    request.setTimeout(3000, () =>
      request.destroy(new Error("ポート3000の応答を確認できません。")),
    );
    request.on("error", (error) => {
      if (error.code === "ECONNREFUSED") resolve(false);
      else reject(error);
    });
  });
}

async function main() {
  const options = networkOptions();
  if (options.port !== 3000)
    throw new Error("この評価サーバーの起動ポートは3000です。");
  if (await existingServer()) {
    console.log(
      "既存の評価サーバーを使用します。ソース・環境変数を変更した場合は再起動してください。",
    );
    await configureNetwork(options);
    return;
  }
  const child = spawn(process.execPath, ["dist/server/index.js"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.pipe(process.stderr);
  let stopping = false;
  const stop = () => {
    if (!stopping && child.exitCode === null && child.signalCode === null) {
      stopping = true;
      child.kill("SIGTERM");
    }
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const exited = once(child, "exit");
  void exited.catch(() => {});
  try {
    await new Promise((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => {
        reject(new Error("評価サーバーの起動がタイムアウトしました。"));
      }, 60000);
      const fail = (error) => {
        clearTimeout(timer);
        reject(error);
      };
      child.once("error", fail);
      child.once("exit", (code) =>
        fail(new Error(`評価サーバーが起動前に終了しました (${code})。`)),
      );
      child.stdout.on("data", (chunk) => {
        process.stdout.write(chunk);
        output = (output + chunk).slice(-2000);
        if (output.includes("App listening on port 3000")) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    await configureNetwork(options);
    if (options.dryRun) stop();
    const [code] = await exited;
    if (code) process.exitCode = code;
  } catch (error) {
    stop();
    if (child.exitCode === null && child.signalCode === null) await exited;
    throw error;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
