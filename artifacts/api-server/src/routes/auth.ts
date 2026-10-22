import { Router, type IRouter } from 'express';
import { rateLimit } from 'express-rate-limit';
import { eq, sql } from 'drizzle-orm';
import { db, credentialsTable, usersTable, sessionsTable } from '@workspace/db';
import { LoginWithPasswordBody, ChangePasswordBody } from '@workspace/api-zod';
import { clearSession, createSession, deleteSession, getSessionId, setSessionCookie } from '../lib/auth';
import { hashPassword, verifyPassword } from '../lib/password';

const router: IRouter = Router();
const authLimit = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-8',
  legacyHeaders: false, skipSuccessfulRequests: true,
  message: { error: 'Too many attempts. Try again in 15 minutes.' },
});

router.get('/auth/user', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ user: req.isAuthenticated() ? req.user : null });
});

router.post('/auth/login', authLimit, async (req, res) => {
  const parsed = LoginWithPasswordBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Enter a valid email and password.' }); return; }
  const { email, password } = parsed.data;
  const [record] = await db.select({
    user: usersTable, passwordHash: credentialsTable.passwordHash,
  }).from(usersTable).innerJoin(credentialsTable, eq(usersTable.id, credentialsTable.userId))
    .where(sql`lower(${usersTable.email}) = ${email.trim().toLowerCase()}`);
  const valid = await verifyPassword(password, record?.passwordHash);
  if (!record || !valid) { res.status(401).json({ error: 'Email or password is incorrect.' }); return; }
  // Rotate a pre-existing session, and never expose password hashes to clients.
  const previousSid = getSessionId(req);
  if (previousSid) await deleteSession(previousSid);
  const { id, firstName, lastName, profileImageUrl } = record.user;
  const user = { id, email: record.user.email, firstName, lastName, profileImageUrl };
  setSessionCookie(res, await createSession(user));
  res.setHeader('Cache-Control', 'no-store');
  res.json({ user });
});

router.post('/auth/logout', async (req, res) => {
  await clearSession(res, getSessionId(req));
  res.json({ success: true });
});

router.post('/auth/change-password', authLimit, async (req, res) => {
  if (!req.isAuthenticated()) { res.status(401).json({ error: 'Authentication required.' }); return; }
  const parsed = ChangePasswordBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'New passwords must be 12–128 characters.' }); return; }
  const [credential] = await db.select().from(credentialsTable).where(eq(credentialsTable.userId, req.user.id));
  if (!credential || !await verifyPassword(parsed.data.currentPassword, credential.passwordHash)) {
    res.status(401).json({ error: 'Current password is incorrect.' }); return;
  }
  const userId = req.user.id;
  const passwordHash = await hashPassword(parsed.data.newPassword);
  await db.transaction(async tx => {
    await tx.update(credentialsTable).set({ passwordHash, updatedAt: new Date() })
      .where(eq(credentialsTable.userId, userId));
    await tx.delete(sessionsTable).where(sql`${sessionsTable.sess}->'user'->>'id' = ${userId}`);
  });
  await clearSession(res);
  res.json({ success: true });
});

export default router;
