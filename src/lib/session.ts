import { getIronSession } from "iron-session";
import { cookies } from "next/headers";

export interface SessionData {
  isAuthenticated: boolean;
  userId?: string;
  email?: string;
}

export async function getSession() {
  const sessionCookies = await cookies();

  return getIronSession<SessionData>(sessionCookies, {
    password:
      process.env.SESSION_SECRET ||
      "complex_password_at_least_32_characters_long_for_session_security",
    cookieName: "yt_shortsmith_session",
    cookieOptions: {
      secure: process.env.NODE_ENV === "production",
      httpOnly: true,
      sameSite: "lax",
      maxAge: 60 * 60 * 24 * 7,
      path: "/",
    },
  });
}

export async function requireAuth() {
  const session = await getSession();

  if (!session.isAuthenticated) {
    throw new Error("Authentication required");
  }

  return session;
}

export async function getCurrentUserId() {
  const s = await requireAuth();
  if (!s.userId) {
    return "";
  }
  return s.userId;
}
