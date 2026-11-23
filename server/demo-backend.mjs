export const DEMO_CAPABILITIES = Object.freeze({
  mode: 'demo',
  liveState: false,
  outbox: true,
  simulate: true,
  pause: true,
  injectEvent: true,
  sourceWrite: true,
  workerWrite: true,
  configWrite: true,
  ticketAnswer: true,
  ticketRetry: true,
  ticketCancel: true,
  ticketApprove: true,
  tick: true,
  projectSelect: false,
  authRotate: true,
});

export class DemoBackend {
  constructor({ store, engine }) {
    this.store = store;
    this.engine = engine;
  }

  get mode() {
    return 'demo';
  }

  get capabilities() {
    return DEMO_CAPABILITIES;
  }

  projects() {
    return { currentId: 'prj_demo', items: [] };
  }

  selectProject() {
    const error = new Error('demo 模式只有一个模拟项目');
    error.statusCode = 409;
    throw error;
  }

  snapshot() {
    const snapshot = this.store.snapshot();
    snapshot.capabilities = this.capabilities;
    snapshot.projects = this.projects();
    snapshot.health = snapshot.health || {
      status: snapshot.meta.paused ? 'paused' : 'live',
      lastTickAt: snapshot.meta.lastTickAt,
      tickCount: snapshot.meta.tickCount,
    };
    return snapshot;
  }

  overview() {
    const overview = this.engine.overview();
    overview.capabilities = this.capabilities;
    overview.projects = this.projects();
    return overview;
  }

  ticketDetail(id) {
    return this.engine.ticketDetail(id);
  }

  tick() {
    return this.engine.tick();
  }

  updateConfig(patch) {
    return this.engine.updateConfig(patch);
  }

  addSource(input) {
    return this.engine.addSource(input);
  }

  updateSource(id, patch) {
    return this.engine.updateSource(id, patch);
  }

  toggleSource(id) {
    return this.engine.toggleSource(id);
  }

  ingestEvent(input) {
    return this.engine.ingestEvent(input);
  }

  answerTicket(id, answer, actor) {
    return this.engine.answerTicket(id, answer, actor);
  }

  retryTicket(id, actor) {
    return this.engine.retryTicket(id, actor);
  }

  cancelTicket(id, actor) {
    return this.engine.cancelTicket(id, actor);
  }

  approveTicket(id, actor) {
    return this.engine.approveTicket(id, actor);
  }

  replayDelivery(id, actor) {
    return this.engine.replayDelivery(id, actor);
  }

  toggleWorker(id) {
    return this.engine.toggleWorker(id);
  }

  unsupported(action) {
    const error = new Error(`${action} 在 demo 模式下不可用`);
    error.statusCode = 409;
    throw error;
  }
}
