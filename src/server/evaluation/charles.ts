import http from "node:http";
import fs from "node:fs";

interface Command {
  method: "GET" | "POST";
  path: string;
  body?: string;
}
interface CharlesConfig {
  proxyHost: string;
  proxyPort: number;
  status: Command;
  enabledPattern: string;
  disabledPattern: string;
  disable: Command;
  presets: Record<string, { select: Command; selectedPattern: string }>;
  tolerance?: number;
  timeoutMs?: number;
}
export interface CharlesState {
  enabled: boolean;
  speed: number;
}

/** URLs and status patterns come from the installed Charles Web Interface. */
export class CharlesController {
  readonly tolerance: number;
  private readonly timeout: number;

  constructor(
    private config: CharlesConfig,
    private authorization = "",
  ) {
    this.timeout = config.timeoutMs ?? 10000;
    this.tolerance = config.tolerance ?? 0.2;
    if (
      !config.proxyHost ||
      !Number.isInteger(config.proxyPort) ||
      config.proxyPort < 1 ||
      config.proxyPort > 65535 ||
      this.timeout < 100 ||
      this.timeout > 60000 ||
      !(this.tolerance > 0 && this.tolerance < 1)
    )
      throw new Error(
        "Charles設定のホスト・ポート・許容誤差・タイムアウトが不正です。",
      );
    this.validateCommand(config.status);
    this.validateCommand(config.disable);
    new RegExp(config.enabledPattern);
    new RegExp(config.disabledPattern);
    for (const speed of [128, 200, 300, 1024]) {
      const preset = config.presets[String(speed)];
      if (!preset?.selectedPattern)
        throw new Error(`Charlesの${speed}kbpsプリセット設定がありません。`);
      this.validateCommand(preset.select);
      new RegExp(preset.selectedPattern);
    }
  }

  static fromEnvironment() {
    const filename = process.env["CHARLES_CONFIG"];
    if (!filename) return null;
    const config = JSON.parse(
      fs.readFileSync(filename, "utf8"),
    ) as CharlesConfig;
    // Optional Basic user:password stays outside run metadata and the browser.
    const credentials = process.env["CHARLES_CREDENTIALS"];
    return new CharlesController(
      config,
      credentials ? `Basic ${Buffer.from(credentials).toString("base64")}` : "",
    );
  }

  private validateCommand(command: Command) {
    if (
      !command ||
      !["GET", "POST"].includes(command.method) ||
      typeof command.path !== "string" ||
      !command.path.startsWith("/") ||
      /[\r\n<>]/.test(command.path)
    )
      throw new Error(
        "CharlesのWeb Interfaceで確認した制御パスを指定してください。",
      );
  }

  private request(command: Command) {
    return new Promise<string>((resolve, reject) => {
      const headers: Record<string, string> = { Host: "control.charles" };
      if (this.authorization) headers["Authorization"] = this.authorization;
      if (command.body) {
        headers["Content-Type"] = "application/x-www-form-urlencoded";
        headers["Content-Length"] = String(Buffer.byteLength(command.body));
      }
      const request = http.request(
        {
          hostname: this.config.proxyHost,
          port: this.config.proxyPort,
          method: command.method,
          path: `http://control.charles${command.path}`,
          headers,
        },
        (response) => {
          const chunks: Buffer[] = [];
          let bytes = 0;
          response.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > 1024 * 1024) {
              request.destroy(new Error("Charles応答が大きすぎます。"));
              return;
            }
            chunks.push(chunk);
          });
          response.on("error", reject);
          response.on("end", () => {
            if (
              !response.statusCode ||
              response.statusCode < 200 ||
              response.statusCode >= 300
            )
              reject(
                new Error(`Charles制御のHTTPエラー: ${response.statusCode}`),
              );
            else resolve(Buffer.concat(chunks).toString("utf8"));
          });
        },
      );
      request.setTimeout(this.timeout, () =>
        request.destroy(new Error("Charles制御がタイムアウトしました。")),
      );
      request.on("error", reject);
      request.end(command.body);
    });
  }

  async status(): Promise<CharlesState> {
    const text = await this.request(this.config.status);
    const enabled = new RegExp(this.config.enabledPattern).test(text);
    const disabled = new RegExp(this.config.disabledPattern).test(text);
    const selected = Object.entries(this.config.presets).filter(([, preset]) =>
      new RegExp(preset.selectedPattern).test(text),
    );
    if (enabled === disabled || selected.length !== 1)
      throw new Error(
        "Charlesの有効状態・選択プリセットを一意に確認できません。設定パターンを確認してください。",
      );
    return { enabled, speed: Number(selected[0]![0]) };
  }

  async select(speed: number) {
    const preset = this.config.presets[String(speed)];
    if (!preset) throw new Error("Charlesの速度設定がありません。");
    await this.request(preset.select);
    const state = await this.status();
    if (!state.enabled || state.speed !== speed)
      throw new Error("Charlesの速度切り替えを確認できませんでした。");
    return state;
  }

  async restore(previous: CharlesState) {
    await this.select(previous.speed);
    if (!previous.enabled) await this.request(this.config.disable);
    const actual = await this.status();
    if (actual.enabled !== previous.enabled || actual.speed !== previous.speed)
      throw new Error("Charlesの元の設定への復元を確認できませんでした。");
    return actual;
  }
}
