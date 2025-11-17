import type { RequestAuthContext } from "../auth/request-context";
import { mintSessionCookie, SESSION_TTL_MS } from "../auth/session-cookie";

const SESSION_REFRESH_LEEWAY_MS = 24 * 60 * 60 * 1000;
// Refresh after the session has aged past the leeway so active users keep rolling a full TTL.
const SESSION_REFRESH_THRESHOLD_MS = SESSION_TTL_MS - SESSION_REFRESH_LEEWAY_MS;

export const maybeRefreshSessionCookie = (response: Response, authContext: RequestAuthContext): Response => {
  const session = authContext.session;
  if (!session || !session.npub) {
    return response;
  }

  if (response.headers.has("set-cookie")) {
    return response;
  }

  const timeRemaining = session.expiresAt - Date.now();
  if (timeRemaining > SESSION_REFRESH_THRESHOLD_MS) {
    return response;
  }

  const { cookie, payload } = mintSessionCookie(session.npub);
  authContext.session = payload;
  authContext.npub = payload.npub;
  response.headers.append("set-cookie", cookie);
  return response;
};
