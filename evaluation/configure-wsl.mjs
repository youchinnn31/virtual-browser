import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify, parseArgs } from "node:util";

const execute = promisify(execFile);
const scriptPath = fileURLToPath(new URL("./expose-wsl.ps1", import.meta.url));
const psString = (value) => `'${String(value).replaceAll("'", "''")}'`;

async function powershell(command, timeout = 60000) {
  const source = `$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding; ${command}`;
  const encoded = Buffer.from(source, "utf16le").toString("base64");
  return execute(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
    { encoding: "utf8", timeout, maxBuffer: 1024 * 1024 },
  );
}

export function networkOptions(args = process.argv.slice(2)) {
  const { values } = parseArgs({
    args,
    options: {
      port: { type: "string", default: "3000" },
      interface: { type: "string" },
      listen: { type: "string" },
      connect: { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
  });
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("ポートは1〜65535で指定してください。");
  return {
    port,
    interfaceAlias: values.interface,
    listenAddress: values.listen,
    connectAddress: values.connect,
    dryRun: values["dry-run"],
  };
}

/** Detect the current addresses; only elevate when an owned setting needs changes. */
export async function configureNetwork(options = {}) {
  const port = options.port ?? 3000;
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid port");
  if (!/microsoft/i.test(os.release())) {
    const response = await fetch(`http://127.0.0.1:${port}/evaluation/config`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok || !Array.isArray((await response.json()).urls))
      throw new Error("評価サーバーを先に起動してください。");
    const urls = Object.entries(os.networkInterfaces()).flatMap(
      ([name, entries]) => {
        if (options.interfaceAlias && name !== options.interfaceAlias)
          return [];
        if (/^(lo|docker|veth|br-|tailscale)/i.test(name)) return [];
        return (entries ?? [])
          .filter(
            (entry) =>
              entry.family === "IPv4" &&
              !entry.internal &&
              !entry.address.startsWith("169.254."),
          )
          .map((entry) => `http://${entry.address}:${port}/evaluation`);
      },
    );
    if (!urls.length) throw new Error("LANのIPv4アドレスを取得できません。");
    for (const url of urls) console.log(`Tablet URL: ${url}`);
    return { urls, NeedsChange: false };
  }
  const windowsPath = (
    await execute("wslpath", ["-w", scriptPath])
  ).stdout.trim();
  const parameters = [`-Port ${port}`];
  for (const [key, value] of Object.entries({
    Distribution: process.env.WSL_DISTRO_NAME,
    InterfaceAlias: options.interfaceAlias,
    ListenAddress: options.listenAddress,
    ConnectAddress: options.connectAddress,
  })) {
    if (value) parameters.push(`-${key} ${psString(value)}`);
  }
  // Read the reviewed local script in PowerShell; keep command lines short.
  const invocation = `& ([scriptblock]::Create((Get-Content -Raw -LiteralPath ${psString(windowsPath)}))) ${parameters.join(" ")}`;
  const readPlan = async () => {
    const result = await powershell(`${invocation} -Plan`);
    const plan = JSON.parse(result.stdout.trim().replace(/^\uFEFF/, ""));
    if (
      typeof plan.NeedsChange !== "boolean" ||
      !["add", "set", "keep"].includes(plan.Action) ||
      plan.Port !== port ||
      plan.Url !== `http://${plan.ListenAddress}:${port}/evaluation`
    )
      throw new Error("ネットワーク設定の計画を確認できません。");
    return plan;
  };
  let plan = await readPlan();
  if (options.dryRun) {
    console.log(JSON.stringify(plan, null, 2));
    return plan;
  }
  if (plan.NeedsChange) {
    console.log(
      `LAN設定を更新します: ${plan.ListenAddress}:${port} → ${plan.ConnectAddress}:${port}`,
    );
    console.log(
      "Windowsの管理者承認（UAC）が必要です。このアプリ用の転送・受信許可だけを更新します。",
    );
    const encoded = Buffer.from(
      `$ErrorActionPreference = 'Stop'; ${invocation}`,
      "utf16le",
    ).toString("base64");
    await powershell(
      `$child = Start-Process -FilePath powershell.exe -Verb RunAs -Wait -PassThru -ArgumentList @('-NoProfile', '-NonInteractive', '-EncodedCommand', '${encoded}'); exit $child.ExitCode`,
      120000,
    );
    plan = await readPlan();
    if (plan.NeedsChange)
      throw new Error(
        "LAN設定が完了していません。Windowsの管理者承認と表示エラーを確認してください。",
      );
  }
  await powershell(
    `$response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 -Uri ${psString(plan.Url)}; if ($response.StatusCode -ne 200) { throw 'LAN HTTP check failed' }`,
  );
  console.log(`Tablet URL: ${plan.Url}`);
  console.log(
    "Wi-Fi切り替え後は npm run tablet:network を再実行してください（IP入力は不要です）。",
  );
  return plan;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  configureNetwork(networkOptions()).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
