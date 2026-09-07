import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '¿Cámara o IA?',
  description:
    'Diez vídeos. Decide cuáles fueron grabados y cuáles fueron generados con inteligencia artificial.',
  metadataBase: new URL('https://camara-o-ia.camperai.chatgpt.site'),
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
