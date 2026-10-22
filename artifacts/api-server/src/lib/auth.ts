import { createHash, randomBytes } from 'node:crypto';
import type { AuthUser } from '@workspace/api-zod';
import { db, sessionsTable } from '@workspace/db';
import { eq, sql } from 'drizzle-orm';
import type { Request, Response } from 'express';

export const SESSION_COOKIE = 'sid';
export const SESSION_TTL = 7 * 24 * 60 * 60 * 1000;
export interface SessionData { version: 2; user: AuthUser }
const digest = (sid: string) => createHash('sha256').update(sid).digest('hex');

export async function createSession(user: AuthUser): Promise<string> {
  const sid = randomBytes(32).toString('hex');
  await db.insert(sessionsTable).values({
    sid: digest(sid), sess: { version: 2, user }, expire: new Date(Date.now() + SESSION_TTL),
  });
  return sid;
}

export async function getSession(sid: string): Promise<SessionData | null> {
  if (!/^[a-f0-9]{64}$/.test(sid)) return null;
  const [row] = await db.select().from(sessionsTable).where(eq(sessionsTable.sid, digest(sid)));
  const session = row?.sess as Partial<SessionData> | undefined;
  if (!row || row.expire < new Date() || session?.version !== 2 || !session.user?.id) return null;
  return session as SessionData;
}

export async function deleteSession(sid: string) {
  await db.delete(sessionsTable).where(eq(sessionsTable.sid, digest(sid)));
}

export async function revokeUserSessions(userId: string) {
  await db.delete(sessionsTable).where(sql`${sessionsTable.sess}->'user'->>'id' = ${userId}`);
}

export async function clearSession(res: Response, sid?: string) {
  if (sid) await deleteSession(sid);
  res.clearCookie(SESSION_COOKIE, { path: '/', httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' });
}

export function setSessionCookie(res: Response, sid: string) {
  res.cookie(SESSION_COOKIE, sid, {
    httpOnly: true, secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax', path: '/', maxAge: SESSION_TTL,
  });
}

export function getSessionId(req: Request): string | undefined {
  return typeof req.cookies?.[SESSION_COOKIE] === 'string' ? req.cookies[SESSION_COOKIE] : undefined;
}
