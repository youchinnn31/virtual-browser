import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { Browser } from "puppeteer";
import WebSocket from "ws";
import { TabletWorker } from "./worker";
import { RunStore, RunConfig } from "./store";
import type { Sample } from "./types";

type Message = Record<string, unknown>;
interface Waiter {
  resolve: (message: Message) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}
interface Session {
  socket: WebSocket;
  token: string;
  reconnecting?: boolean;
  store?: RunStore;
  worker?: TabletWorker;
  stopped?: Error;
  pending: Map<string, Waiter>;
  saved: Set<string>;
}

function object(value: unknown): value is Message {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseConfig(message: Message): RunConfig {
  const urls = message["urls"];
  const speeds = message["speeds"];
  const device = message["device"];
  if (
    !Array.isArray(urls) ||
    urls.length < 1 ||
    urls.length > 100 ||
    !urls.every((value) => {
      if (typeof value !== "string" || value.length > 2048) return false;
      try {
        return ["http:", "https:"].includes(new URL(value).protocol);
      } catch {
        return false;
      }
    })
  )
    throw new Error("HTTP(S)のURLを1〜100件指定してください。");
  if (
    !Array.isArray(speeds) ||
    !speeds.length ||
    speeds.length > 4 ||
    !speeds.every(
      (value) =>
        typeof value === "number" && [128, 200, 300, 1024].includes(value),
    )
  )
    throw new Error("速度を選択してください。");
  if (
    !object(device) ||
    typeof device["name"] !== "string" ||
    device["name"].length > 200 ||
    typeof device["userAgent"] !== "string" ||
    !device["userAgent"] ||
    device["userAgent"].length > 2048 ||
    typeof device["orientation"] !== "string"
  )
    throw new Error("端末情報を取得できません。");
  for (const key of ["width", "height"])
    if (
      typeof device[key] !== "number" ||
      !Number.isInteger(device[key]) ||
      device[key] < 64 ||
      device[key] > 4096
    )
      throw new Error("描画領域は64〜4096 CSS pxで指定してください。");
  if (
    typeof device["dpr"] !== "number" ||
    !Number.isFinite(device["dpr"]) ||
    device["dpr"] <= 0 ||
    device["dpr"] > 8
  )
    throw new Error("DPRが不正です。");
  return {
    urls: [...new Set(urls as string[])],
    speeds: [...new Set(speeds as number[])],
    speedMode: "external-unverified",
    device: {
      name: device["name"],
      userAgent: device["userAgent"],
      orientation: device["orientation"],
      width: device["width"] as number,
      height: device["height"] as number,
      dpr: device["dpr"],
    },
  };
}

export function registerTabletEvaluation(
  app: Express,
  browser: Browser,
  canStart: () => boolean,
) {
  const root = path.resolve(
    process.env["TABLET_RESULTS_DIR"] ?? "evaluation/results",
  );
  let active: Session | undefined;
  const send = (session: Session, action: string, data: object = {}) => {
    if (session.socket.readyState === WebSocket.OPEN)
      session.socket.send(
        JSON.stringify({ action, runId: session.store?.id, ...data }),
      );
  };
  const cancelWaits = (session: Session, error: Error) => {
    for (const waiter of session.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    session.pending.clear();
  };
  const stop = (session: Session, reason: string) => {
    session.stopped ??= new Error(reason);
    cancelWaits(session, session.stopped);
    void session.worker?.abort().catch(() => {});
  };
  const wait = (
    session: Session,
    action: string,
    id: string,
    timeout = 180000,
  ) => {
    const key = `${action}:${id}`;
    const promise = new Promise<Message>((resolve, reject) => {
      const timer = setTimeout(() => {
        session.pending.delete(key);
        reject(new Error(`${action} timed out`));
      }, timeout);
      session.pending.set(key, { resolve, reject, timer });
    });
    void promise.catch(() => {});
    return promise;
  };

  app.get("/evaluation", (_req, res) => {
    res
      .set("Cache-Control", "no-store")
      .sendFile(path.resolve("dist/client/evaluation.html"));
  });
  app.get("/evaluation/config", async (_req, res) => {
    try {
      res.set("Cache-Control", "no-store").json({
        urls: JSON.parse(await fs.readFile("evaluation/urls.json", "utf8")),
        speeds: [128, 200, 300, 1024],
        speedMode: "external-unverified",
      });
    } catch {
      res.status(500).json({ error: "URL一覧を読み込めません。" });
    }
  });
  app.get("/evaluation/results/:id", (req, res) => {
    const id = req.params["id"];
    if (typeof id !== "string" || !/^tablet-\d+-[a-f0-9]{8}$/.test(id)) {
      res.sendStatus(400);
      return;
    }
    res
      .set("Cache-Control", "no-store")
      .download(path.join(root, id, "results.xlsx"), `${id}.xlsx`);
  });

  async function execute(session: Session, config: RunConfig) {
    let state = "complete";
    try {
      session.store = await RunStore.create(root, config);
      const store = session.store;
      send(session, "evaluation:started", {
        id: store.id,
        download: `/evaluation/results/${store.id}`,
      });
      for (const speed of config.speeds) {
        if (session.stopped) throw session.stopped;
        const speedId = randomUUID();
        const confirmed = wait(
          session,
          "evaluation:speed-confirmed",
          speedId,
          600000,
        );
        send(session, "evaluation:speed-required", {
          id: speedId,
          speed,
          verified: false,
        });
        await confirmed;
        await store.log("external-speed-confirmed", { speed, verified: false });
        session.reconnecting = true;
        const reconnected = wait(
          session,
          "evaluation:reconnected",
          store.id,
          15000,
        );
        send(session, "evaluation:reconnect", { token: session.token });
        await reconnected;
        for (const url of config.urls) {
          if (session.stopped) throw session.stopped;
          const condition = await store.condition(url, speed);
          let trialId: string | undefined;
          try {
            session.worker = await TabletWorker.open(
              browser,
              condition.row.database,
              url,
              config.device,
            );
            for (let access = 0; access <= 5; access++) {
              if (session.stopped) throw session.stopped;
              trialId = randomUUID();
              await store.beginTrial(trialId, condition.id, access);
              const started = wait(session, "evaluation:trial-start", trialId);
              send(session, "evaluation:trial-ready", {
                id: trialId,
                conditionId: condition.id,
                url,
                speed,
                access: access + 1,
                phase: access === 0 ? "collect" : "measure",
              });
              await started;
              const reported = wait(
                session,
                "evaluation:trial-result",
                trialId,
              );
              const rendered = await session.worker.render(access, (frame) => {
                if (session.stopped) throw session.stopped;
                send(session, "evaluation:frame", { id: trialId, ...frame });
              });
              send(session, "evaluation:complete", {
                id: trialId,
                frameIds: rendered.frames.map((frame) => frame.frameId),
              });
              const report = await reported;
              if (session.stopped) throw session.stopped;
              const lcp = report["lcp"];
              const first = rendered.frames.find(
                (frame) => frame.frameId === report["firstFrameId"],
              );
              const drawn = report["renderedFrameIds"];
              if (
                typeof lcp !== "number" ||
                !Number.isFinite(lcp) ||
                lcp <= 0 ||
                lcp > 180000 ||
                !first ||
                !Array.isArray(drawn) ||
                drawn.length !== rendered.frames.length ||
                new Set(drawn).size !== drawn.length ||
                !rendered.frames.every((frame) => drawn.includes(frame.frameId))
              )
                throw new Error("描画結果の画像ID・計測値が不正です。");
              const sample: Sample = {
                trial: access,
                access: access + 1,
                lcp,
                firstXpath: first.xpath ?? "",
                renderKind: first.kind,
                finalUrl: rendered.finalUrl,
                lcpImages: rendered.frames.filter(
                  (frame) => frame.kind === "lcp",
                ).length,
                candidates: rendered.candidates,
              };
              if (access === 0) await session.worker.saveInitial(lcp);
              await store.sample(
                trialId,
                condition.id,
                access,
                sample,
                rendered.collected,
              );
              session.saved.add(trialId);
              send(session, "evaluation:trial-saved", {
                id: trialId,
                lcp,
                renderKind: first.kind,
              });
              trialId = undefined;
            }
            await store.finishCondition(condition.id, "ok");
          } catch (error) {
            state = "partial";
            const reason = String(error);
            cancelWaits(session, new Error(reason));
            if (trialId) await store.failTrial(trialId, reason);
            await store.finishCondition(condition.id, reason);
            send(session, "evaluation:condition-error", {
              id: trialId,
              url,
              speed,
              error: reason,
            });
            if (session.stopped) throw session.stopped;
          } finally {
            await session.worker?.close();
            delete session.worker;
            await store.export("running");
          }
        }
      }
    } catch (error) {
      state = session.stopped ? "stopped" : "failed";
      send(session, "evaluation:error", { error: String(error) });
    } finally {
      cancelWaits(session, new Error("Evaluation finished"));
      try {
        if (session.store) {
          await session.store.export(state);
          await session.store.close();
          if (active === session) active = undefined;
          send(session, "evaluation:finished", {
            status: state,
            download: `/evaluation/results/${session.store.id}`,
          });
        }
      } catch (error) {
        send(session, "evaluation:error", {
          error: `保存に失敗しました: ${String(error)}`,
        });
      }
      if (active === session) active = undefined;
    }
  }

  return {
    isBusy: () => !!active,
    stop: () => {
      if (active) stop(active, "Server stopping");
    },
    connect(socket: WebSocket, token: string | null = null) {
      if (active && token === active.token && active.reconnecting) {
        const session = active;
        const previous = session.socket;
        session.socket = socket;
        session.reconnecting = false;
        previous.close();
        const key = `evaluation:reconnected:${session.store!.id}`;
        const waiter = session.pending.get(key);
        if (waiter) {
          clearTimeout(waiter.timer);
          session.pending.delete(key);
          waiter.resolve({});
        }
      } else if (active || token) {
        socket.send(
          JSON.stringify({
            action: "evaluation:error",
            error: "別の評価を実行中です。",
          }),
        );
        socket.close(1013);
        return;
      }
      socket.send(JSON.stringify({ action: "evaluation:hello" }));
      socket.on("message", (raw) => {
        try {
          if (raw.toString().length > 300000)
            throw new Error("要求が大きすぎます。");
          const message: unknown = JSON.parse(raw.toString());
          if (!object(message)) throw new Error("要求形式が不正です。");
          const action = message["action"];
          if (action === "evaluation:start") {
            if (active || !canStart())
              throw new Error("仮想ブラウザを使用中です。");
            const config = parseConfig(message);
            const session: Session = {
              socket,
              token: randomUUID(),
              pending: new Map(),
              saved: new Set(),
            };
            active = session;
            void execute(session, config);
            return;
          }
          const session = active;
          if (
            !session ||
            session.socket !== socket ||
            message["runId"] !== session.store?.id
          )
            return;
          if (action === "evaluation:stop") {
            stop(
              session,
              typeof message["reason"] === "string"
                ? message["reason"]
                : "端末から停止",
            );
            return;
          }
          const id = message["id"];
          if (typeof id !== "string") return;
          if (action === "evaluation:trial-result" && session.saved.has(id)) {
            send(session, "evaluation:trial-saved", { id });
            return;
          }
          const key = `${String(action)}:${id}`;
          const waiter = session.pending.get(key);
          if (waiter) {
            clearTimeout(waiter.timer);
            session.pending.delete(key);
            waiter.resolve(message);
          }
        } catch (error) {
          socket.send(
            JSON.stringify({
              action: "evaluation:error",
              error: String(error),
            }),
          );
        }
      });
      socket.on("close", () => {
        if (active?.socket === socket && !active.reconnecting)
          stop(active, "端末との接続が切断されました。");
      });
    },
  };
}
