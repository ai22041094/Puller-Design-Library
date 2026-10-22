import { eq, count, sql } from 'drizzle-orm';
import { db, pool, usersTable, credentialsTable, sessionsTable } from '@workspace/db';
import { hashPassword } from '../lib/password';

async function main() {
  if (process.argv.includes('--check')) {
    const [row] = await db.select({ value: count() }).from(credentialsTable);
    process.stdout.write(row!.value > 0 ? 'present\n' : 'empty\n');
    return;
  }
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 1024) throw new Error('Input too large.');
  }
  const [rawEmail, password] = input.split('\n');
  const email = rawEmail?.trim().toLowerCase() ?? '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !password) throw new Error('Provide email and password as two stdin lines.');
  const passwordHash = await hashPassword(password);
  await db.transaction(async (tx) => {
    let [user] = await tx.select().from(usersTable).where(sql`lower(${usersTable.email}) = ${email}`);
    if (!user) [user] = await tx.insert(usersTable).values({ email, firstName: email.split('@')[0] }).returning();
    const [existing] = await tx.select().from(credentialsTable).where(eq(credentialsTable.userId, user!.id));
    if (existing && !process.argv.includes('--reset')) throw new Error('Account already exists. Use --reset only to intentionally reset its password.');
    await tx.insert(credentialsTable).values({ userId: user!.id, passwordHash })
      .onConflictDoUpdate({ target: credentialsTable.userId, set: { passwordHash, updatedAt: new Date() } });
    await tx.delete(sessionsTable).where(sql`${sessionsTable.sess}->'user'->>'id' = ${user!.id}`);
  });
  process.stdout.write('Account saved. Existing sessions have been revoked.\n');
}
main().catch(() => {
  process.stderr.write('Account operation failed. Check the input, database, and whether the account already exists (use --reset to reset intentionally).\n');
  process.exitCode = 1;
}).finally(() => pool.end());
