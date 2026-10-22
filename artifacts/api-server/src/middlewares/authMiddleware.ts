import type { AuthUser } from '@workspace/api-zod';
import type { NextFunction, Request, Response } from 'express';
import { clearSession, getSession, getSessionId } from '../lib/auth';

declare global {
  namespace Express {
    interface User extends AuthUser {}
    interface Request {
      isAuthenticated(): this is AuthedRequest;
      user?: User | undefined;
    }
    interface AuthedRequest { user: User }
  }
}

export async function authMiddleware(req: Request, res: Response, next: NextFunction) {
  req.isAuthenticated = function (this: Request) { return this.user != null; } as Request['isAuthenticated'];
  const sid = getSessionId(req);
  if (sid) {
    const session = await getSession(sid);
    if (session?.user?.id) req.user = session.user;
    else await clearSession(res, sid);
  }
  next();
}
