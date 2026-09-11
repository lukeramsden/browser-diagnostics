import { LIMITS } from '../protocol/limits';
import { PROTOCOL_VERSION, ProtocolError, newId, parseMessage, responseSchema, uiPushSchema, type Response, type Result, type UiCommandInput, type UiPush, type Warning } from '../protocol';

/**
 * UI-side client for the background router. Sends short request/response
 * messages so the service worker can sleep between calls.
 */
export class Client {
  private generation = 0;
  private pushListeners = new Set<(p: UiPush) => void>();

  constructor(readonly sessionId: string) {
    chrome.runtime.onMessage.addListener((raw: unknown) => {
      let push: UiPush;
      try {
        push = parseMessage(uiPushSchema, raw);
      } catch {
        return false;
      }
      if (push.sessionId !== this.sessionId) return false;
      for (const l of this.pushListeners) l(push);
      return false;
    });
  }

  onPush(fn: (p: UiPush) => void): () => void {
    this.pushListeners.add(fn);
    return () => this.pushListeners.delete(fn);
  }

  async send(payload: UiCommandInput): Promise<{ result: Result; warnings: Warning[] }> {
    const req = { v: PROTOCOL_VERSION, kind: 'uiRequest', requestId: newId(), sessionId: this.sessionId, generation: this.generation, payload };
    let raw: unknown;
    try {
      raw = await chrome.runtime.sendMessage(req);
    } catch (err) {
      throw new ProtocolError('agentUnavailable', `background worker unreachable: ${(err as Error)?.message ?? 'unknown'}`);
    }
    if (raw === undefined) throw new ProtocolError('agentUnavailable', 'background worker did not reply');
    // Reports can be larger than ordinary messages; the background is trusted.
    const res: Response = parseMessage(responseSchema, raw, LIMITS.exportMaxBytes + 64 * 1024);
    this.generation = res.generation;
    if (!res.ok || !res.result) {
      const e = res.error ?? { code: 'internal' as const, message: 'unknown error' };
      throw new ProtocolError(e.code, e.message, e.details);
    }
    return { result: res.result, warnings: res.warnings };
  }
}
