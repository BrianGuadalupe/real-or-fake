import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Real or Fake?',
  description: 'Real or Fake?',
  metadataBase: new URL('https://camara-o-ia.camperai.chatgpt.site'),
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
