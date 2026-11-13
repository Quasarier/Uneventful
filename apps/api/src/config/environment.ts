import { z } from 'zod';

function isValidDomain(domain: string): boolean {
  const labels = domain.split('.');

  return (
    domain.length <= 253 &&
    labels.length >= 2 &&
    labels.every(
      (label) =>
        label.length <= 63 &&
        /^[a-z0-9-]+$/i.test(label) &&
        !label.startsWith('-') &&
        !label.endsWith('-'),
    )
  );
}

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']),
  PORT: z.coerce.number().int().min(1).max(65535),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  GOOGLE_CALLBACK_URL: z.string().url(),
  UNIVERSITY_EMAIL_DOMAIN: z.string().refine(isValidDomain, {
    message: 'Must be a valid DNS domain',
  }),
  WEB_ORIGIN: z.string().url(),
  SESSION_SECRET: z.string().min(32),
});

export type Environment = z.infer<typeof environmentSchema>;

export function validateEnvironment(config: Record<string, unknown>): Environment {
  const result = environmentSchema.safeParse(config);

  if (!result.success) {
    const invalidKeys = result.error.issues
      .map((issue) => issue.path.join('.'))
      .filter((key, index, keys) => keys.indexOf(key) === index)
      .join(', ');
    throw new Error(`Invalid environment configuration: ${invalidKeys}`);
  }

  return result.data;
}
