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

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

const environmentSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']),
    PORT: z.coerce.number().int().min(1).max(65535),
    DATABASE_URL: z.string().url(),
    REDIS_URL: z
      .string()
      .url()
      .refine((value) => {
        const url = new URL(value);
        const databasePathIsValid =
          url.pathname === '' ||
          url.pathname === '/' ||
          (/^\/\d+$/.test(url.pathname) && Number.isSafeInteger(Number(url.pathname.slice(1))));
        return (
          ['redis:', 'rediss:'].includes(url.protocol) &&
          databasePathIsValid &&
          !url.search &&
          !url.hash
        );
      }, 'Must use redis or rediss with an optional numeric database path'),
    RSVP_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(120).default(10),
    CHECKIN_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(500).default(120),
    ANALYTICS_MIN_GROUP_SIZE: z.coerce.number().int().min(2).max(100).default(5),
    ANALYTICS_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(60).default(20),
    ANALYTICS_EXPORTS_PER_HOUR: z.coerce.number().int().min(1).max(10).default(3),
    RECOMMENDATIONS_MIN_SUPPORT: z.coerce.number().int().min(2).max(100).default(5),
    NOTIFICATION_EMAIL_PROVIDER: z.enum(['resend', 'local', 'test']).default('local'),
    NOTIFICATION_EMAIL_API_KEY: z.string().min(1).optional(),
    NOTIFICATION_EMAIL_FROM_ADDRESS: z.string().email().max(320).optional(),
    NOTIFICATION_UNSUBSCRIBE_SECRET: z.string().min(32).optional(),
    WEB_PUSH_VAPID_PUBLIC_KEY: z
      .string()
      .regex(/^[A-Za-z0-9_-]{80,100}$/)
      .optional(),
    WEB_PUSH_VAPID_PRIVATE_KEY: z
      .string()
      .regex(/^[A-Za-z0-9_-]{40,50}$/)
      .optional(),
    WEB_PUSH_VAPID_SUBJECT: z.string().min(1).max(255).optional(),
    NOTIFICATION_PER_USER_PER_HOUR: z.coerce.number().int().min(1).max(100).default(20),
    NOTIFICATION_GLOBAL_PER_DAY: z.coerce.number().int().min(1).max(100_000).default(10_000),
    NOTIFICATION_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(120).default(30),
    NOTIFICATION_UNSUBSCRIBE_RATE_LIMIT_PER_MINUTE: z.coerce
      .number()
      .int()
      .min(1)
      .max(60)
      .default(10),
    ANONYMOUS_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(301).max(10_000).default(1_200),
    GOOGLE_OAUTH_START_RATE_LIMIT_PER_15_MINUTES: z.coerce
      .number()
      .int()
      .min(30)
      .max(10_000)
      .default(1_200),
    GOOGLE_OAUTH_CALLBACK_RATE_LIMIT_PER_15_MINUTES: z.coerce
      .number()
      .int()
      .min(30)
      .max(10_000)
      .default(1_200),
    OBJECT_STORAGE_BUCKET: z
      .string()
      .min(3)
      .max(63)
      .regex(/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/),
    OBJECT_STORAGE_REGION: z.string().min(1).max(64),
    OBJECT_STORAGE_ENDPOINT: z
      .string()
      .url()
      .optional()
      .refine((endpoint) => {
        if (endpoint === undefined) {
          return true;
        }
        const url = new URL(endpoint);
        return (
          ['https:', 'http:'].includes(url.protocol) &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash
        );
      }, 'Must be an HTTP(S) URL without credentials, query, or fragment'),
    GOOGLE_CLIENT_ID: z.string().min(1),
    GOOGLE_CLIENT_SECRET: z.string().min(1),
    GOOGLE_CALLBACK_URL: z
      .string()
      .url()
      .refine((value) => {
        const callback = new URL(value);
        const allowedProtocol =
          callback.protocol === 'https:' ||
          (callback.protocol === 'http:' &&
            ['localhost', '127.0.0.1', '[::1]'].includes(callback.hostname));
        return (
          allowedProtocol &&
          !callback.username &&
          !callback.password &&
          !callback.search &&
          !callback.hash &&
          callback.pathname === '/api/v1/auth/google/callback'
        );
      }, 'Must be the allowlisted Google callback endpoint without query or fragment'),
    UNIVERSITY_EMAIL_DOMAIN: z
      .string()
      .refine(isValidDomain, {
        message: 'Must be a valid DNS domain',
      })
      .transform((domain) => domain.toLowerCase()),
    CAMPUS_TIME_ZONE: z.string().min(1).max(64).refine(isValidTimeZone, {
      message: 'Must be a valid IANA time zone',
    }),
    WEB_ORIGIN: z
      .string()
      .url()
      .refine((origin) => new URL(origin).origin === origin, {
        message: 'Must contain only the web origin, without a path',
      }),
    SESSION_SECRET: z.string().min(32),
    JWT_PRIVATE_KEY_B64: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/),
    JWT_PUBLIC_KEY_B64: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/),
    JWT_KEY_ID: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/),
    JWT_PREVIOUS_KEY_ID: z
      .string()
      .regex(/^[A-Za-z0-9._-]{1,128}$/)
      .optional(),
    JWT_PREVIOUS_PUBLIC_KEY_B64: z
      .string()
      .regex(/^[A-Za-z0-9+/]+={0,2}$/)
      .optional(),
    TICKET_SIGNING_PRIVATE_KEY_B64: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/),
    TICKET_SIGNING_PUBLIC_KEY_B64: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/),
    TICKET_SIGNING_KEY_ID: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/),
    TICKET_SIGNING_PREVIOUS_KEY_ID: z
      .string()
      .regex(/^[A-Za-z0-9._-]{1,128}$/)
      .optional(),
    TICKET_SIGNING_PREVIOUS_PUBLIC_KEY_B64: z
      .string()
      .regex(/^[A-Za-z0-9+/]+={0,2}$/)
      .optional(),
    JWT_ISSUER: z.string().url(),
    JWT_AUDIENCE: z.string().min(1),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90),
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  })
  .superRefine((environment, context) => {
    const hasPreviousKeyId = environment.JWT_PREVIOUS_KEY_ID !== undefined;
    const hasPreviousPublicKey = environment.JWT_PREVIOUS_PUBLIC_KEY_B64 !== undefined;
    if (hasPreviousKeyId !== hasPreviousPublicKey) {
      context.addIssue({
        code: 'custom',
        path: ['JWT_PREVIOUS_KEY_ID'],
        message: 'Previous key ID and public key must be configured together',
      });
    }
    if (environment.JWT_PREVIOUS_KEY_ID === environment.JWT_KEY_ID) {
      context.addIssue({
        code: 'custom',
        path: ['JWT_PREVIOUS_KEY_ID'],
        message: 'Previous and current key IDs must be different',
      });
    }

    const hasPreviousTicketKeyId = environment.TICKET_SIGNING_PREVIOUS_KEY_ID !== undefined;
    const hasPreviousTicketPublicKey =
      environment.TICKET_SIGNING_PREVIOUS_PUBLIC_KEY_B64 !== undefined;
    if (hasPreviousTicketKeyId !== hasPreviousTicketPublicKey) {
      context.addIssue({
        code: 'custom',
        path: ['TICKET_SIGNING_PREVIOUS_KEY_ID'],
        message: 'Previous ticket key ID and public key must be configured together',
      });
    }
    if (environment.TICKET_SIGNING_PREVIOUS_KEY_ID === environment.TICKET_SIGNING_KEY_ID) {
      context.addIssue({
        code: 'custom',
        path: ['TICKET_SIGNING_PREVIOUS_KEY_ID'],
        message: 'Previous and current ticket key IDs must be different',
      });
    }

    const hasVapidPublicKey = environment.WEB_PUSH_VAPID_PUBLIC_KEY !== undefined;
    const hasVapidPrivateKey = environment.WEB_PUSH_VAPID_PRIVATE_KEY !== undefined;
    const hasVapidSubject = environment.WEB_PUSH_VAPID_SUBJECT !== undefined;
    if (hasVapidPublicKey !== hasVapidPrivateKey || hasVapidPublicKey !== hasVapidSubject) {
      context.addIssue({
        code: 'custom',
        path: ['WEB_PUSH_VAPID_PUBLIC_KEY'],
        message: 'VAPID public key, private key, and subject must be configured together',
      });
    }

    if (
      environment.NOTIFICATION_EMAIL_PROVIDER === 'resend' &&
      (!environment.NOTIFICATION_EMAIL_API_KEY || !environment.NOTIFICATION_EMAIL_FROM_ADDRESS)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['NOTIFICATION_EMAIL_API_KEY'],
        message: 'Resend requires an API key and a validated sender address',
      });
    }

    if (environment.NODE_ENV !== 'production') {
      return;
    }

    if (environment.NOTIFICATION_EMAIL_PROVIDER !== 'resend') {
      context.addIssue({
        code: 'custom',
        path: ['NOTIFICATION_EMAIL_PROVIDER'],
        message: 'Production must use a real email provider',
      });
    }
    if (!environment.NOTIFICATION_UNSUBSCRIBE_SECRET) {
      context.addIssue({
        code: 'custom',
        path: ['NOTIFICATION_UNSUBSCRIBE_SECRET'],
        message: 'Production requires a separate unsubscribe signing key',
      });
    }
    if (!hasVapidPublicKey || !hasVapidPrivateKey || !hasVapidSubject) {
      context.addIssue({
        code: 'custom',
        path: ['WEB_PUSH_VAPID_PUBLIC_KEY'],
        message: 'Production requires a complete VAPID key set',
      });
    }
    const vapidSubject = environment.WEB_PUSH_VAPID_SUBJECT;
    const isMailtoSubject =
      vapidSubject?.startsWith('mailto:') &&
      z.string().email().safeParse(vapidSubject.slice('mailto:'.length)).success;
    const parsedVapidUrl = vapidSubject ? z.string().url().safeParse(vapidSubject) : undefined;
    const isHttpsSubject =
      parsedVapidUrl?.success &&
      vapidSubject !== undefined &&
      new URL(vapidSubject).protocol === 'https:';
    if (vapidSubject && !isMailtoSubject && !isHttpsSubject) {
      context.addIssue({
        code: 'custom',
        path: ['WEB_PUSH_VAPID_SUBJECT'],
        message: 'Must be a mailto address or HTTPS URL',
      });
    }

    if (new URL(environment.GOOGLE_CALLBACK_URL).protocol !== 'https:') {
      context.addIssue({
        code: 'custom',
        path: ['GOOGLE_CALLBACK_URL'],
        message: 'Must use HTTPS in production',
      });
    }
    if (new URL(environment.WEB_ORIGIN).protocol !== 'https:') {
      context.addIssue({
        code: 'custom',
        path: ['WEB_ORIGIN'],
        message: 'Must use HTTPS in production',
      });
    }
    if (new URL(environment.JWT_ISSUER).protocol !== 'https:') {
      context.addIssue({
        code: 'custom',
        path: ['JWT_ISSUER'],
        message: 'Must use HTTPS in production',
      });
    }
    if (
      environment.OBJECT_STORAGE_ENDPOINT &&
      new URL(environment.OBJECT_STORAGE_ENDPOINT).protocol !== 'https:'
    ) {
      context.addIssue({
        code: 'custom',
        path: ['OBJECT_STORAGE_ENDPOINT'],
        message: 'Must use HTTPS in production',
      });
    }
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
