import { z } from 'zod';
import { client } from '../client.js';
import { getSessionStatus, SessionExpiredError } from '../session.js';
import { toJson } from './common.js';

/** The session status as JSON; with `check`, after a lightweight live API call. */
export async function sessionStatusReport(check: boolean): Promise<Record<string, unknown>> {
  if (check) {
    try {
      await client.whoami();
    } catch (error) {
      // SessionExpiredError has already updated the status; report anything else alongside it.
      if (!(error instanceof SessionExpiredError)) {
        return { ...getSessionStatus(), checkError: error instanceof Error ? error.message : String(error) };
      }
    }
  }
  return { ...getSessionStatus() };
}

export const sessionTools = {
  get_session_status: {
    description: `Check whether the saved D2L login session still works. Returns state ("valid", "expired" or "unknown"), when it last worked, and what to do if it has expired. Set check=true to test it now with a lightweight API call; otherwise reports what the server last saw. Use when other tools fail with SESSION_EXPIRED, or before a scheduled summary.`,
    schema: {
      check: z.boolean().optional().describe('Make a live API call to verify the session (default: false)'),
    },
    handler: async ({ check }: { check?: boolean }): Promise<string> => toJson(await sessionStatusReport(check ?? false)),
  },
};
