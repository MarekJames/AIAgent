import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "YT Shortsmith",
  description: "AI-powered short-form video clip generator",
};

import Providers from "./providers";

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
