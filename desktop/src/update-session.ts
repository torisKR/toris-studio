import { createDisposalScope, createPanelReadGate } from "./native-lifecycle";

export type UpdatePhase = "idle" | "checking" | "available" | "upToDate" | "downloading" | "ready" | "installing" | "installed" | "cancelled" | "error";
export type UpdateStatus = {
  revision: number;
  configured: boolean;
  currentVersion: string;
  phase: UpdatePhase;
  availableVersion: string | null;
  notes: string | null;
  publishedAt: string | null;
  downloadedBytes: number;
  totalBytes: number | null;
  message: string;
  canCancel: boolean;
};

type Options = {
  subscribe: (receive: (status: UpdateStatus) => void) => Promise<() => void>;
  read: () => Promise<UpdateStatus>;
  onStatus: (status: UpdateStatus) => void;
  onReadError: () => void;
  onReady: () => void;
  onConnected: (connected: boolean) => void;
};

/** One effect owns one subscription. Events and reads share native revision ordering. */
export function createUpdateSession(options: Options) {
  const scope = createDisposalScope();
  const reads = createPanelReadGate();
  reads.activate();
  scope.add(() => reads.deactivate());
  let latestRevision = -1;
  const receive = (status: UpdateStatus) => {
    if (!scope.active() || !Number.isSafeInteger(status.revision) || status.revision < 0 || status.revision <= latestRevision) return;
    latestRevision = status.revision;
    options.onStatus(status);
  };
  const refresh = async () => {
    const request = reads.begin();
    if (!request || !scope.active()) return;
    const before = latestRevision;
    try {
      const status = await options.read();
      if (scope.active() && request.current()) receive(status);
    } catch {
      if (scope.active() && request.current() && before === latestRevision) options.onReadError();
    } finally {
      if (scope.active() && request.current()) options.onReady();
      request.finish();
    }
  };
  // Subscribe before reading so an update between bootstrap operations is retained.
  const ready = options.subscribe(receive).then(unlisten => {
    scope.add(unlisten);
    if (scope.active()) { options.onConnected(true); return refresh(); }
  }).catch(() => {
    if (scope.active()) { options.onConnected(false); return refresh(); }
  });
  return { active: scope.active, receive, refresh, ready, dispose: scope.dispose };
}
