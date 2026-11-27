import { limits } from './wire.js';

const HOUR = 3_600_000;

export class Gate {
  constructor(ctx, env) {
    this.sql = ctx.storage.sql;
    this.limits = limits(env);
    this.sql.exec(
      'CREATE TABLE IF NOT EXISTS opens (opened INTEGER NOT NULL, expires INTEGER NOT NULL)'
    );
  }

  async fetch(request) {
    const { expiresAt } = await request.json();
    const now = Date.now();
    this.sql.exec('DELETE FROM opens WHERE opened <= ? AND expires <= ?', now - HOUR, now);
    const [{ live, hourly }] = this.sql
      .exec(
        'SELECT COUNT(CASE WHEN expires > ? THEN 1 END) AS live, COUNT(CASE WHEN opened > ? THEN 1 END) AS hourly FROM opens',
        now,
        now - HOUR
      )
      .toArray();
    if (live >= this.limits.live || hourly >= this.limits.hourly)
      return Response.json({ admitted: false });
    this.sql.exec('INSERT INTO opens (opened, expires) VALUES (?, ?)', now, expiresAt);
    return Response.json({ admitted: true });
  }
}
