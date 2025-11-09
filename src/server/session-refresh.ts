import type { RequestAuthContext } from "../auth/request-context";
import { mintSessionCookie } from "../auth/session-cookie";

const SESSION_REFRESH_THRESHOLD_MS = 15 * 60 * 1000;

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
