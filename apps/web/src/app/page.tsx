import { GoogleLogin } from '@/components/google-login';

export default function HomePage() {
  return (
    <main>
      <h1>Uneventful</h1>
      <p>Campus event management</p>
      <GoogleLogin />
    </main>
  );
}
