// Coalesce store/avatar arrivals, including store results of user actions.
// Direct input-handler notifications bypass this gate. Each task uses its own
// context; no callback context is retained for later use.
export class RedrawGate {
  constructor(delay = 32) { this.delay = delay; this.pending = false; }
  request(cx) {
    if (this.pending) return;
    this.pending = true;
    cx.spawn(async (task) => {
      try { await task.sleep(this.delay); this.pending = false; task.notify(); }
      finally { this.pending = false; }
    });
  }
}
