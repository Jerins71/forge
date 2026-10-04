import { describe, expect, it, vi } from 'vitest';
import { EXA_SEARCH_URL, buildSearchRequest, executeSearch, formatResults, parseArgs, runCli } from '../skills/builtins/exa-search/search.js';

const API_KEY = 'exa-test-key';

describe('exa-search CLI arguments and request contract', () => {
  it('parses the bounded v1 flags and builds the exact nested camelCase request', () => {
    const options = parseArgs([
      'current',
      'WebTransport',
      '-n',
      '8',
      '--type',
      'fast',
      '--text',
      '--include-domain',
      'Example.COM',
      '--include-domain',
      'docs.example.com',
      '--start-published-date',
      '2026-01-01T00:00:00Z',
      '--end-published-date',
      '2026-08-04T23:59:59Z',
    ]);

    expect(options).toEqual({
      query: 'current WebTransport',
      numResults: 8,
      type: 'fast',
      text: true,
      includeDomains: ['example.com', 'docs.example.com'],
      excludeDomains: [],
      startPublishedDate: '2026-01-01T00:00:00Z',
      endPublishedDate: '2026-08-04T23:59:59Z',
    });
    expect(buildSearchRequest(options)).toEqual({
      query: 'current WebTransport',
      type: 'fast',
      numResults: 8,
      moderation: true,
      contents: {
        highlights: { maxCharacters: 1000 },
        text: { maxCharacters: 3000 },
      },
      includeDomains: ['example.com', 'docs.example.com'],
      startPublishedDate: '2026-01-01T00:00:00Z',
      endPublishedDate: '2026-08-04T23:59:59Z',
    });
  });

  it('uses fixed HTTPS POST transport, x-api-key, redirect rejection, timeout, and no retry', async () => {
    const options = parseArgs(['topic']);
    const fetchFn = vi.fn(async () => response({ results: [] }));

    await expect(executeSearch(buildSearchRequest(options), { apiKey: API_KEY, fetchFn })).resolves.toEqual({
      results: [],
      requestId: '',
    });

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledWith(EXA_SEARCH_URL, expect.objectContaining({
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'x-api-key': API_KEY,
      },
      redirect: 'error',
      signal: expect.any(AbortSignal),
    }));
    expect(JSON.parse(String(fetchFn.mock.calls[0][1]?.body))).toEqual({
      query: 'topic',
      type: 'auto',
      numResults: 5,
      moderation: true,
      contents: { highlights: { maxCharacters: 1000 } },
    });
  });
});

describe('exa-search response normalization and output', () => {
  it('strips controls, rejects non-web URLs, enforces field limits, and caps stdout', () => {
    const oversized = 'x'.repeat(5000);
    const output = formatResults({
      query: 'topic\u001b[31m',
      type: 'auto',
      results: Array.from({ length: 10 }, () => ({
        title: `title\u001b[31m${oversized}`,
        url: 'javascript:alert(1)',
        author: oversized,
        highlights: [oversized, oversized, oversized],
        text: `${oversized}\n${oversized}`,
      })),
    }, { includeText: true });

    expect(output).not.toContain('\u001b');
    expect(output).toContain('URL: (missing)');
    expect(output).toContain('[Output truncated by Forge Exa Search]');
    expect(output.length).toBeLessThanOrEqual(24_000);
  });
});

describe('exa-search CLI failures', () => {
  it('redacts the configured key from provider detail', async () => {
    const { stderr, exitCode } = await runWithResponse(response({ detail: `provider echoed ${API_KEY}` }, { status: 400 }));
    expect(exitCode).toBe(1);
    expect(stderr).toContain('[redacted]');
    expect(stderr).not.toContain(API_KEY);
  });
});

function response(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

async function runWithResponse(apiResponse: Response): Promise<{ exitCode: number; stderr: string }> {
  return runWithFetch(async () => apiResponse);
}

async function runWithFetch(fetchFn: typeof fetch): Promise<{ exitCode: number; stderr: string }> {
  const stderr: string[] = [];
  const exitCode = await runCli({
    argv: ['topic'],
    env: { EXA_API_KEY: API_KEY },
    fetchFn,
    stdout: () => {},
    stderr: stderr.push.bind(stderr),
  });
  return { exitCode, stderr: stderr.join('\n') };
}
