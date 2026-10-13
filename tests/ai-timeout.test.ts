// Tests for the bounded AI request timeout in the conversion worker upstream call.
// KEY SAFETY PROPERTY: an unresponsive AI provider must NEVER hold a conversion
// RUNNING forever. The fetch is wrapped in a bounded AbortController deadline; the
// timeout surfaces as AI_PROVIDER_TIMEOUT (worker retries via queue or marks FAILED).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function dummyRules() {
  return {
    sourceType: 'react-next-zip',
    sourceRule: {},
    targetRule: { fileName: 'ELEMENTOR_SKILL.md', text: '', sha256: 'abc123' },
    systemInstructions: 'ignore',
    versions: [],
  };
}

async function loadCompletion() {
  return (await import('../src/infrastructure/ai/provider.js')).requestConversionCompletion;
}

describe('requestConversionCompletion timeout', () => {
  it('surfaces a network failure as AI_PROVIDER_UNREACHABLE', async () => {
    process.env.AI_PROVIDER = 'groq';
    process.env.AI_API_KEY = 'test-key';
    process.env.AI_MODEL = 'test-model';
    process.env.AI_BASE_URL = 'http://127.0.0.1:1';
    process.env.AI_REQUEST_TIMEOUT_MS = '5000';
    vi.useFakeTimers();
    const requestConversionCompletion = await loadCompletion();
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('ENOTFOUND'))));
    try {
      await expect(requestConversionCompletion({ rules: dummyRules(), designPayload: '{}', task: 'c' })).rejects.toMatchObject({ code: 'AI_PROVIDER_UNREACHABLE' });
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it('surfaces an aborted provider as AI_PROVIDER_TIMEOUT', async () => {
    process.env.AI_PROVIDER = 'groq';
    process.env.AI_API_KEY = 'test-key';
    process.env.AI_MODEL = 'test-model';
    process.env.AI_BASE_URL = 'http://127.0.0.1:1';
    process.env.AI_REQUEST_TIMEOUT_MS = '5000';
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((_u, o) => new Promise((_r, rej) => { if (o && o.signal && o.signal.aborted) return rej(new DOMException('Aborted', 'AbortError')); if (o && o.signal) o.signal.addEventListener('abort', () => rej(new DOMException('Aborted', 'AbortError'))); })));
    try {
      const requestConversionCompletion = await loadCompletion();
      const promise = requestConversionCompletion({ rules: dummyRules(), designPayload: '{}', task: 'c' });
      vi.advanceTimersByTime(6000);
      await expect(promise).rejects.toMatchObject({ code: 'AI_PROVIDER_TIMEOUT' });
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it('does not retry indefinitely when the provider remains unreachable', async () => {
    process.env.AI_PROVIDER = 'groq';
    process.env.AI_API_KEY = 'test-key';
    process.env.AI_MODEL = 'test-model';
    process.env.AI_BASE_URL = 'http://127.0.0.1:1';
    process.env.AI_REQUEST_TIMEOUT_MS = '5000';
    vi.useFakeTimers();
    const fetchMock = vi.fn((_u, o) => new Promise((_r, rej) => { if (o && o.signal && o.signal.aborted) return rej(new DOMException('Aborted', 'AbortError')); if (o && o.signal) o.signal.addEventListener('abort', () => rej(new DOMException('Aborted', 'AbortError'))); }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const requestConversionCompletion = await loadCompletion();
      const promise = requestConversionCompletion({ rules: dummyRules(), designPayload: '{}', task: 'c' });
      vi.advanceTimersByTime(6000);
      await expect(promise).rejects.toMatchObject({ code: 'AI_PROVIDER_TIMEOUT' });
      expect(fetchMock).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});
