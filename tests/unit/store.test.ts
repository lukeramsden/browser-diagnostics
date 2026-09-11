import { describe, expect, it } from 'vitest';
import { MemoryStorageArea, SessionStore, newSessionRecord } from '../../src/session/store';

describe('SessionStore', () => {
  it('serialises concurrent updates so none are lost', async () => {
    const store = new SessionStore(new MemoryStorageArea());
    await store.put(newSessionRecord('sess_0000001', { tabId: 1, origin: 'https://a', title: null }));
    await Promise.all([
      store.update('sess_0000001', (r) => {
        r.status = 'ready';
      }),
      store.update('sess_0000001', (r) => {
        r.documentId = 'D';
      }),
      store.update('sess_0000001', (r) => {
        r.generation = 5;
      }),
    ]);
    const rec = await store.get('sess_0000001');
    expect(rec).toMatchObject({ status: 'ready', documentId: 'D', generation: 5 });
  });

  it('treats corrupt records as absent', async () => {
    const area = new MemoryStorageArea();
    await area.set({ 'session:sess_0000001': { garbage: true } });
    const store = new SessionStore(area);
    expect(await store.get('sess_0000001')).toBeNull();
    expect(area.keys()).toEqual([]);
  });

  it('surfaces quota failures as storageQuota errors', async () => {
    const store = new SessionStore(new MemoryStorageArea(200));
    await expect(store.put(newSessionRecord('sess_0000001', { tabId: 1, origin: 'https://a', title: 'x'.repeat(100) }))).rejects.toMatchObject({ code: 'storageQuota' });
  });
});
