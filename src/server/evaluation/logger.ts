import fs from "node:fs";
import path from "node:path";

export type ProgressLogger = (
  event: string,
  details: Record<string, unknown>,
) => void;

/** Human-readable stdout and ordered JSON Lines; never include image bodies/tokens. */
export function createEvaluationLogger(root: string) {
  const directory = path.join(root, "logs");
  fs.mkdirSync(directory, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(
    directory,
    `tablet-server-${stamp}-${process.pid}.jsonl`,
  );
  const output = fs.createWriteStream(file, { flags: "a" });
  let failed = false;
  let closed = false;
  output.on("error", (error) => {
    failed = true;
    console.error(
      `[tablet] ログファイルへの書き込みに失敗しました: ${error.message}`,
    );
  });
  const log: ProgressLogger = (event, details) => {
    const safe = Object.fromEntries(
      Object.entries(details).filter(
        ([key]) =>
          !["token", "img", "credentials", "authorization"].includes(
            key.toLowerCase(),
          ),
      ),
    );
    const record = { ...safe, at: new Date().toISOString(), event };
    const text = JSON.stringify(record);
    console.log(`[tablet] ${text}`);
    if (!closed && !failed && !output.destroyed) output.write(`${text}\n`);
  };
  return {
    file,
    log,
    close: async () => {
      if (closed) return;
      closed = true;
      if (failed || output.destroyed) return;
      await new Promise<void>((resolve) => {
        output.once("error", () => resolve());
        output.end(() => resolve());
      });
    },
  };
}
