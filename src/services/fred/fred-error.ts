/** @fileoverview Classifies FRED error responses without exposing upstream bodies or URLs. */

import { z } from '@cyanheads/mcp-ts-core';
import { type ErrorData, JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { httpStatusToErrorCode } from '@cyanheads/mcp-ts-core/utils';

type FredDomainReason =
  | 'category_not_found'
  | 'frequency_too_high'
  | 'release_not_found'
  | 'series_not_found';

const entityReasons = new Map<string, FredDomainReason>([
  ['The category does not exist.', 'category_not_found'],
  ['The release does not exist.', 'release_not_found'],
  ['The series does not exist.', 'series_not_found'],
]);

const badRequestEnvelope = z.object({
  error_code: z.literal(400),
  error_message: z.string().min(1),
});

const statusPrefix = 'Bad Request.  ';
const frequencyPrefix = 'Value of frequency is not one of: ';
const frequencyCodes = new Set([
  "'d'",
  "'w'",
  "'bw'",
  "'m'",
  "'q'",
  "'sa'",
  "'a'",
  "'wef'",
  "'weth'",
  "'wew'",
  "'wetu'",
  "'wem'",
  "'wesu'",
  "'wesa'",
  "'bwew'",
  "'bwem'",
]);

/** A recognized FRED rejection that tool handlers can route by reason. */
export class FredDomainError extends McpError {
  readonly reason: FredDomainReason;

  constructor(reason: FredDomainReason, message: string, data: ErrorData = {}) {
    const code =
      reason === 'frequency_too_high'
        ? JsonRpcErrorCode.ValidationError
        : JsonRpcErrorCode.NotFound;
    super(code, message, { ...data, reason });
    this.reason = reason;
  }
}

/** Converts an HTTP error and, for HTTP 400, its parsed FRED diagnostic into a safe error. */
export function fredHttpError(
  response: Response,
  body: string | undefined,
  apiKey: string,
): McpError {
  const { status } = response;
  const data = { status, statusCode: status };
  const fallback = `FRED returned HTTP ${status}.`;
  if (status === 400) {
    const message = body === undefined ? undefined : readBadRequest(body, apiKey);
    if (message) {
      const reason = entityReasons.get(message);
      if (reason) return new FredDomainError(reason, message, data);
      if (
        message.startsWith(frequencyPrefix) &&
        message.endsWith('.') &&
        message
          .slice(frequencyPrefix.length, -1)
          .split(', ')
          .every((code) => frequencyCodes.has(code))
      ) {
        return new FredDomainError('frequency_too_high', message, data);
      }
    }
    return new McpError(JsonRpcErrorCode.ValidationError, message ?? fallback, data);
  }

  const retryAfter = response.headers.get('retry-after');
  const nonTransient = status === 425 || (status >= 500 && ![500, 502, 503, 504].includes(status));
  return new McpError(httpStatusToErrorCode(status) ?? JsonRpcErrorCode.InternalError, fallback, {
    ...data,
    ...(nonTransient && { retryable: false }),
    // Accept only the grammar of delta seconds or an IMF-fixdate.
    ...(retryAfter &&
      !retryAfter.includes(apiKey) &&
      (/^\d+$/.test(retryAfter) ||
        /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(retryAfter)) && {
        retryAfter,
      }),
  });
}

function readBadRequest(body: string, apiKey: string): string | undefined {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch (error) {
    if (error instanceof SyntaxError) return;
    throw error;
  }
  const parsed = badRequestEnvelope.safeParse(json);
  if (!parsed.success) return;

  const raw = parsed.data.error_message;
  const message = raw.startsWith(statusPrefix) ? raw.slice(statusPrefix.length) : raw;
  const lower = message.toLowerCase();
  const encodedKey = new URLSearchParams({ key: apiKey }).toString().slice('key='.length);
  if (
    (apiKey &&
      (lower.includes(apiKey.toLowerCase()) || lower.includes(encodedKey.toLowerCase()))) ||
    lower.includes('api_key') ||
    lower.includes('authorization') ||
    lower.includes('//') ||
    lower.includes('%') ||
    message.includes('\n') ||
    message.includes('\r')
  )
    return;
  return message;
}
