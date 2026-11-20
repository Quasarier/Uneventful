export function createCorsOptions(webOrigin: string) {
  return {
    origin: [webOrigin],
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'X-Uneventful-CSRF'],
    maxAge: 600,
  };
}

export const helmetOptions = {
  crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' as const },
};
