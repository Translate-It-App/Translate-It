import { describe, it, expect, vi, beforeEach } from 'vitest';

const storageListeners = new Set();
const storageManagerMock = {
  get: vi.fn(),
  on: vi.fn((e,cb)=>{ if(e==='change') storageListeners.add(cb); }),
  off: vi.fn((e,cb)=>{ if(e==='change') storageListeners.delete(cb); }),
};
let trackerInstances = [];
vi.mock('@/shared/storage/core/StorageCore.js', () => ({ storageManager: storageManagerMock }));
vi.mock('webextension-polyfill', () => ({ default: { action:{setIcon:vi.fn()}, browserAction:{setIcon:vi.fn()}, runtime:{getURL:vi.fn(()=> 'chrome-extension://a/'), id:'a'} } }));
vi.mock('@/core/memory/ResourceTracker.js', () => ({
  default: class {
    constructor(){ this.cbs=[]; trackerInstances.push(this); }
    addEventListener(t,e,h){ t.on(e,h); this.cbs.push([t,e,h]); }
    destroy(){ for(const [t,e,h] of this.cbs) t.off(e,h); this.cbs=[]; }
  }
}));
vi.mock('@/shared/logging/logger.js', () => ({ getScopedLogger:()=>({debug:vi.fn(),info:vi.fn(),warn:vi.fn(),error:vi.fn()}) }));
vi.mock('@/shared/logging/logConstants.js', () => ({ LOG_COMPONENTS:{CORE:'c'} }));
const isContextErrorMock = vi.fn(()=>false);
const handleContextErrorMock = vi.fn((err,ctx,{fallbackAction})=>{ if(typeof fallbackAction==='function') fallbackAction(); });
vi.mock('@/core/extensionContext.js', () => ({ default:{ isContextError: (...a)=>isContextErrorMock(...a), handleContextError: (...a)=>handleContextErrorMock(...a), safeGetURL:(p)=>'chrome-extension://a/'+p } }));
vi.mock('@/features/translation/providers/ProviderConstants.js', () => ({ ProviderRegistryIds:{ GOOGLE_V2:'google_v2', EDGE:'edge'} }));
vi.mock('@/features/translation/providers/ProviderManifest.js', () => ({ findProviderById:()=>({icon:'x.png'}) }));

describe('ActionbarIconManager A5-10',()=>{
  beforeEach(()=>{
    vi.clearAllMocks();
    storageListeners.clear();
    trackerInstances=[];
    storageManagerMock.get.mockReset().mockResolvedValue({TRANSLATION_API:'google_v2'});
    isContextErrorMock.mockReturnValue(false);
    handleContextErrorMock.mockClear();
    // need fresh module for singleton
    vi.resetModules();
  });
  it('factory failure then retry same singleton one listener', async()=>{
    const { getActionbarIconManager } = await import('./ActionbarIconManager.js');
    storageManagerMock.get.mockRejectedValueOnce(new Error('storage fail'));
    await expect(getActionbarIconManager()).rejects.toThrow();
    // singleton exists but not initialized, no listener
    expect(storageListeners.size).toBe(0);
    storageManagerMock.get.mockResolvedValue({TRANSLATION_API:'google_v2'});
    const mgr = await getActionbarIconManager();
    expect(mgr.isInitialized).toBe(true);
    expect(storageListeners.size).toBe(1);
    const mgr3 = await getActionbarIconManager();
    expect(mgr3).toBe(mgr);
    expect(storageListeners.size).toBe(1);
  });
  it('context-error fallback sets initialized without listener', async()=>{
    isContextErrorMock.mockReturnValue(true);
    const { ActionbarIconManager } = await import('./ActionbarIconManager.js');
    storageManagerMock.get.mockRejectedValueOnce(new Error('context invalidated'));
    const mgr = new ActionbarIconManager();
    await mgr.initialize();
    expect(mgr.isInitialized).toBe(true);
    expect(mgr.currentProvider).toBe('edge');
    expect(storageListeners.size).toBe(0);
    expect(mgr.resourceTracker).toBe(null);
    expect(()=>mgr.destroy()).not.toThrow();
    expect(mgr.resourceTracker).toBe(null);
    expect(mgr.isInitialized).toBe(false);
    expect(()=>mgr.destroy()).not.toThrow();
  });
});
